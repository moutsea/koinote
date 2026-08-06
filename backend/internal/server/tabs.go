package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"koinote/backend/internal/httpx"
)

// 编辑器标签页：打开了哪几篇、当前是哪一篇。
//
// 整组覆盖而非增删单条：客户端本来就持有完整的标签栏顺序，逐条同步要处理顺序
// 冲突与中间态，而这份数据小到重写一遍更省事。

// 标签数上限。防的是请求体无节制变大，不是产品限制——
// 真开到这个数的人早就该用侧栏找文档了。
const maxOpenTabs = 30

type tabsPayload struct {
	Tabs        []string `json:"tabs"`
	ActiveDocID *string  `json:"activeDocId"`
}

func (a *App) editorTabsGet(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	// JOIN documents 不只是为了过滤已删文档（外键已经保证了），而是把「文档确实
	// 属于这个用户」再钉一遍——授权的实质是每条 SQL 都带 user_id
	rows, err := a.db.Query(r.Context(), `
		SELECT t.doc_id, t.is_active
		FROM editor_tabs t
		JOIN documents d ON d.doc_id = t.doc_id AND d.user_id = t.user_id
		WHERE t.user_id = $1
		ORDER BY t.position
	`, user.ID)
	if err != nil {
		log.Printf("editor tabs get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()

	tabs := []string{}
	var active *string
	for rows.Next() {
		var docID string
		var isActive bool
		if err := rows.Scan(&docID, &isActive); err != nil {
			log.Printf("editor tabs scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		tabs = append(tabs, docID)
		if isActive {
			id := docID
			active = &id
		}
	}
	if err := rows.Err(); err != nil {
		log.Printf("editor tabs rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"tabs": tabs, "activeDocId": active})
}

func (a *App) editorTabsPut(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	var body tabsPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}

	tabs, active, err := normalizeTabs(body)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		log.Printf("editor tabs begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if _, err := tx.Exec(r.Context(), `DELETE FROM editor_tabs WHERE user_id = $1`, user.ID); err != nil {
		log.Printf("editor tabs clear: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	for i, docID := range tabs {
		// INSERT ... SELECT 里带 user_id 过滤：塞进别人的 docId 会插不进去而不是
		// 报外键错误。后者会泄露「该文档存在」
		res, err := tx.Exec(r.Context(), `
			INSERT INTO editor_tabs (user_id, doc_id, position, is_active)
			SELECT $1, d.doc_id, $3, $4
			FROM documents d
			WHERE d.doc_id = $2 AND d.user_id = $1
		`, user.ID, docID, i, active != nil && *active == docID)
		if err != nil {
			log.Printf("editor tabs insert: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		// 影响 0 行 = 这个 docId 不属于该用户或已被删。静默跳过：标签是 UI 状态，
		// 为一个失效的 id 让整次同步失败没有意义
		_ = res
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("editor tabs commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	a.editorTabsGet(w, r)
}

// normalizeTabs 去重、去空、限长，并校验 activeDocId 落在 tabs 内。
//
// 抽成纯函数是为了能单独测——顺序、去重、活动标签落空这几条靠端到端测很笨重。
func normalizeTabs(body tabsPayload) ([]string, *string, error) {
	seen := make(map[string]bool, len(body.Tabs))
	tabs := make([]string, 0, len(body.Tabs))
	for _, raw := range body.Tabs {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		tabs = append(tabs, id)
	}

	if len(tabs) > maxOpenTabs {
		return nil, nil, errors.New("Too many open tabs")
	}

	var active *string
	if body.ActiveDocID != nil {
		id := strings.TrimSpace(*body.ActiveDocID)
		// 活动标签必须在标签栏里。不在就当没有——客户端状态错乱时不该写进库
		if id != "" && seen[id] {
			active = &id
		}
	}
	// 有标签但没指定活动的，取第一个：不留「打开了几篇但没有当前」的状态
	if active == nil && len(tabs) > 0 {
		active = &tabs[0]
	}

	return tabs, active, nil
}
