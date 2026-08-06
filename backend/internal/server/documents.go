package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const (
	maxTitleRunes   = 200
	maxContentBytes = 1 << 20 // 1 MiB，单篇 Markdown 的上限
)

// ---------- 列表 ----------

// documentsList 返回当前用户的文档摘要，按最近编辑排序。不含 content。
func (a *App) documentsList(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	rows, err := a.db.Query(r.Context(), `
		SELECT doc_id, title, updated_at
		FROM documents
		WHERE user_id = $1
		ORDER BY updated_at DESC
	`, user.ID)
	if err != nil {
		log.Printf("documents list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()

	// 显式初始化为空切片，保证 JSON 输出 [] 而非 null
	documents := make([]model.DocumentSummary, 0)
	for rows.Next() {
		var d model.DocumentSummary
		if err := rows.Scan(&d.DocID, &d.Title, &d.UpdatedAt); err != nil {
			log.Printf("documents scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		documents = append(documents, d)
	}
	if rows.Err() != nil {
		log.Printf("documents rows: %v", rows.Err())
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"documents": documents})
}

// ---------- 新建 ----------

func (a *App) documentCreate(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	// 请求体可选：允许空 body 直接建一篇空文档（前端「新建」按钮就是这么用的）
	var body struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}

	title, content, ok := validateDocumentInput(w, body.Title, body.Content)
	if !ok {
		return
	}

	docID, err := randomUUID()
	if err != nil {
		log.Printf("document id: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	var doc model.Document
	err = a.db.QueryRow(r.Context(), `
		INSERT INTO documents (doc_id, user_id, title, content, created_at, updated_at)
		VALUES ($1, $2, $3, $4, now(), now())
		RETURNING doc_id, title, theme, content, created_at, updated_at
	`, docID, user.ID, title, content).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.CreatedAt, &doc.UpdatedAt,
	)
	if err != nil {
		log.Printf("document create: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"document": doc})
}

// ---------- 取单篇 ----------

// documentGet 取指定文档。查询同时按 doc_id 与 user_id 过滤——
// 这才是授权的实质，doc_id 猜不到只是纵深防御。
func (a *App) documentGet(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	docID := strings.TrimSpace(r.PathValue("docId"))
	if docID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}

	var doc model.Document
	var shareToken, shareAccess, sharePasswordHash sql.NullString
	err := a.db.QueryRow(r.Context(), `
		SELECT doc_id, title, theme, content, created_at, updated_at,
		       share_token, share_access, share_password_hash
		FROM documents
		WHERE doc_id = $1 AND user_id = $2
	`, docID, user.ID).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.CreatedAt, &doc.UpdatedAt,
		&shareToken, &shareAccess, &sharePasswordHash,
	)
	// 他人文档与不存在的文档一律 404，不泄露「该文档存在」
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if err != nil {
		log.Printf("document get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	if token := strings.TrimSpace(shareToken.String); token != "" {
		doc.Share = &model.DocumentShare{
			Token:            token,
			Access:           normalizeShareAccess(shareAccess.String),
			RequiresPassword: sharePasswordHash.Valid && strings.TrimSpace(sharePasswordHash.String) != "",
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"document": doc})
}

// ---------- 更新 ----------

func (a *App) documentUpdate(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	docID := strings.TrimSpace(r.PathValue("docId"))
	if docID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}

	var body struct {
		Title   string `json:"title"`
		Theme   string `json:"theme"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}

	title, content, ok := validateDocumentInput(w, body.Title, body.Content)
	if !ok {
		return
	}
	theme := normalizeDocumentTheme(body.Theme)

	var doc model.Document
	err := a.db.QueryRow(r.Context(), `
		UPDATE documents
		SET title = $3, theme = $4, content = $5, updated_at = now()
		WHERE doc_id = $1 AND user_id = $2
		RETURNING doc_id, title, theme, content, created_at, updated_at
	`, docID, user.ID, title, theme, content).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.CreatedAt, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if err != nil {
		log.Printf("document update: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"document": doc})
}

// ---------- 删除 ----------

func (a *App) documentDelete(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	docID := strings.TrimSpace(r.PathValue("docId"))
	if docID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}

	tag, err := a.db.Exec(r.Context(), `
		DELETE FROM documents WHERE doc_id = $1 AND user_id = $2
	`, docID, user.ID)
	if err != nil {
		log.Printf("document delete: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// ---------- 输入校验 ----------

// validateDocumentInput 归一化并校验标题与正文，超限时写错误响应并返回 ok=false。
// 主题 id 白名单，与前端 spa/src/components/editor/wechatThemes.ts 的
// WechatThemeId 对齐。空串是「不套主题」。
//
// 为什么非法值落回默认而不是返 400：主题是排版偏好，前端传错不该让整篇文档
// 保存失败 —— 用户正在写的内容比这个字段重要得多。
var documentThemes = map[string]bool{
	"": true, "minimal": true, "medium": true, "wired": true, "verge": true,
	"stripe": true, "apple": true, "ft": true, "linear": true, "github": true,
	"notion": true, "magazine": true, "editorial": true, "newspaper": true,
	"course": true, "event": true,
}

const defaultDocumentTheme = "minimal"

func normalizeDocumentTheme(raw string) string {
	theme := strings.TrimSpace(raw)
	if documentThemes[theme] {
		return theme
	}
	return defaultDocumentTheme
}

func validateDocumentInput(w http.ResponseWriter, rawTitle, content string) (string, string, bool) {
	title := strings.TrimSpace(rawTitle)
	if utf8.RuneCountInString(title) > maxTitleRunes {
		httpx.ErrorCode(w, http.StatusBadRequest, "title_too_long", "Title is too long")
		return "", "", false
	}
	if len(content) > maxContentBytes {
		httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "content_too_large", "Document is too large")
		return "", "", false
	}
	return title, content, true
}
