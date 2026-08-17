package server

import (
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"koinote/backend/internal/httpx"
)

const (
	defaultMCPActivityLimit = 50
	maxMCPActivityLimit     = 100
)

type mcpActivityView struct {
	ID            int64      `json:"id"`
	ToolName      string     `json:"toolName"`
	Result        string     `json:"result"`
	DurationMS    int        `json:"durationMs"`
	CreatedAt     *time.Time `json:"createdAt"`
	DocID         *string    `json:"docId"`
	DocumentTitle *string    `json:"documentTitle"`
	TokenName     *string    `json:"tokenName"`
	TokenHint     *string    `json:"tokenHint"`
}

func (a *App) mcpActivityList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	cursor, err := parseMCPActivityCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_cursor", "Invalid activity cursor")
		return
	}
	limit := defaultMCPActivityLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 1 || parsed > maxMCPActivityLimit {
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_limit", "Activity limit must be between 1 and 100")
			return
		}
		limit = parsed
	}

	rows, err := a.db.Query(r.Context(), `
		SELECT audit.id, audit.tool_name, audit.result, audit.duration_ms, audit.created_at,
		       audit.doc_id, document.title, token.name, token.token_hint
		FROM mcp_audit_logs audit
		LEFT JOIN documents document
		  ON document.id = audit.document_id AND document.user_id = audit.user_id
		LEFT JOIN mcp_tokens token ON token.id = audit.token_id
		WHERE audit.user_id = $1
		  AND ($2::bigint = 0 OR audit.id < $2)
		ORDER BY audit.id DESC
		LIMIT $3
	`, user.ID, cursor, limit+1)
	if err != nil {
		log.Printf("mcp activity list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()

	activities := make([]mcpActivityView, 0, limit+1)
	for rows.Next() {
		var activity mcpActivityView
		if err := rows.Scan(&activity.ID, &activity.ToolName, &activity.Result,
			&activity.DurationMS, &activity.CreatedAt, &activity.DocID,
			&activity.DocumentTitle, &activity.TokenName, &activity.TokenHint); err != nil {
			log.Printf("mcp activity scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		activities = append(activities, activity)
	}
	if err := rows.Err(); err != nil {
		log.Printf("mcp activity rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	nextCursor := ""
	if len(activities) > limit {
		activities = activities[:limit]
		nextCursor = encodeMCPActivityCursor(activities[len(activities)-1].ID)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"activities": activities,
		"nextCursor": nextCursor,
	})
}

func parseMCPActivityCursor(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return 0, errors.New("invalid cursor")
	}
	id, err := strconv.ParseInt(string(decoded), 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("invalid cursor")
	}
	return id, nil
}

func encodeMCPActivityCursor(id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(id, 10)))
}
