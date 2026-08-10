package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
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
		SELECT d.doc_id, d.title, d.updated_at, COALESCE(f.folder_id, '')
		FROM documents d
		LEFT JOIN folders f ON f.id = d.folder_id
		WHERE d.user_id = $1
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
		if err := rows.Scan(&d.DocID, &d.Title, &d.UpdatedAt, &folder); err != nil {
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
		Title    string  `json:"title"`
		Content  string  `json:"content"`
		FolderID *string `json:"folderId"`
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

	// folder_id 与 documentMove 同一套写法：子查询带 user_id 过滤，传别人的
	// folderId 会解析成 NULL（落到根下），而不是报外键错误泄露「该文件夹存在」
	// 配额判定写进 INSERT ... SELECT ... WHERE，与图片记账同一套做法
	// （见 recordImageObject）：分成先查后插会让并发创建各自读到同一个用量。
	//
	// 与 documentUpdate 不同，这里没有"缩小则放行"的例外：新建文档只会让用量增加，
	// 而且用户没有正在编辑的内容会因此丢失 —— 拒绝新建是安全的。
	// $3 / $4 必须显式标注 ::text，否则整条语句在 Postgres 侧就 prepare 失败。
	//
	// 原因：title 列是 varchar(255)，所以从 INSERT 的目标列推出 $3 是
	// character varying；而 octet_length() 有 bit/bytea/character/text 四个重载，
	// 解析器从那里推出的是 text。同一个参数被推出两种类型，直接报
	// 「inconsistent types deduced for parameter $3」（SQLSTATE 42P08）。
	//
	// 表现极具误导性：**新建文档必然 500**，而前端在 /editor 无文档时会自动建一篇，
	// 失败后重试 —— 于是变成对 /api/documents 的无限重试（实测 9 秒内 1546 次），
	// 页面永远停在「加载中」。看日志才知道是 SQL prepare 失败，从界面上完全看不出。
	//
	// UPDATE 那条没这个问题：SET title = $3 与 octet_length($3) 都推出 text，
	// 不冲突。所以「能保存、不能新建」，更难联想到是同一个函数的重载问题。
	var doc model.Document
	err = a.db.QueryRow(r.Context(), `
		INSERT INTO documents (doc_id, user_id, title, content, folder_id, created_at, updated_at)
		SELECT
			$1, $2, $3::text, $4::text,
			CASE
				WHEN $5 = '' THEN NULL
				ELSE (SELECT id FROM folders WHERE folder_id = $5 AND user_id = $2)
			END,
			now(), now()
		WHERE COALESCE((
			SELECT SUM(octet_length(content) + octet_length(title))
			FROM documents WHERE user_id = $2
		), 0) + COALESCE((
			SELECT SUM(bytes) FROM image_objects WHERE user_id = $2
		), 0) + octet_length($4::text) + octet_length($3::text) <= $6
		RETURNING doc_id, title, theme, content, created_at, updated_at
	`, docID, user.ID, title, content, derefOrEmpty(body.FolderID), a.imageQuota()).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.CreatedAt, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// INSERT 的 WHERE 不成立 —— 唯一的原因就是超额（docID 是刚生成的随机值，
		// 不可能撞已有行）
		httpx.ErrorCode(w, http.StatusConflict, "storage_quota_exceeded",
			"Cloud storage quota exceeded")
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

	// 配额判定与写入合成一句，理由同图片记账（见 recordImageObject）：
	// 分成"先查用量再更新"的话，并发保存会各自读到同一个用量。
	//
	// 关键在最后那个 OR：只在文档「变大」时才卡配额。
	//
	// 无条件拒绝会有两个后果，都比超一点点存储更糟：
	//   1. 用户正在写的内容保存不了，可能丢稿 —— 而自动保存是每几秒一次，
	//      用户未必看得见错误提示
	//   2. 超额后就再也删不动了：删正文也是一次 UPDATE，如果它同样被拒，
	//      用户会被锁死在超额状态，没有任何自救途径
	//
	// 所以缩小或不变一律放行。超额的人只能越写越少，直到回到线内。
	var doc model.Document
	err := a.db.QueryRow(r.Context(), `
		UPDATE documents
		SET title = $3, theme = $4, content = $5, updated_at = now()
		WHERE doc_id = $1 AND user_id = $2
		  AND (
		    COALESCE((
		      SELECT SUM(octet_length(d.content) + octet_length(d.title))
		      FROM documents d WHERE d.user_id = $2 AND d.doc_id <> $1
		    ), 0)
		    + COALESCE((
		      SELECT SUM(bytes) FROM image_objects WHERE user_id = $2
		    ), 0)
		    + octet_length($5) + octet_length($3) <= $6
		    OR octet_length($5) + octet_length($3)
		       <= octet_length(content) + octet_length(title)
		  )
		RETURNING doc_id, title, theme, content, created_at, updated_at
	`, docID, user.ID, title, theme, content, a.imageQuota()).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.CreatedAt, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// 没更新到行有两种原因：文档不存在，或者被配额挡下。
		// 两者要给不同的错误码，否则用户会以为文档丢了
		var exists bool
		if qerr := a.db.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM documents WHERE doc_id = $1 AND user_id = $2)`,
			docID, user.ID,
		).Scan(&exists); qerr != nil {
			log.Printf("document update: 判断文档是否存在时出错: %v", qerr)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if exists {
			httpx.ErrorCode(w, http.StatusConflict, "storage_quota_exceeded",
				"Cloud storage quota exceeded")
			return
		}
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

	// DELETE ... RETURNING content：删除的同时把正文拿回来，用于回收里面的图片。
	// 先 SELECT 再 DELETE 的话，两步之间正文可能被改（另一个标签页正在保存），
	// 那就会漏掉或错删图片。
	var content string
	err := a.db.QueryRow(r.Context(), `
		DELETE FROM documents WHERE doc_id = $1 AND user_id = $2
		RETURNING content
	`, docID, user.ID).Scan(&content)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if err != nil {
		log.Printf("document delete: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	// 回收正文里的图片。用 context.WithoutCancel：请求返回后 r.Context() 就取消了，
	// 而入队还得往数据库写一次 —— 挂在请求 context 上会被打断
	gcCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer cancel()
	a.enqueueOrphanedImages(gcCtx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, content)

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
