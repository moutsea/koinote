package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"koinote/backend/internal/httpx"
)

func agentRepositoryCategoryAllowed(category string) bool {
	switch category {
	case "design", "development", "agents", "writing", "product", "research", "media", "other":
		return true
	}
	return false
}

type agentRepositoryDirectoryItem struct {
	agentWorkspaceSummary
	agentRepositoryEngagement
	SystemManaged  bool               `json:"systemManaged"`
	Category       string             `json:"category"`
	License        string             `json:"license"`
	GitHubSource   *agentGitHubSource `json:"githubSource,omitempty"`
	KoiInstallable bool               `json:"koiInstallable"`
	koiPriority    bool
}

type agentRepositoryDirectoryFacet struct {
	SystemManaged bool   `json:"systemManaged"`
	Category      string `json:"category"`
	Count         int    `json:"count"`
}

// Counts and filters cover the entire public directory, never just the loaded page.
// Only published metadata is searchable; private edits and withdrawn rows stay hidden.
func (a *App) publicAgentRepositoriesList(w http.ResponseWriter, r *http.Request) {
	if !a.allowPublicRepositoryRead(w, r) {
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	category, source := r.URL.Query().Get("category"), r.URL.Query().Get("source")
	if utf8.RuneCountInString(query) > 80 || (category != "" && !agentRepositoryCategoryAllowed(category)) || (source != "" && source != "system" && source != "community") {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid directory search or filter")
		return
	}
	var cursor struct {
		PublishedAt    time.Time `json:"publishedAt"`
		ID             int64     `json:"id"`
		Scope          *string   `json:"scope,omitempty"`
		KoiInstallable *bool     `json:"koiInstallable,omitempty"`
		KoiSnapshot    *string   `json:"koiSnapshot,omitempty"`
	}
	scope := source + "\n" + category + "\n" + query
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		if len(raw) > 1200 {
			httpx.ErrorCode(w, 400, "bad_request", "Invalid cursor")
			return
		}
		decoded, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(decoded, &cursor) != nil || cursor.PublishedAt.IsZero() || cursor.ID <= 0 || (cursor.Scope != nil && *cursor.Scope != scope) || (cursor.KoiInstallable == nil) != (cursor.KoiSnapshot == nil) {
			httpx.ErrorCode(w, 400, "bad_request", "Invalid cursor")
			return
		}
	}
	// Let a pre-upgrade cursor finish in its original time order. Fresh pages and
	// all their cursors use the same compatibility/time/ID ordering across pages.
	prioritizeKoi := cursor.ID == 0 || cursor.KoiInstallable != nil
	cursorInstallable := cursor.KoiInstallable != nil && *cursor.KoiInstallable
	viewer, err := a.publicRepositoryViewerID(r)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	tx, err := a.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if prioritizeKoi {
		var snapshot string
		// Snapshot visibility handles checks that started before this request but
		// finish later, including a transaction still uncommitted at the first page.
		if err = tx.QueryRow(r.Context(), `SELECT COALESCE($1::pg_snapshot,pg_current_snapshot())::text`, cursor.KoiSnapshot).Scan(&snapshot); err != nil {
			var inputErr *pgconn.PgError
			if errors.As(err, &inputErr) && strings.HasPrefix(inputErr.Code, "22") {
				httpx.ErrorCode(w, 400, "bad_request", "Invalid cursor")
			} else {
				writeAgentWorkspaceError(w, err)
			}
			return
		}
		cursor.KoiSnapshot = &snapshot
	}
	rows, err := tx.Query(r.Context(), `SELECT p.workspace_id,p.name,p.description,p.revision,p.published_at,
      count(f.path),COALESCE(sum(f.size_bytes),0)::bigint,p.license,p.github_source,w.is_system,w.hub_category,
      COALESCE((SELECT star_count FROM agent_repository_stats s WHERE s.workspace_id=p.workspace_id),0),
      EXISTS(SELECT 1 FROM agent_repository_stars s WHERE s.workspace_id=p.workspace_id AND s.user_id=$5),
      COALESCE((SELECT clone_count FROM agent_repository_stats s WHERE s.workspace_id=p.workspace_id),0),
      COALESCE(p.koi_installable,false),priority.value
      FROM agent_repository_publications p JOIN agent_workspaces w ON w.id=p.workspace_id
      CROSS JOIN LATERAL (SELECT CASE WHEN $9 THEN
        COALESCE(p.koi_installable AND pg_visible_in_snapshot(p.koi_installability_xid,$10::pg_snapshot),false)
        ELSE false END AS value) priority
      LEFT JOIN agent_repository_publication_files f ON f.workspace_id=p.workspace_id
      WHERE w.deleted_at IS NULL AND ($1::bigint=0 OR
      (priority.value,p.published_at,p.workspace_id)<($8::boolean,$4::timestamptz,$1))
      AND (strpos(lower(p.name||' '||p.description||' '||COALESCE(p.github_source->>'author','')),lower($2))>0 OR $2='')
      AND ($6='' OR w.is_system=($6='system')) AND ($7='' OR w.hub_category=$7)
      GROUP BY p.workspace_id,w.is_system,w.hub_category,priority.value
      ORDER BY priority.value DESC,p.published_at DESC,p.workspace_id DESC LIMIT $3`,
		cursor.ID, query, publicRepositoryPageSize+1, cursor.PublishedAt, viewer, source, category, cursorInstallable, prioritizeKoi, cursor.KoiSnapshot)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	items := []agentRepositoryDirectoryItem{}
	for rows.Next() {
		var item agentRepositoryDirectoryItem
		if err = rows.Scan(&item.WorkspaceID, &item.Name, &item.Description, &item.Revision, &item.UpdatedAt, &item.FileCount, &item.SizeBytes, &item.License, &item.GitHubSource, &item.SystemManaged, &item.Category, &item.StarCount, &item.Starred, &item.CloneCount, &item.KoiInstallable, &item.koiPriority); err != nil {
			rows.Close()
			writeAgentWorkspaceError(w, err)
			return
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	// Counts belong to the first page's snapshot. Cursor pages only append items;
	// avoid scanning the entire directory again for discarded statistics.
	metadata := map[string]any{}
	if cursor.ID == 0 {
		facets := []agentRepositoryDirectoryFacet{}
		total := 0
		rows, err = tx.Query(r.Context(), `SELECT w.is_system,w.hub_category,count(*) FROM agent_repository_publications p
      JOIN agent_workspaces w ON w.id=p.workspace_id WHERE w.deleted_at IS NULL
      AND (strpos(lower(p.name||' '||p.description||' '||COALESCE(p.github_source->>'author','')),lower($1))>0 OR $1='')
      GROUP BY w.is_system,w.hub_category ORDER BY w.is_system,w.hub_category`, query)
		if err != nil {
			writeAgentWorkspaceError(w, err)
			return
		}
		for rows.Next() {
			var facet agentRepositoryDirectoryFacet
			if err = rows.Scan(&facet.SystemManaged, &facet.Category, &facet.Count); err != nil {
				rows.Close()
				writeAgentWorkspaceError(w, err)
				return
			}
			facets = append(facets, facet)
			if (category == "" || category == facet.Category) && (source == "" || (source == "system") == facet.SystemManaged) {
				total += facet.Count
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			writeAgentWorkspaceError(w, err)
			return
		}
		metadata["total"], metadata["facets"] = total, facets
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	var next *string
	if len(items) > publicRepositoryPageSize {
		items = items[:publicRepositoryPageSize]
		last := items[len(items)-1]
		cursor.PublishedAt = last.UpdatedAt
		cursor.ID = last.WorkspaceID
		cursor.Scope = &scope
		if prioritizeKoi {
			cursor.KoiInstallable = &last.koiPriority
		}
		encoded, _ := json.Marshal(cursor)
		value := base64.RawURLEncoding.EncodeToString(encoded)
		next = &value
	}
	metadata["repositories"], metadata["nextCursor"] = items, next
	httpx.JSON(w, 200, metadata)
}

// One sitemap file holds at most 50,000 URLs; the Worker adds the fixed public
// pages (and their language variants) on top of these.
const publicRepositorySitemapLimit = 45000

type agentRepositorySitemapEntry struct {
	WorkspaceID int64     `json:"workspaceId"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// The Worker builds /sitemap.xml from this in a single request. Walking the
// directory instead means 12 rows per cursor page, one round trip each, which
// stopped well short of the full Hub. Same rows the directory lists: published
// and not deleted.
func (a *App) publicAgentRepositorySitemap(w http.ResponseWriter, r *http.Request) {
	if !a.allowPublicRepositoryRead(w, r) {
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT p.workspace_id,p.published_at FROM agent_repository_publications p
      JOIN agent_workspaces w ON w.id=p.workspace_id WHERE w.deleted_at IS NULL
      ORDER BY p.published_at DESC,p.workspace_id DESC LIMIT $1`, publicRepositorySitemapLimit)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	defer rows.Close()
	entries := []agentRepositorySitemapEntry{}
	for rows.Next() {
		var entry agentRepositorySitemapEntry
		if err = rows.Scan(&entry.WorkspaceID, &entry.UpdatedAt); err != nil {
			writeAgentWorkspaceError(w, err)
			return
		}
		entries = append(entries, entry)
	}
	if err = rows.Err(); err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"repositories": entries})
}
