package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"koinote/backend/internal/httpx"
)

const (
	shareAccessLink     = "link"     // 知道链接即可访问
	shareAccessPassword = "password" // 需要口令

	// shareAccessPublicLegacy 是删掉的第三档。它与 link 行为完全相同：
	// 后端从未有分支读它，而它声称的「允许被索引」也不存在 ——
	// setShareResponseHeaders 给所有分享页无条件加了 noindex。
	// 一个不改变任何行为的选项只会让用户误以为自己做了安全决策。
	// 保留常量仅用于把存量行归一成 link。
	shareAccessPublicLegacy = "public"

	sharePasswordMinRunes = 6
	sharePasswordMaxBytes = 256
	sharePasswordBodyMax  = 4 << 10 // 4 KiB，口令请求体不该更大

	// 两层限流：单 IP 挡广撒网，单链接挡集中爆破同一份文档
	sharePasswordIPAttempts   = 20
	sharePasswordLinkAttempts = 10
	sharePasswordWindow       = 15 * time.Minute
)

// setShareResponseHeaders 分享响应一律不进共享缓存。
// 口令档的正文尤其不能被 CDN 缓存后无口令直出。
func setShareResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	// 分享页一律不进搜索引擎，由用户自己传播
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
}

// normalizeShareAccess 把库里读出的档位归一成当前支持的取值。
// 存量的 public、空值、以及任何非预期取值都按最保守的 link 处理。
//
// 只用在读取路径。写入路径故意不用它：这里对未知值兜底成 link 是安全的
// （真正的访问控制在 share_password_hash），但写入时兜底会把拼错的档位
// 静默咽下去，那属于把错误藏起来。
func normalizeShareAccess(raw string) string {
	if strings.TrimSpace(raw) == shareAccessPassword {
		return shareAccessPassword
	}
	return shareAccessLink
}

// shouldRotateShareToken 判断这次改动是否在「放宽权限」。
//
// 收紧权限（link → 口令）可以复用 token：老链接只会变得更严，
// 拿着它的人从能读变成要输口令，安全性只增不减。
//
// 放宽权限（口令 → link）必须换 token。否则同一个 URL 会从「要口令」
// 变成「谁拿到都能直接读全文」—— 之前被口令挡住的人瞬间全部获得访问权，
// 而用户以为自己只是改了个设置。换 token 让老链接立刻失效，
// 用户必须重新分享，这个动作本身就是知情确认。
func shouldRotateShareToken(existingToken string, hadPassword, willHavePassword bool) bool {
	if strings.TrimSpace(existingToken) == "" {
		return false // 还没分享过，谈不上轮换
	}
	return hadPassword && !willHavePassword
}

func sharePasswordProblem(password string) string {
	trimmed := strings.TrimSpace(password)
	if utf8.RuneCountInString(trimmed) < sharePasswordMinRunes {
		return fmt.Sprintf("Share password must be at least %d characters", sharePasswordMinRunes)
	}
	if len(trimmed) > sharePasswordMaxBytes {
		return fmt.Sprintf("Share password must be at most %d bytes", sharePasswordMaxBytes)
	}
	return ""
}

// ---------- 创建 / 更新分享 ----------

// shareCreate 开启或更新分享。
//
// 重复调用默认复用同一 token，这样已发出的链接不会因为改权限就失效。
// 唯一例外是放宽权限（口令 → 无口令），此时必须换新 token，
// 详见 shouldRotateShareToken。
func (a *App) shareCreate(w http.ResponseWriter, r *http.Request) {
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
		Access   string `json:"access"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}

	access := strings.ToLower(strings.TrimSpace(body.Access))
	if access == "" {
		access = shareAccessLink
	}
	// 老页面（未刷新的标签页）可能还在发 public。它与 link 行为相同，
	// 按 link 收下而不是报错 —— 拒绝会让用户看到一个无法理解的失败。
	if access == shareAccessPublicLegacy {
		access = shareAccessLink
	}
	if access != shareAccessLink && access != shareAccessPassword {
		httpx.ErrorCode(w, http.StatusBadRequest, "share_access_invalid", "Invalid share access level")
		return
	}

	passwordHash := sql.NullString{}
	if access == shareAccessPassword {
		if problem := sharePasswordProblem(body.Password); problem != "" {
			httpx.ErrorCode(w, http.StatusBadRequest, "share_password_too_short", problem)
			return
		}
		hashed, err := bcrypt.GenerateFromPassword(
			[]byte(strings.TrimSpace(body.Password)), bcryptCost)
		if err != nil {
			log.Printf("share password hash: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		passwordHash = sql.NullString{String: string(hashed), Valid: true}
	}

	// 现有 token 与现有口令状态都要查：是否轮换取决于「改动前有没有口令」
	var existing sql.NullString
	var existingHash sql.NullString
	err := a.db.QueryRow(r.Context(), `
		SELECT share_token, share_password_hash
		FROM documents WHERE doc_id = $1 AND user_id = $2
	`, docID, user.ID).Scan(&existing, &existingHash)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if err != nil {
		log.Printf("share lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	token := strings.TrimSpace(existing.String)
	hadPassword := existingHash.Valid && strings.TrimSpace(existingHash.String) != ""
	rotated := shouldRotateShareToken(token, hadPassword, passwordHash.Valid)

	if token == "" || rotated {
		generated, genErr := randomHex(16) // 32 位十六进制，不可枚举
		if genErr != nil {
			log.Printf("share token: %v", genErr)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		token = generated
	}

	var hashArg any
	if passwordHash.Valid {
		hashArg = passwordHash.String
	}

	if _, err := a.db.Exec(r.Context(), `
		UPDATE documents
		SET share_token = $3, share_access = $4, share_password_hash = $5,
		    shared_at = COALESCE(shared_at, now())
		WHERE doc_id = $1 AND user_id = $2
	`, docID, user.ID, token, access, hashArg); err != nil {
		log.Printf("share create: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"share": map[string]any{
			"token":            token,
			"access":           access,
			"requiresPassword": passwordHash.Valid,
			// 轮换必须回传：用户可能已经把老链接发给别人了，
			// 界面得告诉他老链接已失效，需要重新分享。
			"tokenRotated": rotated,
		},
	})
}

// ---------- 撤销分享 ----------

// shareRevoke 清空 token。再次开启会生成新 token，老链接永久失效。
func (a *App) shareRevoke(w http.ResponseWriter, r *http.Request) {
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
		UPDATE documents
		SET share_token = NULL, share_access = NULL,
		    share_password_hash = NULL, shared_at = NULL
		WHERE doc_id = $1 AND user_id = $2
	`, docID, user.ID)
	if err != nil {
		log.Printf("share revoke: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// ---------- 公开读取 ----------

type sharedDocument struct {
	Title        string
	Theme        string
	Content      string
	Access       string
	PasswordHash sql.NullString
	UpdatedAt    *time.Time
	OwnerName    sql.NullString
}

func (a *App) sharedDocumentByToken(ctx context.Context, token string) (sharedDocument, error) {
	var doc sharedDocument
	var access sql.NullString
	err := a.db.QueryRow(ctx, `
		SELECT d.title, d.theme, d.content, d.share_access, d.share_password_hash,
		       d.updated_at, COALESCE(u.nickname, u.username)
		FROM documents d
		JOIN users u ON u.id = d.user_id
		WHERE d.share_token = $1
		LIMIT 1
	`, token).Scan(
		&doc.Title, &doc.Theme, &doc.Content, &access, &doc.PasswordHash,
		&doc.UpdatedAt, &doc.OwnerName,
	)
	doc.Access = normalizeShareAccess(access.String)
	return doc, err
}

// shareGet 无需登录。token 本身就是凭证。
func (a *App) shareGet(w http.ResponseWriter, r *http.Request) {
	setShareResponseHeaders(w)
	token := strings.TrimSpace(r.PathValue("token"))
	if token == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "share_not_found", "Share link not found")
		return
	}

	doc, err := a.sharedDocumentByToken(r.Context(), token)
	if errors.Is(err, pgx.ErrNoRows) {
		// 已撤销与从未存在返回同一个响应，不泄露链接曾经有效
		httpx.ErrorCode(w, http.StatusNotFound, "share_not_found", "Share link not found")
		return
	}
	if err != nil {
		log.Printf("share get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	// 口令档：只回一个标志位，正文一个字都不给
	if doc.PasswordHash.Valid && strings.TrimSpace(doc.PasswordHash.String) != "" {
		httpx.JSON(w, http.StatusOK, map[string]any{"requiresPassword": true})
		return
	}

	writeSharedDocument(w, doc)
}

// shareVerify 校验口令后返回正文。两层限流防爆破。
func (a *App) shareVerify(w http.ResponseWriter, r *http.Request) {
	setShareResponseHeaders(w)
	token := strings.TrimSpace(r.PathValue("token"))
	if token == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "share_not_found", "Share link not found")
		return
	}

	limiter := a.rateLimit()
	if !limiter.allow("share-pw:ip:"+requestIP(r), sharePasswordIPAttempts, sharePasswordWindow) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests", "Too many attempts, please try again later")
		return
	}
	// 链接维度的 key 用 token 的哈希，避免明文 token 进内存表
	linkKey := fmt.Sprintf("share-pw:link:%x", sha256.Sum256([]byte(token)))
	if !limiter.allow(linkKey, sharePasswordLinkAttempts, sharePasswordWindow) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests", "Too many attempts, please try again later")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, sharePasswordBodyMax)
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "bad_request", "Request body is too large")
			return
		}
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}

	doc, err := a.sharedDocumentByToken(r.Context(), token)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "share_not_found", "Share link not found")
		return
	}
	if err != nil {
		log.Printf("share verify: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	if doc.PasswordHash.Valid && strings.TrimSpace(doc.PasswordHash.String) != "" {
		if bcrypt.CompareHashAndPassword(
			[]byte(doc.PasswordHash.String), []byte(body.Password)) != nil {
			httpx.ErrorCode(w, http.StatusUnauthorized, "share_password_invalid", "Incorrect password")
			return
		}
		// 验对了就清掉该链接的失败计数，免得正常用户被之前的尝试连坐
		limiter.reset(linkKey)
	}

	writeSharedDocument(w, doc)
}

// writeSharedDocument 只输出公开视图需要的字段。
// 内部 id、user_id、doc_id、share_token 一律不外泄。
func writeSharedDocument(w http.ResponseWriter, doc sharedDocument) {
	httpx.JSON(w, http.StatusOK, map[string]any{
		"document": map[string]any{
			"title": doc.Title,
			// 分享页要和编辑区排版一致，主题得跟着出去
			"theme":     doc.Theme,
			"content":   doc.Content,
			"updatedAt": doc.UpdatedAt,
			"ownerName": strings.TrimSpace(doc.OwnerName.String),
		},
	})
}
