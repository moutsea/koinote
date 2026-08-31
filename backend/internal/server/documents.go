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
		SELECT d.doc_id, d.title, d.created_at, d.updated_at, COALESCE(f.folder_id, ''), d.revision
		FROM documents d
		LEFT JOIN folders f ON f.id = d.folder_id
		WHERE d.user_id = $1 AND d.trashed_at IS NULL
		ORDER BY d.updated_at DESC
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
		var folder string
		if err := rows.Scan(&d.DocID, &d.Title, &d.CreatedAt, &d.UpdatedAt, &folder, &d.Revision); err != nil {
			log.Printf("documents scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		// 空串代表根下；JSON 里用 null 表达，与前端的 folderId: string|null 对齐
		if folder != "" {
			f := folder
			d.FolderID = &f
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
	//
	// FolderID 让「在这个文件夹里新建文档」一次请求完成。先建到根下再调移动接口也能
	// 做到，但那样新文档会先在根下闪一下，且移动失败时它就留在根下了。
	var body struct {
		DocID    string  `json:"docId"`
		Title    string  `json:"title"`
		Theme    *string `json:"theme"`
		Content  string  `json:"content"`
		FolderID *string `json:"folderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	body.DocID = strings.TrimSpace(body.DocID)
	if body.DocID != "" && (!strings.HasPrefix(bearerToken(r), desktopAccessTokenPrefix) || !validUUID(body.DocID)) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_document_id", "Invalid document id")
		return
	}

	title, content, ok := validateDocumentInput(w, body.Title, body.Content)
	if !ok {
		return
	}

	var theme *string
	if body.Theme != nil {
		normalized := normalizeDocumentTheme(*body.Theme)
		theme = &normalized
	}
	doc, err := a.createDocument(r.Context(), createDocumentParams{
		User: user, DocID: body.DocID, Title: title, Theme: theme, Content: content, FolderID: body.FolderID,
	})
	if errors.Is(err, errDocumentQuotaExceeded) {
		httpx.ErrorCode(w, http.StatusConflict, "storage_quota_exceeded",
			"Cloud storage quota exceeded")
		return
	}
	if errors.Is(err, errDocumentIDConflict) {
		httpx.ErrorCode(w, http.StatusConflict, "conflict", "Document already exists")
		return
	}
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
	var shareViewCount int64
	err := a.db.QueryRow(r.Context(), `
		SELECT doc_id, title, theme, content, revision, created_at, updated_at,
		       share_token, share_access, share_password_hash, share_view_count
		FROM documents
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
	`, docID, user.ID).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.Revision, &doc.CreatedAt, &doc.UpdatedAt,
		&shareToken, &shareAccess, &sharePasswordHash, &shareViewCount,
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
			ViewCount:        shareViewCount,
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
		Title            string `json:"title"`
		Theme            string `json:"theme"`
		Content          string `json:"content"`
		ExpectedRevision int64  `json:"expectedRevision"`
		ForceVersion     bool   `json:"forceVersion"`
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
	if body.ExpectedRevision <= 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "revision_required", "expectedRevision is required")
		return
	}

	doc, err := a.updateDocument(r.Context(), updateDocumentParams{
		User: user, DocID: docID, Title: title, Theme: theme, Content: content,
		ExpectedRevision: body.ExpectedRevision, Source: documentSourceWeb,
		ForceVersion: body.ForceVersion,
	})
	if errors.Is(err, errDocumentNotFound) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if errors.Is(err, errDocumentQuotaExceeded) {
		httpx.ErrorCode(w, http.StatusConflict, "storage_quota_exceeded", "Cloud storage quota exceeded")
		return
	}
	if errors.Is(err, errDocumentRevisionConflict) {
		httpx.ErrorCode(w, http.StatusConflict, "document_revision_conflict", "Document changed elsewhere")
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

	_, err := a.trashDocument(r.Context(), user, docID, 0)
	if errors.Is(err, errDocumentNotFound) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if err != nil {
		log.Printf("document trash: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) documentsTrashList(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT doc_id, title, revision, trashed_at
		FROM documents
		WHERE user_id = $1 AND trashed_at IS NOT NULL
		ORDER BY trashed_at DESC
	`, user.ID)
	if err != nil {
		log.Printf("documents trash list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()
	documents := make([]model.TrashedDocumentSummary, 0)
	for rows.Next() {
		var document model.TrashedDocumentSummary
		if err := rows.Scan(&document.DocID, &document.Title, &document.Revision, &document.TrashedAt); err != nil {
			log.Printf("documents trash scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if document.TrashedAt != nil {
			deletesAt := document.TrashedAt.Add(documentTrashRetention)
			document.DeletesAt = &deletesAt
		}
		documents = append(documents, document)
	}
	if err := rows.Err(); err != nil {
		log.Printf("documents trash rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"documents": documents})
}

func (a *App) documentRestore(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	doc, err := a.restoreTrashedDocument(r.Context(), user, r.PathValue("docId"), 0)
	if errors.Is(err, errDocumentNotTrashed) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Trashed document not found")
		return
	}
	if err != nil {
		log.Printf("document restore: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"document": doc})
}

func (a *App) documentPurge(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var body struct {
		Confirmation string `json:"confirmation"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	err := a.purgeDocument(r.Context(), userRef{ID: user.ID, AuthUserID: user.AuthUserID}, r.PathValue("docId"), body.Confirmation, true, false)
	if errors.Is(err, errDocumentNotTrashed) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Trashed document not found")
		return
	}
	if errors.Is(err, errDocumentPurgeConfirmation) {
		httpx.ErrorCode(w, http.StatusBadRequest, "confirmation_mismatch", "Confirmation does not match")
		return
	}
	if err != nil {
		log.Printf("document purge: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
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
	"course": true, "event": true, "paper": true, "signal": true,
	"notes": true, "pulse": true,
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
