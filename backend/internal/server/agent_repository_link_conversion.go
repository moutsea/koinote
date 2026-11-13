package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

type SystemRepositoryLinkOptions struct {
	Apply       bool
	GitHubToken string
	WorkspaceID int64
	OnResult    func(SystemRepositoryLinkResult)
}

type SystemRepositoryLinkResult struct {
	WorkspaceID int64  `json:"workspaceId"`
	Repository  string `json:"repository"`
	Status      string `json:"status"`
	Code        string `json:"code,omitempty"`
	Files       int64  `json:"files"`
	Bytes       int64  `json:"bytes"`
}

type SystemRepositoryLinkSummary struct {
	Checked      int   `json:"checked"`
	Converted    int   `json:"converted"`
	WouldConvert int   `json:"wouldConvert"`
	Retained     int   `json:"retained"`
	Failed       int   `json:"failed"`
	Bytes        int64 `json:"bytes"`
}

// Explicit maintenance only. Never remove a mirror on an unavailable/hidden
// source or a failed GitHub check. Object deletion follows the existing backup
// retention policy, including references held by private Skills and Forks.
func (a *App) ConvertPublicSystemRepositoriesToLinks(ctx context.Context, options SystemRepositoryLinkOptions) (SystemRepositoryLinkSummary, error) {
	var summary SystemRepositoryLinkSummary
	if options.WorkspaceID < 0 || strings.TrimSpace(options.GitHubToken) == "" {
		return summary, errors.New("a GitHub token and nonnegative workspace ID are required")
	}
	lock, err := a.db.Begin(ctx)
	if err != nil {
		return summary, err
	}
	defer lock.Rollback(context.WithoutCancel(ctx))
	var acquired bool
	if err = lock.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, agentRepositorySyncLock).Scan(&acquired); err != nil {
		return summary, err
	}
	if !acquired {
		return summary, errAgentRepositorySyncBusy
	}
	rows, err := a.db.Query(ctx, `SELECT id FROM agent_workspaces WHERE is_system AND deleted_at IS NULL AND github_source IS NOT NULL
 AND COALESCE(github_source->>'linkOnly','false')<>'true' AND ($1::bigint=0 OR id=$1) ORDER BY id`, options.WorkspaceID)
	if err != nil {
		return summary, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return summary, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return summary, err
	}
	for _, id := range ids {
		work, cancel := context.WithTimeout(ctx, 2*githubRequestTimeout)
		result, convertErr := a.convertPublicSystemRepositoryToLink(work, id, options)
		cancel()
		summary.Checked++
		if convertErr != nil {
			result.Status, result.Code = "retained", systemRepositorySyncErrorCode(convertErr)
			summary.Failed++
		}
		switch result.Status {
		case "converted":
			summary.Converted++
			summary.Bytes += result.Bytes
		case "would_convert":
			summary.WouldConvert++
			summary.Bytes += result.Bytes
		default:
			summary.Retained++
		}
		if options.OnResult != nil {
			options.OnResult(result)
		}
		if ctx.Err() != nil {
			return summary, ctx.Err()
		}
		if errors.Is(convertErr, errAgentGitHubRateLimited) || errors.Is(convertErr, errAgentGitHubCredentialInvalid) {
			return summary, convertErr
		}
	}
	if summary.Failed > 0 {
		return summary, errors.New("some mirrors were retained because conversion could not be verified")
	}
	return summary, nil
}

func (a *App) convertPublicSystemRepositoryToLink(ctx context.Context, id int64, options SystemRepositoryLinkOptions) (SystemRepositoryLinkResult, error) {
	result := SystemRepositoryLinkResult{WorkspaceID: id, Status: "retained"}
	before, err := a.loadAgentRepositorySyncSnapshot(ctx, a.db, id)
	if err != nil {
		return result, err
	}
	if before.ownerID != nil || before.source == nil || before.source.LinkOnly {
		result.Code = "not_system_mirror"
		return result, nil
	}
	result.Repository = before.source.RepositoryURL
	if err = a.db.QueryRow(ctx, `SELECT count(*),COALESCE(sum(size_bytes),0) FROM agent_workspace_files WHERE workspace_id=$1`, id).Scan(&result.Files, &result.Bytes); err != nil {
		return result, err
	}
	owner, repo, _, err := parseGitHubRepositoryURL(result.Repository)
	if err != nil {
		return result, err
	}
	metadata, err := a.resolveGitHubRepositoryMetadata(ctx, owner, repo, options.GitHubToken, false)
	if errors.Is(err, errAgentGitHubRepositoryMissing) {
		result.Code = "upstream_unavailable"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	switch {
	case metadata.Private:
		result.Code = "upstream_private"
	case metadata.Disabled:
		result.Code = "upstream_disabled"
	case before.source.RepositoryID <= 0 || metadata.ID != before.source.RepositoryID:
		result.Code = "repository_identity_changed"
	case metadata.DefaultBranch == "" || validateGitHubRef(metadata.DefaultBranch) != nil:
		result.Code = "no_default_branch"
	}
	if result.Code != "" {
		return result, nil
	}
	// Public metadata alone is insufficient for an empty/deleted default branch.
	// Resolve its commit, without downloading or retaining any upstream content.
	if _, err = a.resolveGitHubRepositoryCommit(ctx, metadata, "", options.GitHubToken); err != nil {
		return result, err
	}
	source := *before.source
	source.LinkOnly, source.Private, source.UpstreamStatus = true, false, ""
	source.RepositoryURL = "https://github.com/" + metadata.FullName
	source.Author, source.AuthorURL = metadata.Owner.Login, "https://github.com/"+metadata.Owner.Login
	source.Ref = metadata.DefaultBranch
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if err = lockAgentRepositorySyncSnapshot(ctx, tx, before); err != nil {
		return result, err
	}
	// Skill writers take the user lock before a source-row lock. A nonblocking
	// claim avoids inverting that order while this conversion holds the source.
	users, err := tx.Query(ctx, `SELECT DISTINCT user_id FROM koi_skill_installations WHERE source_kind='hub' AND source->>'workspaceId'=$1 AND deleted_at IS NULL ORDER BY user_id`, fmt.Sprint(id))
	if err != nil {
		return result, err
	}
	var userIDs []int
	for users.Next() {
		var user int
		if err = users.Scan(&user); err != nil {
			users.Close()
			return result, err
		}
		userIDs = append(userIDs, user)
	}
	err = users.Err()
	users.Close()
	if err != nil {
		return result, err
	}
	for _, user := range userIDs {
		var claimed bool
		if err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, user).Scan(&claimed); err != nil {
			return result, err
		}
		if !claimed {
			return result, errAgentWorkspaceConflict
		}
	}
	if err = tx.QueryRow(ctx, `SELECT count(*),COALESCE(sum(size_bytes),0) FROM agent_workspace_files WHERE workspace_id=$1`, id).Scan(&result.Files, &result.Bytes); err != nil {
		return result, err
	}
	// Migration changes source identity only. Private versions and task pins are
	// immutable; refuse a conflicting duplicate instead of merging user content.
	collision, err := migrateKoiHubInstallationsToGitHub(ctx, tx, id, &source, metadata.Name, options.Apply)
	if err != nil {
		return result, err
	}
	if collision {
		result.Code = "installed_source_conflict"
		return result, nil
	}
	if !options.Apply {
		result.Status = "would_convert"
		return result, nil
	}
	if _, err = tx.Exec(ctx, `DELETE FROM agent_repository_publication_files WHERE workspace_id=$1`, id); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM agent_workspace_files WHERE workspace_id=$1`, id); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM agent_workspace_commits WHERE workspace_id=$1`, id); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM agent_workspace_blobs WHERE workspace_id=$1`, id); err != nil {
		return result, err
	}
	var revision int64
	if err = tx.QueryRow(ctx, `UPDATE agent_workspaces SET github_source=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision`, id, &source).Scan(&revision); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `SELECT record_agent_workspace_commit($1,'link-conversion',NULL,'Converted public GitHub mirror to a source link')`, id); err != nil {
		return result, err
	}
	// Keep its existing publication time and URL to preserve directory ordering.
	if _, err = tx.Exec(ctx, `UPDATE agent_repository_publications SET revision=$2,github_source=$3,koi_installable=NULL,koi_installability_evidence=NULL,
 koi_installability_checked_at=NULL,koi_installability_attempted_at=NULL,koi_installability_xid=NULL WHERE workspace_id=$1`, id, revision, &source); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_repository_system_events(workspace_id,action,revision) VALUES($1,'import',$2)`, id, revision); err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	result.Status = "converted"
	return result, nil
}

func migrateKoiHubInstallationsToGitHub(ctx context.Context, tx pgx.Tx, workspaceID int64, source *agentGitHubSource, repo string, apply bool) (bool, error) {
	rows, err := tx.Query(ctx, `SELECT id::text,user_id,source FROM koi_skill_installations WHERE source_kind='hub' AND source->>'workspaceId'=$1 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, fmt.Sprint(workspaceID))
	if err != nil {
		return false, err
	}
	type installed struct {
		id     string
		user   int
		source map[string]any
	}
	var skills []installed
	for rows.Next() {
		var item installed
		if err = rows.Scan(&item.id, &item.user, &item.source); err != nil {
			rows.Close()
			return false, err
		}
		skills = append(skills, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	for _, skill := range skills {
		next := map[string]any{"kind": "github", "repositoryId": source.RepositoryID, "repositoryUrl": source.RepositoryURL, "owner": source.Author, "repo": repo, "ref": source.Ref, "commitSha": source.CommitSHA, "path": koiSourceText(skill.source, "path"), "fileEntry": true, "author": source.Author, "authorUrl": source.AuthorURL, "license": koiSourceText(skill.source, "license")}
		key := koiRemoteSourceKey("github", next)
		var collision bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM koi_skill_installations WHERE user_id=$1 AND source_key=$2 AND deleted_at IS NULL)`, skill.user, key).Scan(&collision); err != nil {
			return false, err
		}
		if collision {
			return true, nil
		}
		if apply {
			encoded, _ := json.Marshal(next)
			if _, err = tx.Exec(ctx, `UPDATE koi_skill_installations SET source_kind='github',source_key=$2,source=$3,revision=revision+1,updated_at=now() WHERE id=$1`, skill.id, key, encoded); err != nil {
				return false, err
			}
		}
	}
	return false, nil
}
