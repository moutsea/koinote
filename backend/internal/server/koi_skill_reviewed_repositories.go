package server

import (
	"context"
	"encoding/json"
	"path"
	"slices"
	"strconv"
	"strings"
)

// Repository-specific curation lives in the database. Each operation reads one
// snapshot so previews, confirmation and task selection use the same policies.
type koiReviewedRepository struct {
	RepositoryID         int64               `json:"repositoryId"`
	RepositoryURL        string              `json:"repositoryUrl"`
	Category             string              `json:"category"`
	Packages             map[string]string   `json:"packages"`
	RequiredCapabilities map[string][]string `json:"requiredCapabilities"`
}

type koiRepositoryCuration struct {
	revision     int64
	repositories map[int64]koiReviewedRepository
	requirements map[string]koiSkillCompatibility
	categories   map[string]string
	policiesJSON []byte
}

func loadKoiRepositoryCuration(ctx context.Context, q imageUsageQuerier) (koiRepositoryCuration, error) {
	var entries []koiReviewedRepository
	var revision int64
	err := q.QueryRow(ctx, `SELECT s.revision,COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'repositoryId',repository_id,'repositoryUrl',repository_url,'category',category,
 'packages',packages,'requiredCapabilities',required_capabilities))
 FROM agent_repository_curation), '[]'::jsonb)
 FROM agent_repository_curation_state s WHERE s.singleton`).Scan(&revision, &entries)
	if err != nil {
		return koiRepositoryCuration{}, err
	}
	review := koiRepositoryCurationFrom(entries)
	review.revision = revision
	return review, nil
}

func koiRepositoryCurationFrom(entries []koiReviewedRepository) koiRepositoryCuration {
	review := koiRepositoryCuration{
		repositories: map[int64]koiReviewedRepository{},
		requirements: map[string]koiSkillCompatibility{},
		categories:   map[string]string{},
	}
	capabilities := map[string][]string{}
	repositories := map[string]map[string]string{}
	for _, entry := range entries {
		if entry.Category != "" {
			review.categories[strings.ToLower(entry.RepositoryURL)] = entry.Category
		}
		// NULL means no package review; an empty object explicitly rejects all.
		if entry.Packages == nil {
			continue
		}
		review.repositories[entry.RepositoryID] = entry
		repositories[strconv.FormatInt(entry.RepositoryID, 10)] = entry.Packages
		for digest, required := range entry.RequiredCapabilities {
			capabilities[digest] = append(capabilities[digest], required...)
		}
	}
	for digest, required := range capabilities {
		slices.Sort(required)
		review.requirements[digest] = koiSkillCompatibilityFor(map[string]any{"capabilities": strings.Join(slices.Compact(required), " ")})
	}
	review.policiesJSON, _ = json.Marshal(map[string]any{"repositories": repositories, "requirements": review.requirements})
	return review
}

func (review koiRepositoryCuration) contentCompatibility(digest string, compatibility koiSkillCompatibility, entryDigests ...string) koiSkillCompatibility {
	for _, digest := range append([]string{digest}, entryDigests...) {
		required, ok := review.requirements[digest]
		if !ok {
			continue
		}
		compatibility.Conversation = compatibility.Conversation && required.Conversation
		compatibility.Article = compatibility.Article && required.Article
		merge := func(current, extra []string) []string {
			result := slices.Clone(current)
			for _, value := range extra {
				if !slices.Contains(result, value) {
					result = append(result, value)
				}
			}
			return result
		}
		compatibility.Reasons = merge(compatibility.Reasons, required.Reasons)
		compatibility.Warnings = merge(compatibility.Warnings, required.Warnings)
	}
	return compatibility
}

// Apply review changes to the current library and new tasks, without rewriting
// the compatibility stored on immutable versions pinned by running tasks.
func (review koiRepositoryCuration) compatibility(repositoryID string, digest string, compatibility koiSkillCompatibility, entryDigests ...string) koiSkillCompatibility {
	compatibility = review.contentCompatibility(digest, compatibility, entryDigests...)
	id, _ := strconv.ParseInt(repositoryID, 10, 64)
	if policy, reviewed := review.repositories[id]; reviewed {
		if _, approved := policy.Packages[digest]; !approved {
			compatibility.Conversation, compatibility.Article = false, false
			compatibility.Reasons = append(append([]string{}, compatibility.Reasons...), "review_not_approved")
		}
	}
	return compatibility
}

// Older Hub and migration installations did not save the upstream repository ID.
// Resolve it from their source; new imports retain the identity in the snapshot.
const koiInstallationReviewRepositoryID = `CASE WHEN i.source_kind IN ('github','hub','migration') THEN
 COALESCE(NULLIF(i.source->>'repositoryId',''),
   CASE WHEN i.source_kind='hub' THEN (SELECT p.github_source->>'repositoryId'
     FROM agent_repository_publications p WHERE p.workspace_id::text=i.source->>'workspaceId')
   WHEN i.source_kind='migration' THEN (SELECT w.github_source->>'repositoryId'
     FROM agent_workspaces w WHERE w.id::text=i.source->>'workspaceId' AND w.user_id=i.user_id) END, '')
 ELSE '' END`

// Same single-entry digest as koiSkillEntryDigest, using the verified stored
// file hash without loading private file bytes from object storage.
const koiSkillEntryDigestSQL = `COALESCE((SELECT encode(sha256(convert_to('SKILL.md','UTF8')||decode('00','hex')||convert_to(f.sha256,'UTF8')||decode('0a','hex')),'hex')
 FROM koi_skill_version_files f WHERE f.version_id=v.id AND f.path=v.entry_path),'')`

func koiInstallationReviewAllowsSQL(parameter, article string) string {
	repositories := `(` + parameter + `::jsonb -> 'repositories')`
	allows := func(digest string) string {
		requirements := `(` + parameter + `::jsonb -> 'requirements' -> (` + digest + `))`
		return `(COALESCE((` + requirements + ` ->> 'conversation')::boolean,true)
 AND (NOT (` + article + `) OR COALESCE((` + requirements + ` ->> 'article')::boolean,true)))`
	}
	return `((NOT (` + repositories + ` ? (` + koiInstallationReviewRepositoryID + `))
 OR (` + repositories + ` -> (` + koiInstallationReviewRepositoryID + `)) ? v.content_sha256)
 AND ` + allows("v.content_sha256") + ` AND ` + allows(koiSkillEntryDigestSQL) + `)`
}

func (review koiRepositoryCuration) candidates(repositoryID int64, candidates []koiSkillCandidate) ([]koiSkillCandidate, []koiSkillRejected) {
	policy, ok := review.repositories[repositoryID]
	if !ok {
		return candidates, nil
	}
	accepted := []koiSkillCandidate{}
	rejected := []koiSkillRejected{}
	for _, candidate := range candidates {
		if _, ok := policy.Packages[candidate.ContentSHA256]; ok {
			accepted = append(accepted, candidate)
		} else {
			rejected = append(rejected, koiSkillRejected{Directory: candidate.Directory, EntryPath: path.Join(candidate.Directory, candidate.EntryPath), Name: candidate.Name, Reason: "not_reviewed"})
		}
	}
	return accepted, rejected
}
