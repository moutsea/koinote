package server

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

// A migrated workspace is one origin, independent of other private workspaces.
// Unknown origins and folder imports keep their installation identity. Quota
// accounting uses the same grouping for retained task versions.
const koiInstallationOriginSQL = `CASE
 WHEN i.source_kind='github' AND i.source->>'repositoryId' ~ '^[1-9][0-9]*$' THEN i.source->>'repositoryId'
 WHEN i.source_kind IN ('hub','migration') AND i.source->>'workspaceId' ~ '^[1-9][0-9]*$' THEN i.source->>'workspaceId'
 ELSE i.id::text END`

// A migration spans multiple workspaces; only copies within one workspace share
// a key. Use this for both preview grouping and confirmation of older previews.
func koiCandidateGroupKey(kind string, source map[string]any, candidate koiSkillCandidate) string {
	if kind == "migration" {
		id := koiSourceID(koiCandidateSource(source, candidate), "workspaceId")
		if id <= 0 {
			return candidate.ID + ":" + candidate.Directory + ":" + candidate.ContentSHA256
		}
		return strconv.FormatInt(id, 10) + ":" + candidate.ContentSHA256
	}
	return candidate.ContentSHA256
}

func koiCandidateGroups(kind string, source map[string]any, candidates []koiSkillCandidate) [][]koiSkillCandidate {
	groups := [][]koiSkillCandidate{}
	byDigest := map[string]int{}
	for _, candidate := range candidates {
		key := koiCandidateGroupKey(kind, source, candidate)
		if index, ok := byDigest[key]; ok {
			groups[index] = append(groups[index], candidate)
		} else {
			byDigest[key] = len(groups)
			groups = append(groups, []koiSkillCandidate{candidate})
		}
	}
	for _, group := range groups {
		sort.SliceStable(group, func(i, j int) bool {
			// Prefer the common skills/ tree to copies under client adapters.
			left, right := strings.HasPrefix(group[i].Directory, "skills/"), strings.HasPrefix(group[j].Directory, "skills/")
			if left != right {
				return left
			}
			if left, right := strings.Count(group[i].Directory, "/"), strings.Count(group[j].Directory, "/"); left != right {
				return left < right
			}
			return group[i].Directory < group[j].Directory
		})
	}
	return groups
}

// Match known adapter paths first, then identical current content in this one
// repository. Historical versions and copies from other repositories never
// count as installed. The confirmation caller repeats this under the user lock.
func koiRemoteInstallationMatch(ctx context.Context, q agentWorkspaceQuerier, userID int, kind string, source map[string]any, candidates []koiSkillCandidate) (id, key string, err error) {
	keys := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		keys = append(keys, koiRemoteSourceKey(kind, koiCandidateSource(source, candidate)))
	}
	origin := "repositoryId"
	if kind == "hub" || kind == "migration" {
		origin = "workspaceId"
	}
	err = q.QueryRow(ctx, `SELECT i.id::text,i.source_key FROM koi_skill_installations i
 JOIN koi_skill_versions v ON v.id=i.current_version_id
 WHERE i.user_id=$1 AND i.source_kind=$2 AND i.deleted_at IS NULL
 AND (i.source_key=ANY($3::text[]) OR (i.source->>$4=$5 AND v.content_sha256=$6))
 ORDER BY (i.source_key=ANY($3::text[])) DESC,i.created_at,i.id LIMIT 1`,
		userID, kind, keys, origin, strconv.FormatInt(koiSourceID(koiCandidateSource(source, candidates[0]), origin), 10), candidates[0].ContentSHA256).Scan(&id, &key)
	return
}
