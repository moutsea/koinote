package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stripe/stripe-go/v82"

	"koinote/backend/internal/config"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

type App struct {
	cfg             config.Config
	db              *pgxpool.Pool
	emailSender     verificationEmailSender
	limiter         *rateLimiter
	limiterOnce     sync.Once
	stripeCheckout  stripeCheckoutSessionClient
	paymentNotifier paymentNotifier
	siteAnalytics   siteAnalyticsClient
	adminOverview   adminOverviewCache
	productActivity activityTracker
}

func New(cfg config.Config, db *pgxpool.Pool) *App {
	app := &App{
		cfg:             cfg,
		db:              db,
		emailSender:     newWorkerVerificationEmailSender(cfg),
		limiter:         newRateLimiter(),
		paymentNotifier: newPaymentNotifier(cfg),
		siteAnalytics:   newCloudflareAnalyticsClient(cfg),
	}
	if cfg.StripeEnabled() {
		app.stripeCheckout = stripe.NewClient(cfg.StripeSecretKey).V1CheckoutSessions
	}
	return app
}

// rateLimit 惰性取限流器。测试里直接构造 App{} 时 limiter 为 nil，
// 这里兜住，避免走到限流路径就 panic。
func (a *App) rateLimit() *rateLimiter {
	a.limiterOnce.Do(func() {
		if a.limiter == nil {
			a.limiter = newRateLimiter()
		}
	})
	return a.limiter
}

// Routes 注册所有路由并套上 CORS 中间件。
func (a *App) Routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", a.health)
	mux.HandleFunc("POST /api/auth/register", a.authRegister)
	mux.HandleFunc("POST /api/auth/verification-code", a.authVerificationCode)
	mux.HandleFunc("POST /api/auth/verify-email", a.authVerifyEmail)
	mux.HandleFunc("POST /api/auth/password-reset-code", a.authPasswordResetCode)
	mux.HandleFunc("POST /api/auth/password-reset", a.authPasswordReset)
	mux.HandleFunc("POST /api/auth/password", a.authPasswordChange)
	mux.HandleFunc("POST /api/auth/sessions/invalidate", a.authSessionsInvalidate)
	mux.HandleFunc("POST /api/auth/login", a.authLogin)
	mux.HandleFunc("POST /api/auth/logout", a.authLogout)
	mux.HandleFunc("GET /api/auth/session", a.authSession)
	mux.HandleFunc("GET /api/auth/oauth/{provider}/start", a.oauthStart)
	mux.HandleFunc("GET /api/auth/oauth/{provider}/callback", a.oauthCallback)

	mux.HandleFunc("GET /api/billing/status", a.billingStatus)
	mux.HandleFunc("GET /api/billing/pricing", a.billingPricing)
	mux.HandleFunc("POST /api/billing/checkout", a.billingCheckout)
	mux.HandleFunc("POST /api/billing/checkout/confirm", a.billingCheckoutConfirm)
	mux.HandleFunc("POST /api/billing/webhook", a.billingWebhook)
	mux.HandleFunc("GET /api/admin/stats", a.adminStats)
	mux.HandleFunc("POST /api/analytics/events", a.analyticsEvent)
	mux.HandleFunc("GET /api/invitations", a.invitationsOverview)
	mux.HandleFunc("GET /api/mcp/tokens", a.mcpTokensList)
	mux.HandleFunc("POST /api/mcp/tokens", a.mcpTokenCreate)
	mux.HandleFunc("PATCH /api/mcp/tokens/{tokenId}", a.mcpTokenUpdateExpiry)
	mux.HandleFunc("POST /api/mcp/tokens/{tokenId}/reveal", a.mcpTokenReveal)
	mux.HandleFunc("DELETE /api/mcp/tokens/{tokenId}", a.mcpTokenRevoke)
	mux.HandleFunc("GET /api/settings/document-history", a.documentHistorySettingsGet)
	mux.HandleFunc("PUT /api/settings/document-history", a.documentHistorySettingsPut)
	mux.Handle("/mcp", a.mcpHandler())

	mux.HandleFunc("GET /api/folders", a.foldersList)
	mux.HandleFunc("POST /api/folders", a.folderCreate)
	mux.HandleFunc("PUT /api/folders/{folderId}", a.folderRename)
	mux.HandleFunc("DELETE /api/folders/{folderId}", a.folderDelete)
	mux.HandleFunc("PUT /api/folders/{folderId}/parent", a.folderMove)
	mux.HandleFunc("PUT /api/documents/{docId}/folder", a.documentMove)

	mux.HandleFunc("GET /api/editor/tabs", a.editorTabsGet)
	mux.HandleFunc("PUT /api/editor/tabs", a.editorTabsPut)

	// 图片存储配额。
	//
	// /api/storage/usage 而不是 /api/images/usage：Worker 把 /api/images/<key> 当作
	// 取图处理，"usage" 会被它当成一个 key 截走，永远到不了这里。
	mux.HandleFunc("GET /api/storage/usage", a.storageUsage)
	// Worker 写完 R2 来报账。鉴权走内部令牌 + X-Auth-User-Id（见 authUserIDFromRequest）
	mux.HandleFunc("POST /api/images/record", a.imageRecord)

	mux.HandleFunc("GET /api/documents", a.documentsList)
	mux.HandleFunc("GET /api/documents/search", a.documentsSearch)
	mux.HandleFunc("POST /api/documents", a.documentCreate)
	mux.HandleFunc("GET /api/documents/trash", a.documentsTrashList)
	mux.HandleFunc("POST /api/documents/{docId}/restore", a.documentRestore)
	mux.HandleFunc("DELETE /api/documents/{docId}/permanent", a.documentPurge)
	mux.HandleFunc("GET /api/documents/{docId}", a.documentGet)
	mux.HandleFunc("PUT /api/documents/{docId}", a.documentUpdate)
	mux.HandleFunc("DELETE /api/documents/{docId}", a.documentDelete)
	mux.HandleFunc("GET /api/documents/{docId}/versions", a.documentVersionsList)
	mux.HandleFunc("GET /api/documents/{docId}/versions/{revision}", a.documentVersionGet)
	mux.HandleFunc("POST /api/documents/{docId}/versions/{revision}/restore", a.documentVersionRestore)

	// 分享：前两条需登录且限本人文档，后两条公开（token 即凭证）
	mux.HandleFunc("POST /api/documents/{docId}/share", a.shareCreate)
	mux.HandleFunc("DELETE /api/documents/{docId}/share", a.shareRevoke)
	mux.HandleFunc("GET /api/share/{token}", a.shareGet)
	mux.HandleFunc("POST /api/share/{token}/verify", a.shareVerify)
	mux.HandleFunc("GET /api/share/{token}/meta", a.shareMeta)

	return a.withCORS(mux)
}

func (a *App) health(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// withCORS 允许白名单来源携带 cookie 的跨域请求（dev 下 Vite:5273 直连后端时需要）。
func (a *App) withCORS(next http.Handler) http.Handler {
	allowed := make(map[string]bool, len(a.cfg.AllowedOrigins))
	for _, o := range a.cfg.AllowedOrigins {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- 用户查询 ----------

func (a *App) getUserByAuthUserID(ctx context.Context, authUserID string) (model.User, error) {
	var u model.User
	err := a.db.QueryRow(ctx, `
		SELECT id, auth_user_id, email, username, nickname, avatar_url,
		       is_verified, is_admin, password_hash IS NOT NULL, session_version,
		       membership_tier, membership_granted_at,
		       bonus_storage_bytes, stripe_customer_id, created_at, updated_at
		FROM users WHERE auth_user_id = $1 LIMIT 1
	`, authUserID).Scan(
		&u.ID, &u.AuthUserID, &u.Email, &u.Username, &u.Nickname, &u.AvatarURL,
		&u.IsVerified, &u.IsAdmin, &u.HasPassword, &u.SessionVersion,
		&u.MembershipTier, &u.MembershipGrantedAt,
		&u.BonusStorageBytes, &u.StripeCustomerID, &u.CreatedAt, &u.UpdatedAt,
	)
	return u, err
}

type loginRecord struct {
	AuthUserID   string
	Email        string
	PasswordHash string
	IsVerified   bool
}

func (a *App) passwordLoginRecord(ctx context.Context, identifier string) (loginRecord, bool, error) {
	var rec loginRecord
	err := a.db.QueryRow(ctx, `
		SELECT auth_user_id, email, coalesce(password_hash, ''), is_verified
		FROM users
		WHERE lower(email) = lower($1) OR lower(username) = lower($1)
		LIMIT 1
	`, identifier).Scan(&rec.AuthUserID, &rec.Email, &rec.PasswordHash, &rec.IsVerified)
	if errors.Is(err, pgx.ErrNoRows) {
		return loginRecord{}, false, nil
	}
	if err != nil {
		return loginRecord{}, false, err
	}
	return rec, true, nil
}

func (a *App) emailOrUsernameExists(ctx context.Context, email, username string) (bool, error) {
	var exists bool
	err := a.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM users
			WHERE lower(email) = lower($1)
			   OR (username IS NOT NULL AND lower(username) = lower($2))
		)
	`, email, username).Scan(&exists)
	return exists, err
}

type authUserRecord struct {
	ID         int
	AuthUserID string
	IsVerified bool
}

// authUserByEmail 按邮箱（大小写不敏感）查用户，供 OAuth 账号合并使用。
func (a *App) authUserByEmail(ctx context.Context, email string) (authUserRecord, bool, error) {
	var rec authUserRecord
	err := a.db.QueryRow(ctx, `
		SELECT id, auth_user_id, is_verified FROM users
		WHERE lower(email) = lower($1) LIMIT 1
	`, email).Scan(&rec.ID, &rec.AuthUserID, &rec.IsVerified)
	if errors.Is(err, pgx.ErrNoRows) {
		return authUserRecord{}, false, nil
	}
	if err != nil {
		return authUserRecord{}, false, err
	}
	return rec, true, nil
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
