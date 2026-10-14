package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	agentRepositoryDiscoveryLock             int64 = 0x4147454e54444953
	agentRepositoryDiscoveryDailyLimit             = 20
	agentRepositoryDiscoveryMinStars               = 100
	agentRepositoryDiscoveryPreviewMaxChecks       = 100
)

var errAgentRepositoryDiscoveryStopped = errors.New("daily discovery budget reached or calendar day changed")

type SystemRepositoryDiscoveryOptions struct {
	Apply       bool
	GitHubToken string
	OnResult    func(SystemRepositoryDiscoveryResult)
}

type SystemRepositoryDiscoveryResult struct {
	Repository  string `json:"repository"`
	Stars       int    `json:"stars"`
	WorkspaceID int64  `json:"workspaceId,omitempty"`
	Status      string `json:"status"`
	Code        string `json:"code,omitempty"`
}

type SystemRepositoryDiscoverySummary struct {
	Day          string `json:"day"`
	AlreadyAdded int    `json:"alreadyAdded"`
	Candidates   int    `json:"candidates"`
	Checked      int    `json:"checked"`
	Added        int    `json:"added"`
	WouldAdd     int    `json:"wouldAdd"`
	Skipped      int    `json:"skipped"`
	Failed       int    `json:"failed"`
	Remaining    int    `json:"remaining"`
	Outcome      string `json:"outcome"`
}

// Discovery is a maintenance command with no administrator or personal quota.
// The ledger, files and publication commit together, so a retry only fills the
// remaining daily allowance. An interrupted import can never leave half a repo.
func (a *App) DiscoverSystemAgentRepositories(ctx context.Context, options SystemRepositoryDiscoveryOptions) (SystemRepositoryDiscoverySummary, error) {
	var summary SystemRepositoryDiscoverySummary
	if strings.TrimSpace(options.GitHubToken) == "" {
		return summary, errors.New("a GitHub token is required")
	}
	lock, err := a.db.Begin(ctx)
	if err != nil {
		return summary, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = lock.Rollback(cleanup)
	}()
	var acquired bool
	if err = lock.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, agentRepositoryDiscoveryLock).Scan(&acquired); err != nil {
		return summary, err
	}
	if !acquired {
		return summary, errors.New("a discovery job is already running")
	}
	summary.Day, summary.AlreadyAdded, err = systemRepositoryDiscoveryBudget(ctx, a.db)
	if err != nil {
		return summary, err
	}
	summary.Remaining = max(0, agentRepositoryDiscoveryDailyLimit-summary.AlreadyAdded)
	if summary.Remaining == 0 {
		summary.Outcome = "daily_target_reached"
		return summary, nil
	}
	if _, err = checkAgentRepositoryImportCapacity(ctx, a.db, nil); err != nil {
		summary.Outcome = "catalog_capacity_reached"
		return summary, err
	}
	candidates, err := a.searchSystemRepositoryCandidates(ctx, options.GitHubToken)
	if err != nil {
		return summary, err
	}
	summary.Candidates = len(candidates)
	for _, candidate := range candidates {
		// Preview stays bounded and read-only. Apply continues beyond the first
		// 100 candidates until the daily target, candidate exhaustion or the CLI
		// deadline. Accepted/rejected IDs are durable, so a later scheduled run
		// resumes with unprocessed candidates after an interruption.
		if summary.Remaining == 0 || (!options.Apply && summary.Checked >= agentRepositoryDiscoveryPreviewMaxChecks) {
			break
		}
		if _, err = lock.Exec(ctx, `SELECT 1`); err != nil {
			return summary, err
		}
		known, err := systemRepositoryDiscoveryKnown(ctx, a.db, candidate.ID, "https://github.com/"+candidate.FullName)
		if err != nil {
			return summary, err
		}
		if known {
			summary.Skipped++
			continue
		}
		summary.Checked++
		jobCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		result, discoverErr := a.discoverSystemRepository(jobCtx, candidate, summary.Day, options)
		cancel()
		if discoverErr != nil {
			result.Status, result.Code = "failed", systemRepositorySyncErrorCode(discoverErr)
			if errors.Is(discoverErr, errAgentWorkspaceLimit) {
				result.Code = "catalog_capacity_reached"
			}
			if errors.Is(discoverErr, errAgentRepositoryDiscoveryStopped) {
				result.Code = "daily_budget_or_day_changed"
			}
			summary.Failed++
		} else {
			switch result.Status {
			case "added":
				summary.Added++
				summary.Remaining--
			case "would_add":
				summary.WouldAdd++
				summary.Remaining--
			case "skipped":
				summary.Skipped++
			}
		}
		if options.OnResult != nil {
			options.OnResult(result)
		}
		if ctx.Err() != nil {
			return summary, ctx.Err()
		}
		if errors.Is(discoverErr, errAgentGitHubRateLimited) || errors.Is(discoverErr, errAgentGitHubCredentialRequired) || errors.Is(discoverErr, errAgentRepositoryDiscoveryStopped) || errors.Is(discoverErr, errAgentWorkspaceLimit) {
			summary.Outcome = result.Code
			return summary, discoverErr
		}
	}
	summary.Outcome = "insufficient_eligible_candidates"
	if summary.Remaining == 0 {
		summary.Outcome = "daily_target_reached"
	} else if !options.Apply && summary.Checked >= agentRepositoryDiscoveryPreviewMaxChecks {
		summary.Outcome = "candidate_check_budget_reached"
	}
	if summary.Failed > 0 {
		return summary, errors.New("some candidates could not be processed; see results")
	}
	return summary, nil
}

func systemRepositoryDiscoveryBudget(ctx context.Context, q imageUsageQuerier) (string, int, error) {
	var day string
	var count int
	err := q.QueryRow(ctx, `WITH d AS (SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date AS day)
 SELECT d.day::text,(SELECT count(*) FROM agent_repository_discoveries WHERE accepted_on=d.day) FROM d`).Scan(&day, &count)
	return day, count, err
}

func systemRepositoryDiscoveryKnown(ctx context.Context, q imageUsageQuerier, id int64, repositoryURL string) (bool, error) {
	var known bool
	// Include withdrawn and soft-deleted system rows. Never revive an admin's
	// removal. IDs handle renames for new imports; URL matching covers old seeds.
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_repository_discoveries
 WHERE github_id=$1 AND (accepted_on IS NOT NULL OR retry_after>now())) OR EXISTS(
 SELECT 1 FROM agent_workspaces WHERE is_system AND
 (lower(github_source->>'repositoryUrl')=lower($2) OR github_source->>'repositoryId'=$1::bigint::text))`, id, repositoryURL).Scan(&known)
	return known, err
}

func (a *App) searchSystemRepositoryCandidates(ctx context.Context, token string) ([]githubRepositoryMetadata, error) {
	// Merge several searches before ranking; a topic query must not preempt a
	// more popular candidate from another query. 12 requests fit Search's quota.
	queries := []string{"skills in:name,description", "topic:agent-skills", "topic:claude-skills", "topic:skills"}
	byID := map[int64]githubRepositoryMetadata{}
	for _, query := range queries {
		for page := 1; page <= 3; page++ {
			values := url.Values{"q": {fmt.Sprintf("%s stars:>=%d fork:false archived:false is:public", query, agentRepositoryDiscoveryMinStars)}, "sort": {"stars"}, "order": {"desc"}, "per_page": {"100"}, "page": {strconv.Itoa(page)}}
			data, err := a.githubRead(ctx, githubAPIBaseURL+"/search/repositories?"+values.Encode(), token, "application/vnd.github+json")
			if err != nil {
				return nil, err
			}
			var response struct {
				Items      []githubRepositoryMetadata `json:"items"`
				Incomplete bool                       `json:"incomplete_results"`
			}
			if json.Unmarshal(data, &response) != nil || response.Incomplete || response.Items == nil {
				return nil, errors.New("GitHub search returned incomplete results; retry later")
			}
			for _, item := range response.Items {
				if item.ID > 0 && item.Stars >= agentRepositoryDiscoveryMinStars && !item.Private && !item.Fork && !item.Archived && !item.Disabled {
					byID[item.ID] = item
				}
			}
			if len(response.Items) < 100 {
				break
			}
		}
	}
	items := make([]githubRepositoryMetadata, 0, len(byID))
	for _, item := range byID {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Stars != items[j].Stars {
			return items[i].Stars > items[j].Stars
		}
		return items[i].ID < items[j].ID
	})
	return items, nil
}

// Prior manual reviews found restrictions not represented by GitHub's root
// SPDX label. Do not silently override those decisions in an automated job.
func discoveryManualLicenseReview(fullName string) bool {
	switch strings.ToLower(fullName) {
	case "anthropics/skills", "adithya-s-k/manim_skill", "jtydhr88/screenwriting-skills",
		"master-cai/research-paper-writing-skills", "elementalsouls/claude-bughunter",
		"xstongxue/best-skills", "kaankiziltug/logo-design-skill", "refoundai/lenny-skills":
		return true
	}
	return false
}

func discoveryLicenseText(content []byte) string {
	text := strings.ToLower(string(content))
	if strings.Contains(text, "permission is hereby granted, free of charge") && strings.Contains(text, "the software is provided \"as is\"") {
		return "MIT"
	}
	if strings.Contains(text, "apache license") && strings.Contains(text, "version 2.0, january 2004") && strings.Contains(text, "limitations under the license") {
		return "Apache-2.0"
	}
	return ""
}

func validateDiscoveredSkills(files []agentWorkspaceFile, repositoryID int64, license string) string {
	hasSkill := false
	for _, file := range files {
		base := strings.ToLower(path.Base(file.Path))
		if agentRepositorySensitivePath(file.Path) || agentWorkspaceSensitiveContent([]byte(file.Path)) {
			return "sensitive_path"
		}
		if base == "skill.md" && len(bytes.TrimSpace(file.Content)) > 0 {
			hasSkill = true
		}
	}
	if !hasSkill {
		return "no_skills"
	}
	if !systemRepositoryLicenseFilesAllowed(files, repositoryID, license) {
		return "license_review_required"
	}
	return ""
}

// Both first-time discovery and later automatic updates use this conservative
// license boundary. Other licenses/complex exceptions require a manual review.
// Existing Agent repositories need not contain SKILL.md to be refreshed.
func systemRepositoryLicenseFilesAllowed(files []agentWorkspaceFile, repositoryID int64, license string) bool {
	if license != "MIT" && license != "Apache-2.0" {
		return false
	}
	hasLicense := false
	for _, file := range files {
		base := strings.ToLower(path.Base(file.Path))
		if strings.HasPrefix(base, "license") || strings.HasPrefix(base, "licence") || strings.HasPrefix(base, "copying") || strings.HasPrefix(base, "notice") {
			text := strings.ToLower(string(file.Content))
			for _, restriction := range []string{"non-commercial", "noncommercial", "cc-by-nc", "not covered by", "not licensed under", "all rights reserved. no", "proprietary"} {
				if strings.Contains(text, restriction) {
					return false
				}
			}
			if strings.HasPrefix(base, "notice") {
				continue
			}
			fileLicense := discoveryLicenseText(file.Content)
			if fileLicense == "" {
				if reviewedSystemRepositoryLicenseFile(file, repositoryID, license) {
					// A reviewed supplement never substitutes for the root license.
					continue
				}
				return false
			}
			if !strings.Contains(file.Path, "/") && fileLicense == license {
				hasLicense = true
			}
		}
	}
	return hasLicense
}

func (a *App) discoverSystemRepository(ctx context.Context, candidate githubRepositoryMetadata, day string, options SystemRepositoryDiscoveryOptions) (SystemRepositoryDiscoveryResult, error) {
	result := SystemRepositoryDiscoveryResult{Repository: "https://github.com/" + candidate.FullName, Stars: candidate.Stars}
	// Policy exclusions are cached for seven days so the same high-star rejects
	// cannot consume the entire download budget every morning. Preview is read-only.
	skip := func(code string) (SystemRepositoryDiscoveryResult, error) {
		result.Status, result.Code = "skipped", code
		if !options.Apply {
			return result, nil
		}
		_, err := a.db.Exec(ctx, `INSERT INTO agent_repository_discoveries(github_id,repository_url,github_stars,code,retry_after)
 VALUES($1,$2,$3,$4,now()+interval '7 days') ON CONFLICT(github_id) DO UPDATE
 SET repository_url=EXCLUDED.repository_url,github_stars=EXCLUDED.github_stars,code=EXCLUDED.code,checked_at=now(),retry_after=EXCLUDED.retry_after
 WHERE agent_repository_discoveries.accepted_on IS NULL`, candidate.ID, result.Repository, result.Stars, code)
		return result, err
	}
	if discoveryManualLicenseReview(candidate.FullName) {
		return skip("license_review_required")
	}
	owner, repo, _, err := parseGitHubRepositoryURL(result.Repository)
	if err != nil {
		return skip("invalid_source")
	}
	metadata, source, err := a.resolveGitHubRepository(ctx, owner, repo, "", options.GitHubToken, true)
	if errors.Is(err, errAgentGitHubRepositoryInvalid) {
		return skip("invalid_or_private_source")
	}
	if err != nil {
		return result, err
	}
	// Recheck live metadata: search indexing can lag a transfer or privacy change.
	if metadata.ID != candidate.ID || metadata.Fork || metadata.Archived || metadata.Disabled || metadata.Stars < agentRepositoryDiscoveryMinStars {
		return skip("ineligible_source")
	}
	result.Repository, result.Stars = source.RepositoryURL, metadata.Stars
	if discoveryManualLicenseReview(metadata.FullName) || (source.License != "MIT" && source.License != "Apache-2.0") {
		return skip("license_review_required")
	}
	known, err := systemRepositoryDiscoveryKnown(ctx, a.db, metadata.ID, source.RepositoryURL)
	if err != nil {
		return result, err
	}
	if known {
		result.Status, result.Code = "skipped", "already_collected"
		return result, nil
	}
	name := string([]rune(metadata.Name)[:min(80, len([]rune(metadata.Name)))])
	description := string([]rune(metadata.Description)[:min(500, len([]rune(metadata.Description)))])
	name, description, err = validateAgentWorkspaceMetadata(name, description)
	if err != nil || agentWorkspaceSensitiveContent([]byte(name+"\n"+description)) {
		return skip("invalid_metadata")
	}
	files, err := a.downloadGitHubRepository(ctx, metadata.Owner.Login, metadata.Name, source.CommitSHA, options.GitHubToken)
	var sensitive *agentWorkspaceSensitiveError
	if errors.As(err, &sensitive) || errors.Is(err, errAgentGitHubArchiveInvalid) {
		return skip(systemRepositorySyncErrorCode(err))
	}
	if err != nil {
		return result, err
	}
	if code := validateDiscoveredSkills(files, source.RepositoryID, source.License); code != "" {
		return skip(code)
	}
	if !options.Apply {
		result.Status = "would_add"
		return result, nil
	}
	result.WorkspaceID, err = a.publishDiscoveredSystemRepository(ctx, day, metadata.Stars, name, description, source, files)
	if err != nil {
		return result, err
	}
	if result.WorkspaceID == 0 {
		result.Status, result.Code = "skipped", "already_collected"
	} else {
		result.Status = "added"
	}
	return result, nil
}

func (a *App) publishDiscoveredSystemRepository(ctx context.Context, day string, stars int, name, description string, source *agentGitHubSource, files []agentWorkspaceFile) (int64, error) {
	staged, err := a.stageAgentRepositoryFilesForOwner(ctx, nil, files)
	if err != nil {
		return 0, err
	}
	defer a.expireAgentRepositoryStaging(ctx, staged)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, agentRepositoryOwnerLock(nil)); err != nil {
		return 0, err
	}
	known, err := systemRepositoryDiscoveryKnown(ctx, tx, source.RepositoryID, source.RepositoryURL)
	if err != nil || known {
		return 0, err
	}
	currentDay, count, err := systemRepositoryDiscoveryBudget(ctx, tx)
	if err != nil {
		return 0, err
	}
	if currentDay != day || count >= agentRepositoryDiscoveryDailyLimit {
		return 0, errAgentRepositoryDiscoveryStopped
	}
	if _, err = checkAgentRepositoryImportCapacity(ctx, tx, nil); err != nil {
		return 0, err
	}
	var id, revision int64
	err = tx.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,is_system,name,description,github_source,hub_category)
 VALUES(NULL,true,$1,$2,$3,'agents') RETURNING id,revision`, name, description, source).Scan(&id, &revision)
	if err != nil {
		return 0, err
	}
	scans := agentRepositoryContentScans{policy: agentWorkspaceSensitivePolicyID()}
	for _, file := range files {
		if err = insertAgentRepositoryFile(ctx, tx, id, file, staged); err != nil {
			return 0, err
		}
		scans.hashes = append(scans.hashes, file.SHA256)
		scans.sensitive = append(scans.sensitive, false)
	}
	if _, err = tx.Exec(ctx, `SELECT record_agent_workspace_commit($1,'import',NULL,$2)`, id, "Discovered from GitHub: "+source.RepositoryURL+" @ "+source.CommitSHA); err != nil {
		return 0, err
	}
	if err = scans.save(ctx, tx, id); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,github_source)
 VALUES($1,$2,$3,$4,$5,(SELECT github_source-'private' FROM agent_workspaces WHERE id=$1))`, id, revision, name, description, source.License); err != nil {
		return 0, err
	}
	if err = replaceAgentRepositoryPublicationFiles(ctx, tx, id); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_repository_discoveries(github_id,repository_url,github_stars,code,accepted_on,workspace_id)
 VALUES($1,$2,$3,'added',$4::date,$5) ON CONFLICT(github_id) DO UPDATE
 SET repository_url=EXCLUDED.repository_url,github_stars=EXCLUDED.github_stars,code='added',checked_at=now(),retry_after=NULL,accepted_on=EXCLUDED.accepted_on,workspace_id=EXCLUDED.workspace_id`, source.RepositoryID, source.RepositoryURL, stars, day, id); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_repository_system_events(workspace_id,actor_user_id,action,revision)
 VALUES($1,NULL,'import',$2),($1,NULL,'publish',$2)`, id, revision); err != nil {
		return 0, err
	}
	return id, tx.Commit(ctx)
}
