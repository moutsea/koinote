package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const (
	wechatAPIBaseURL              = "https://api.weixin.qq.com"
	wechatAccountRequestBytes     = 16 << 10
	wechatProviderResponseBytes   = 1 << 20
	wechatTokenRefreshSkew        = 5 * time.Minute
	wechatCredentialBindLimit     = 10
	wechatCredentialBindWindow    = time.Hour
	wechatOfficialRequestTimeout  = 45 * time.Second
	wechatOfficialAccountMaxCount = 5
	wechatAccountLabelMaxRunes    = 40
)

var (
	wechatAppIDPattern           = regexp.MustCompile(`^wx[A-Za-z0-9]{10,62}$`)
	errWechatAccountNotBound     = errors.New("wechat official account is not bound")
	errWechatCredentialCrypto    = errors.New("wechat credential encryption is unavailable")
	errWechatProviderUnavailable = errors.New("wechat provider is unavailable")
	errWechatPersistence         = errors.New("wechat persistence failed")
	errWechatAccountLimit        = errors.New("wechat official account limit reached")
)

type wechatAccessToken struct {
	AppID     string
	Value     string
	ExpiresAt time.Time
}

type wechatTokenRefreshKey struct {
	AccountID string
	AppID     string
}

type wechatTokenRefresh struct {
	Done  chan struct{}
	Force bool
	Value string
	Err   error
}

type wechatOfficialCredential struct {
	AccountID string
	AppID     string
	AppSecret string
}

type wechatOfficialAccountRef struct {
	UserID    int
	AccountID string
}

type wechatOfficialAccountView struct {
	AccountID  string    `json:"accountId"`
	Label      string    `json:"label"`
	AppID      string    `json:"appId"`
	SecretHint string    `json:"secretHint"`
	IsDefault  bool      `json:"isDefault"`
	VerifiedAt time.Time `json:"verifiedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type wechatOfficialAccountInput struct {
	Label     *string `json:"label"`
	AppID     string  `json:"appId"`
	AppSecret string  `json:"appSecret"`
}

type wechatRowScanner interface {
	Scan(dest ...any) error
}

type wechatProviderError struct {
	Code    int
	Message string
}

func (e *wechatProviderError) Error() string {
	return fmt.Sprintf("wechat API %d: %s", e.Code, e.Message)
}

func newWechatAPIHTTPClient(proxyURLs ...string) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	if len(proxyURLs) > 0 && strings.TrimSpace(proxyURLs[0]) != "" {
		if proxyURL, err := url.Parse(strings.TrimSpace(proxyURLs[0])); err == nil {
			transport.Proxy = http.ProxyURL(proxyURL)
		}
	}
	return &http.Client{
		Transport: transport,
		Timeout:   wechatOfficialRequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("wechat API redirects are disabled")
		},
	}
}

func (a *App) wechatOfficialAccountGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	view, err := a.loadDefaultWechatOfficialAccountView(r.Context(), user.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.JSON(w, http.StatusOK, map[string]any{"account": nil})
		return
	}
	if err != nil {
		log.Printf("wechat official account get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
}

func (a *App) wechatOfficialAccountPut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	input, token, ciphertext, ok := a.prepareWechatOfficialAccountBinding(w, r, user.ID)
	if !ok {
		return
	}
	view, err := a.upsertDefaultWechatOfficialAccount(r.Context(), user.ID, input, ciphertext)
	if err != nil {
		a.writeWechatAccountMutationError(w, "legacy put", err)
		return
	}
	a.storeWechatAccessToken(view.AccountID, token)
	httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
}

func (a *App) wechatOfficialAccountDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	accountID, err := a.defaultWechatOfficialAccountID(r.Context(), user.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
		return
	}
	if err != nil {
		log.Printf("wechat official account default lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if _, err := a.deleteWechatOfficialAccount(r.Context(), user.ID, accountID); err != nil {
		a.writeWechatAccountMutationError(w, "legacy delete", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) wechatOfficialAccountsList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	accounts, err := a.listWechatOfficialAccounts(r.Context(), user.ID)
	if err != nil {
		log.Printf("wechat official accounts list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"accounts": accounts,
		"maxCount": wechatOfficialAccountMaxCount,
	})
}

func (a *App) wechatOfficialAccountCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	input, token, ciphertext, ok := a.prepareWechatOfficialAccountBinding(w, r, user.ID)
	if !ok {
		return
	}
	accountID, err := randomUUID()
	if err != nil {
		log.Printf("wechat account id: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	view, err := a.createWechatOfficialAccount(r.Context(), user.ID, accountID, input, ciphertext)
	if err != nil {
		a.writeWechatAccountMutationError(w, "create", err)
		return
	}
	a.storeWechatAccessToken(view.AccountID, token)
	httpx.JSON(w, http.StatusCreated, map[string]any{"account": view})
}

func (a *App) wechatOfficialAccountUpdate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	accountID := strings.TrimSpace(r.PathValue("accountId"))
	if !validUUID(accountID) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "WeChat account not found")
		return
	}
	existing, err := a.loadWechatOfficialAccountView(r.Context(), user.ID, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "WeChat account not found")
		return
	} else if err != nil {
		log.Printf("wechat account update lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var input wechatOfficialAccountInput
	if !decodeWechatJSONBody(w, r, wechatAccountRequestBytes, &input) {
		return
	}
	if !normalizeWechatOfficialAccountLabel(w, &input) {
		return
	}
	input.AppID = strings.TrimSpace(input.AppID)
	input.AppSecret = strings.TrimSpace(input.AppSecret)
	if input.AppSecret == "" {
		if input.Label == nil {
			httpx.ErrorCode(w, http.StatusBadRequest, "wechat_credentials_invalid", "AppSecret is required unless updating the account label")
			return
		}
		if input.AppID != "" && input.AppID != existing.AppID {
			httpx.ErrorCode(w, http.StatusBadRequest, "wechat_credentials_invalid", "AppSecret is required when changing AppID")
			return
		}
		view, err := a.updateWechatOfficialAccountLabel(r.Context(), user.ID, accountID, *input.Label)
		if err != nil {
			a.writeWechatAccountMutationError(w, "rename", err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
		return
	}
	input, token, ciphertext, ok := a.prepareWechatOfficialAccountInput(w, r.Context(), user.ID, input)
	if !ok {
		return
	}
	view, err := a.updateWechatOfficialAccount(r.Context(), user.ID, accountID, input, ciphertext)
	if err != nil {
		a.writeWechatAccountMutationError(w, "update", err)
		return
	}
	a.storeWechatAccessToken(view.AccountID, token)
	httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
}

func (a *App) wechatOfficialAccountDeleteByID(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	accountID := strings.TrimSpace(r.PathValue("accountId"))
	defaultAccountID, err := a.deleteWechatOfficialAccount(r.Context(), user.ID, accountID)
	if err != nil {
		a.writeWechatAccountMutationError(w, "delete", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success":          true,
		"defaultAccountId": defaultAccountID,
	})
}

func (a *App) wechatOfficialAccountSetDefault(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	view, err := a.setDefaultWechatOfficialAccount(r.Context(), user.ID, strings.TrimSpace(r.PathValue("accountId")))
	if err != nil {
		a.writeWechatAccountMutationError(w, "set default", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
}

func (a *App) prepareWechatOfficialAccountBinding(
	w http.ResponseWriter,
	r *http.Request,
	userID int,
) (wechatOfficialAccountInput, wechatAccessToken, []byte, bool) {
	var input wechatOfficialAccountInput
	if !decodeWechatJSONBody(w, r, wechatAccountRequestBytes, &input) {
		return input, wechatAccessToken{}, nil, false
	}
	return a.prepareWechatOfficialAccountInput(w, r.Context(), userID, input)
}

func (a *App) prepareWechatOfficialAccountInput(
	w http.ResponseWriter,
	ctx context.Context,
	userID int,
	input wechatOfficialAccountInput,
) (wechatOfficialAccountInput, wechatAccessToken, []byte, bool) {
	input.AppID = strings.TrimSpace(input.AppID)
	input.AppSecret = strings.TrimSpace(input.AppSecret)
	if !normalizeWechatOfficialAccountLabel(w, &input) {
		return input, wechatAccessToken{}, nil, false
	}
	if !wechatAppIDPattern.MatchString(input.AppID) || len(input.AppSecret) < 16 || len(input.AppSecret) > 512 ||
		strings.ContainsAny(input.AppSecret, "\r\n\x00") {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_credentials_invalid", "Invalid WeChat AppID or AppSecret")
		return input, wechatAccessToken{}, nil, false
	}
	if !a.rateLimit().allow("wechat-bind:"+strconv.Itoa(userID), wechatCredentialBindLimit, wechatCredentialBindWindow) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests", "Too many WeChat binding attempts")
		return input, wechatAccessToken{}, nil, false
	}
	token, err := a.requestWechatStableToken(ctx, input.AppID, input.AppSecret, false)
	if err != nil {
		writeWechatOfficialError(w, err)
		return input, wechatAccessToken{}, nil, false
	}
	ciphertext, err := a.encryptWechatCredential(userID, input.AppSecret)
	if err != nil {
		log.Printf("wechat credential encrypt: %v", err)
		writeWechatOfficialError(w, errWechatCredentialCrypto)
		return input, wechatAccessToken{}, nil, false
	}
	return input, token, ciphertext, true
}

func normalizeWechatOfficialAccountLabel(w http.ResponseWriter, input *wechatOfficialAccountInput) bool {
	if input.Label == nil {
		return true
	}
	label := strings.TrimSpace(*input.Label)
	input.Label = &label
	if utf8.RuneCountInString(label) > wechatAccountLabelMaxRunes || strings.ContainsAny(label, "\r\n\x00") {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_account_label_invalid", "Invalid WeChat account label")
		return false
	}
	return true
}

func (a *App) listWechatOfficialAccounts(ctx context.Context, userID int) ([]wechatOfficialAccountView, error) {
	rows, err := a.db.Query(ctx, `
		SELECT account_id::text, label, app_id, app_secret_hint, is_default, verified_at, updated_at
		FROM wechat_official_accounts
		WHERE user_id = $1
		ORDER BY is_default DESC, created_at, account_id
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := make([]wechatOfficialAccountView, 0)
	for rows.Next() {
		view, err := scanWechatOfficialAccount(rows)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, view)
	}
	return accounts, rows.Err()
}

func (a *App) loadDefaultWechatOfficialAccountView(ctx context.Context, userID int) (wechatOfficialAccountView, error) {
	return scanWechatOfficialAccount(a.db.QueryRow(ctx, `
		SELECT account_id::text, label, app_id, app_secret_hint, is_default, verified_at, updated_at
		FROM wechat_official_accounts
		WHERE user_id = $1 AND is_default
	`, userID))
}

func (a *App) loadWechatOfficialAccountView(ctx context.Context, userID int, accountID string) (wechatOfficialAccountView, error) {
	return scanWechatOfficialAccount(a.db.QueryRow(ctx, `
		SELECT account_id::text, label, app_id, app_secret_hint, is_default, verified_at, updated_at
		FROM wechat_official_accounts
		WHERE user_id = $1 AND account_id = $2
	`, userID, accountID))
}

func scanWechatOfficialAccount(scanner wechatRowScanner) (wechatOfficialAccountView, error) {
	var view wechatOfficialAccountView
	err := scanner.Scan(
		&view.AccountID,
		&view.Label,
		&view.AppID,
		&view.SecretHint,
		&view.IsDefault,
		&view.VerifiedAt,
		&view.UpdatedAt,
	)
	return view, err
}

func (a *App) defaultWechatOfficialAccountID(ctx context.Context, userID int) (string, error) {
	var accountID string
	err := a.db.QueryRow(ctx, `
		SELECT account_id::text
		FROM wechat_official_accounts
		WHERE user_id = $1 AND is_default
	`, userID).Scan(&accountID)
	return accountID, err
}

func (a *App) resolveWechatOfficialAccountRef(ctx context.Context, userID int, accountID string) (wechatOfficialAccountRef, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		var err error
		accountID, err = a.defaultWechatOfficialAccountID(ctx, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return wechatOfficialAccountRef{}, errWechatAccountNotBound
		}
		if err != nil {
			return wechatOfficialAccountRef{}, fmt.Errorf("%w: %v", errWechatPersistence, err)
		}
		return wechatOfficialAccountRef{UserID: userID, AccountID: accountID}, nil
	}
	if !validUUID(accountID) {
		return wechatOfficialAccountRef{}, errWechatAccountNotBound
	}
	var exists bool
	if err := a.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM wechat_official_accounts
			WHERE user_id = $1 AND account_id = $2
		)
	`, userID, accountID).Scan(&exists); err != nil {
		return wechatOfficialAccountRef{}, fmt.Errorf("%w: %v", errWechatPersistence, err)
	}
	if !exists {
		return wechatOfficialAccountRef{}, errWechatAccountNotBound
	}
	return wechatOfficialAccountRef{UserID: userID, AccountID: accountID}, nil
}

func (a *App) loadWechatOfficialCredential(ctx context.Context, account wechatOfficialAccountRef) (wechatOfficialCredential, error) {
	var credential wechatOfficialCredential
	var ciphertext []byte
	err := a.db.QueryRow(ctx, `
		SELECT account_id::text, app_id, app_secret_ciphertext
		FROM wechat_official_accounts
		WHERE user_id = $1 AND account_id = $2
	`, account.UserID, account.AccountID).Scan(&credential.AccountID, &credential.AppID, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return wechatOfficialCredential{}, errWechatAccountNotBound
	}
	if err != nil {
		return wechatOfficialCredential{}, fmt.Errorf("%w: %v", errWechatPersistence, err)
	}
	credential.AppSecret, err = a.decryptWechatCredential(account.UserID, ciphertext)
	if err != nil {
		return wechatOfficialCredential{}, fmt.Errorf("decrypt WeChat credential: %w", errWechatCredentialCrypto)
	}
	return credential, nil
}

func (a *App) createWechatOfficialAccount(
	ctx context.Context,
	userID int,
	accountID string,
	input wechatOfficialAccountInput,
	ciphertext []byte,
) (wechatOfficialAccountView, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return wechatOfficialAccountView{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return wechatOfficialAccountView{}, err
	}
	var accountCount int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM wechat_official_accounts WHERE user_id = $1
	`, userID).Scan(&accountCount); err != nil {
		return wechatOfficialAccountView{}, err
	}
	if accountCount >= wechatOfficialAccountMaxCount {
		return wechatOfficialAccountView{}, errWechatAccountLimit
	}
	label := ""
	if input.Label != nil {
		label = *input.Label
	}
	view, err := scanWechatOfficialAccount(tx.QueryRow(ctx, `
		INSERT INTO wechat_official_accounts (
			account_id, user_id, label, app_id, app_secret_ciphertext,
			app_secret_hint, is_default, verified_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		RETURNING account_id::text, label, app_id, app_secret_hint,
		          is_default, verified_at, updated_at
	`, accountID, userID, label, input.AppID, ciphertext,
		wechatSecretHint(input.AppSecret), accountCount == 0))
	if err != nil {
		return wechatOfficialAccountView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return wechatOfficialAccountView{}, err
	}
	return view, nil
}

func (a *App) updateWechatOfficialAccount(
	ctx context.Context,
	userID int,
	accountID string,
	input wechatOfficialAccountInput,
	ciphertext []byte,
) (wechatOfficialAccountView, error) {
	var label any
	if input.Label != nil {
		label = *input.Label
	}
	return scanWechatOfficialAccount(a.db.QueryRow(ctx, `
		UPDATE wechat_official_accounts
		SET label = COALESCE($3::text, label),
		    app_id = $4,
		    app_secret_ciphertext = $5,
		    app_secret_hint = $6,
		    verified_at = now(),
		    updated_at = now()
		WHERE user_id = $1 AND account_id = $2
		RETURNING account_id::text, label, app_id, app_secret_hint,
		          is_default, verified_at, updated_at
	`, userID, accountID, label, input.AppID, ciphertext, wechatSecretHint(input.AppSecret)))
}

func (a *App) updateWechatOfficialAccountLabel(
	ctx context.Context,
	userID int,
	accountID string,
	label string,
) (wechatOfficialAccountView, error) {
	return scanWechatOfficialAccount(a.db.QueryRow(ctx, `
		UPDATE wechat_official_accounts
		SET label = $3, updated_at = now()
		WHERE user_id = $1 AND account_id = $2
		RETURNING account_id::text, label, app_id, app_secret_hint,
		          is_default, verified_at, updated_at
	`, userID, accountID, label))
}

func (a *App) upsertDefaultWechatOfficialAccount(
	ctx context.Context,
	userID int,
	input wechatOfficialAccountInput,
	ciphertext []byte,
) (wechatOfficialAccountView, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return wechatOfficialAccountView{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return wechatOfficialAccountView{}, err
	}
	var accountID string
	err = tx.QueryRow(ctx, `
		SELECT account_id::text
		FROM wechat_official_accounts
		WHERE user_id = $1
		ORDER BY is_default DESC, created_at, account_id
		LIMIT 1
	`, userID).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		accountID, err = randomUUID()
		if err != nil {
			return wechatOfficialAccountView{}, err
		}
		label := ""
		if input.Label != nil {
			label = *input.Label
		}
		view, insertErr := scanWechatOfficialAccount(tx.QueryRow(ctx, `
			INSERT INTO wechat_official_accounts (
				account_id, user_id, label, app_id, app_secret_ciphertext,
				app_secret_hint, is_default, verified_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, true, now())
			RETURNING account_id::text, label, app_id, app_secret_hint,
			          is_default, verified_at, updated_at
		`, accountID, userID, label, input.AppID, ciphertext, wechatSecretHint(input.AppSecret)))
		if insertErr != nil {
			return wechatOfficialAccountView{}, insertErr
		}
		if err := tx.Commit(ctx); err != nil {
			return wechatOfficialAccountView{}, err
		}
		return view, nil
	}
	if err != nil {
		return wechatOfficialAccountView{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE wechat_official_accounts
		SET is_default = (account_id = $2), updated_at = now()
		WHERE user_id = $1 AND is_default IS DISTINCT FROM (account_id = $2)
	`, userID, accountID); err != nil {
		return wechatOfficialAccountView{}, err
	}
	var label any
	if input.Label != nil {
		label = *input.Label
	}
	view, err := scanWechatOfficialAccount(tx.QueryRow(ctx, `
		UPDATE wechat_official_accounts
		SET label = COALESCE($3::text, label),
		    app_id = $4,
		    app_secret_ciphertext = $5,
		    app_secret_hint = $6,
		    verified_at = now(),
		    updated_at = now()
		WHERE user_id = $1 AND account_id = $2
		RETURNING account_id::text, label, app_id, app_secret_hint,
		          is_default, verified_at, updated_at
	`, userID, accountID, label, input.AppID, ciphertext, wechatSecretHint(input.AppSecret)))
	if err != nil {
		return wechatOfficialAccountView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return wechatOfficialAccountView{}, err
	}
	return view, nil
}

func (a *App) setDefaultWechatOfficialAccount(ctx context.Context, userID int, accountID string) (wechatOfficialAccountView, error) {
	if !validUUID(accountID) {
		return wechatOfficialAccountView{}, pgx.ErrNoRows
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return wechatOfficialAccountView{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return wechatOfficialAccountView{}, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM wechat_official_accounts
			WHERE user_id = $1 AND account_id = $2
		)
	`, userID, accountID).Scan(&exists); err != nil {
		return wechatOfficialAccountView{}, err
	}
	if !exists {
		return wechatOfficialAccountView{}, pgx.ErrNoRows
	}
	if _, err := tx.Exec(ctx, `
		UPDATE wechat_official_accounts
		SET is_default = false, updated_at = now()
		WHERE user_id = $1 AND is_default AND account_id <> $2
	`, userID, accountID); err != nil {
		return wechatOfficialAccountView{}, err
	}
	view, err := scanWechatOfficialAccount(tx.QueryRow(ctx, `
		UPDATE wechat_official_accounts
		SET is_default = true, updated_at = now()
		WHERE user_id = $1 AND account_id = $2
		RETURNING account_id::text, label, app_id, app_secret_hint,
		          is_default, verified_at, updated_at
	`, userID, accountID))
	if err != nil {
		return wechatOfficialAccountView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return wechatOfficialAccountView{}, err
	}
	return view, nil
}

func (a *App) deleteWechatOfficialAccount(ctx context.Context, userID int, accountID string) (string, error) {
	if !validUUID(accountID) {
		return "", pgx.ErrNoRows
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return "", err
	}
	var wasDefault bool
	if err := tx.QueryRow(ctx, `
		DELETE FROM wechat_official_accounts
		WHERE user_id = $1 AND account_id = $2
		RETURNING is_default
	`, userID, accountID).Scan(&wasDefault); err != nil {
		return "", err
	}
	defaultAccountID := ""
	if wasDefault {
		err := tx.QueryRow(ctx, `
			UPDATE wechat_official_accounts
			SET is_default = true, updated_at = now()
			WHERE account_id = (
				SELECT account_id FROM wechat_official_accounts
				WHERE user_id = $1
				ORDER BY created_at, account_id
				LIMIT 1
			)
			RETURNING account_id::text
		`, userID).Scan(&defaultAccountID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
	}
	if defaultAccountID == "" {
		err := tx.QueryRow(ctx, `
			SELECT account_id::text
			FROM wechat_official_accounts
			WHERE user_id = $1 AND is_default
		`, userID).Scan(&defaultAccountID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	a.wechatTokenMu.Lock()
	delete(a.wechatTokens, accountID)
	a.wechatTokenMu.Unlock()
	return defaultAccountID, nil
}

func (a *App) writeWechatAccountMutationError(w http.ResponseWriter, operation string, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "WeChat account not found")
	case errors.Is(err, errWechatAccountLimit):
		httpx.ErrorCode(w, http.StatusConflict, "wechat_account_limit_reached", "WeChat account limit reached")
	case isUniqueViolation(err):
		httpx.ErrorCode(w, http.StatusConflict, "wechat_account_already_bound", "This WeChat account is already bound")
	default:
		log.Printf("wechat official account %s: %v", operation, err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
	}
}

func (a *App) storeWechatAccessToken(accountID string, token wechatAccessToken) {
	a.wechatTokenMu.Lock()
	if a.wechatTokens == nil {
		a.wechatTokens = make(map[string]wechatAccessToken)
	}
	a.wechatTokens[accountID] = token
	a.wechatTokenMu.Unlock()
}

func (a *App) wechatCredentialCipher() (cipher.AEAD, error) {
	secret := strings.TrimSpace(a.cfg.WechatCredentialEncryptionKey)
	if secret == "" {
		return nil, errWechatCredentialCrypto
	}
	key := sha256.Sum256([]byte("koinote:wechat-credential:v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (a *App) encryptWechatCredential(userID int, secret string) ([]byte, error) {
	aead, err := a.wechatCredentialCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(secret), []byte(strconv.Itoa(userID))), nil
}

func (a *App) decryptWechatCredential(userID int, ciphertext []byte) (string, error) {
	aead, err := a.wechatCredentialCipher()
	if err != nil {
		return "", err
	}
	if len(ciphertext) < aead.NonceSize() {
		return "", errors.New("wechat credential ciphertext is truncated")
	}
	nonce := ciphertext[:aead.NonceSize()]
	plaintext, err := aead.Open(nil, nonce, ciphertext[aead.NonceSize():], []byte(strconv.Itoa(userID)))
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func wechatSecretHint(secret string) string {
	runes := []rune(secret)
	if len(runes) < 4 {
		return "configured"
	}
	return "••••" + string(runes[len(runes)-4:])
}

func (a *App) requestWechatStableToken(
	ctx context.Context,
	appID, appSecret string,
	forceRefresh bool,
) (wechatAccessToken, error) {
	var response struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	err := a.wechatPostJSON(ctx, "/cgi-bin/stable_token", "", map[string]any{
		"grant_type":    "client_credential",
		"appid":         appID,
		"secret":        appSecret,
		"force_refresh": forceRefresh,
	}, &response)
	if err != nil {
		return wechatAccessToken{}, err
	}
	if strings.TrimSpace(response.AccessToken) == "" || response.ExpiresIn <= 0 {
		return wechatAccessToken{}, errWechatProviderUnavailable
	}
	usableFor := time.Duration(response.ExpiresIn) * time.Second
	if usableFor > wechatTokenRefreshSkew+time.Minute {
		usableFor -= wechatTokenRefreshSkew
	} else {
		usableFor /= 2
	}
	return wechatAccessToken{
		AppID: appID, Value: response.AccessToken, ExpiresAt: time.Now().Add(usableFor),
	}, nil
}

func (a *App) wechatAccessTokenForAccount(ctx context.Context, account wechatOfficialAccountRef, force bool) (string, error) {
	credential, err := a.loadWechatOfficialCredential(ctx, account)
	if err != nil {
		return "", err
	}
	return a.wechatAccessTokenForCredential(ctx, credential, force)
}

func (a *App) wechatAccessTokenForAccountAfterFailure(
	ctx context.Context,
	account wechatOfficialAccountRef,
	failedToken string,
) (string, error) {
	credential, err := a.loadWechatOfficialCredential(ctx, account)
	if err != nil {
		return "", err
	}
	return a.refreshWechatAccessToken(ctx, credential, true, failedToken)
}

func (a *App) wechatAccessTokenForCredential(
	ctx context.Context,
	credential wechatOfficialCredential,
	force bool,
) (string, error) {
	return a.refreshWechatAccessToken(ctx, credential, force, "")
}

func (a *App) refreshWechatAccessToken(
	ctx context.Context,
	credential wechatOfficialCredential,
	force bool,
	failedToken string,
) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	key := wechatTokenRefreshKey{AccountID: credential.AccountID, AppID: credential.AppID}
	for {
		a.wechatTokenMu.Lock()
		if refresh := a.wechatTokenRefreshes[key]; refresh != nil {
			a.wechatTokenMu.Unlock()
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-refresh.Done:
				if refresh.Err != nil {
					if ctx.Err() == nil && errors.Is(refresh.Err, context.Canceled) {
						continue
					}
					return "", refresh.Err
				}
				if !force || refresh.Force || failedToken != "" && refresh.Value != failedToken {
					return refresh.Value, nil
				}
				continue
			}
		}
		cached, found := a.wechatTokens[credential.AccountID]
		cachedIsUsable := found && cached.AppID == credential.AppID && time.Now().Before(cached.ExpiresAt)
		if cachedIsUsable && (!force || failedToken != "" && cached.Value != failedToken) {
			a.wechatTokenMu.Unlock()
			return cached.Value, nil
		}
		if a.wechatTokenRefreshes == nil {
			a.wechatTokenRefreshes = make(map[wechatTokenRefreshKey]*wechatTokenRefresh)
		}
		refresh := &wechatTokenRefresh{Done: make(chan struct{}), Force: force}
		a.wechatTokenRefreshes[key] = refresh
		a.wechatTokenMu.Unlock()

		token, err := a.requestWechatStableToken(ctx, credential.AppID, credential.AppSecret, force)
		a.wechatTokenMu.Lock()
		if err == nil {
			if a.wechatTokens == nil {
				a.wechatTokens = make(map[string]wechatAccessToken)
			}
			a.wechatTokens[credential.AccountID] = token
			refresh.Value = token.Value
		}
		refresh.Err = err
		delete(a.wechatTokenRefreshes, key)
		close(refresh.Done)
		a.wechatTokenMu.Unlock()
		return refresh.Value, refresh.Err
	}
}

func (a *App) wechatPostJSON(ctx context.Context, path, accessToken string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	endpoint := wechatAPIBaseURL + path
	if accessToken != "" {
		separator := "?"
		if strings.Contains(endpoint, "?") {
			separator = "&"
		}
		endpoint += separator + "access_token=" + url.QueryEscape(accessToken)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	client := a.wechatAPIHTTPClient
	if client == nil {
		client = newWechatAPIHTTPClient(a.cfg.WechatAPIProxyURL)
	}
	response, err := client.Do(request)
	if err != nil {
		return wechatProviderRequestError(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, wechatProviderResponseBytes+1))
	if err != nil || len(responseBody) > wechatProviderResponseBytes {
		return errWechatProviderUnavailable
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("%w: HTTP %d", errWechatProviderUnavailable, response.StatusCode)
	}
	var providerStatus struct {
		ErrCode int    `json:"errcode"`
		ErrMsg  string `json:"errmsg"`
	}
	if err := json.Unmarshal(responseBody, &providerStatus); err != nil {
		return errWechatProviderUnavailable
	}
	if providerStatus.ErrCode != 0 {
		return &wechatProviderError{Code: providerStatus.ErrCode, Message: providerStatus.ErrMsg}
	}
	if output != nil {
		if err := json.Unmarshal(responseBody, output); err != nil {
			return errWechatProviderUnavailable
		}
	}
	return nil
}

func wechatProviderRequestError(err error) error {
	switch {
	case errors.Is(err, context.Canceled):
		return errors.Join(errWechatProviderUnavailable, context.Canceled)
	case errors.Is(err, context.DeadlineExceeded):
		return errors.Join(errWechatProviderUnavailable, context.DeadlineExceeded)
	default:
		return fmt.Errorf("%w: request failed", errWechatProviderUnavailable)
	}
}

func decodeWechatJSONBody(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return false
	}
	return true
}

func isWechatAccessTokenError(err error) bool {
	var providerError *wechatProviderError
	return errors.As(err, &providerError) && (providerError.Code == 40014 || providerError.Code == 42001)
}

func writeWechatOfficialError(w http.ResponseWriter, err error) {
	var providerError *wechatProviderError
	if errors.As(err, &providerError) {
		switch providerError.Code {
		case 40013, 40125:
			httpx.ErrorCode(w, http.StatusBadRequest, "wechat_credentials_invalid", "Invalid WeChat AppID or AppSecret")
		case 40164:
			httpx.ErrorCode(w, http.StatusBadGateway, "wechat_ip_not_allowed", "Server IP is not in the WeChat allowlist")
		case 48001, 48004, 48005:
			httpx.ErrorCode(w, http.StatusForbidden, "wechat_api_unauthorized", "This WeChat account cannot use the requested API")
		case 45009:
			httpx.ErrorCode(w, http.StatusTooManyRequests, "wechat_api_limit_reached", "WeChat API daily limit reached")
		default:
			log.Printf("wechat provider error: code=%d message=%s", providerError.Code, providerError.Message)
			httpx.ErrorCode(w, http.StatusBadGateway, "wechat_provider_error", "WeChat rejected the request")
		}
		return
	}
	switch {
	case errors.Is(err, errWechatAccountNotBound):
		httpx.ErrorCode(w, http.StatusConflict, "wechat_account_not_bound", "Bind a WeChat official account first")
	case errors.Is(err, errWechatCredentialCrypto):
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "wechat_credentials_unavailable", "WeChat credential storage is unavailable")
	case errors.Is(err, errWechatPersistence):
		log.Printf("wechat persistence: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
	default:
		log.Printf("wechat request failed: %v", err)
		httpx.ErrorCode(w, http.StatusBadGateway, "wechat_provider_unavailable", "WeChat is temporarily unavailable")
	}
}
