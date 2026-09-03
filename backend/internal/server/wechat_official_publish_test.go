package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func TestWechatCredentialEncryptionRoundTrip(t *testing.T) {
	app := &App{cfg: config.Config{
		NodeEnv:                       "production",
		WechatCredentialEncryptionKey: "wechat-test-key",
	}}
	ciphertext, err := app.encryptWechatCredential(42, "secret-value")
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := app.decryptWechatCredential(42, ciphertext)
	if err != nil || plaintext != "secret-value" {
		t.Fatalf("decrypt=%q err=%v", plaintext, err)
	}
	if _, err := app.decryptWechatCredential(43, ciphertext); err == nil {
		t.Fatal("ciphertext must be bound to its owning user")
	}
	if bytes.Contains(ciphertext, []byte("secret-value")) {
		t.Fatal("ciphertext contains plaintext")
	}
}

func TestWechatCredentialEncryptionRequiresIndependentKey(t *testing.T) {
	app := &App{cfg: config.Config{
		NodeEnv:       "development",
		SessionSecret: "must-not-be-used-for-wechat",
	}}
	if _, err := app.encryptWechatCredential(42, "secret-value"); !errors.Is(err, errWechatCredentialCrypto) {
		t.Fatalf("missing independent key error=%v, want %v", err, errWechatCredentialCrypto)
	}
}

func TestWechatHTTPClientOnlyUsesExplicitProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://unexpected-proxy.example:8080")
	directTransport, ok := newWechatAPIHTTPClient().Transport.(*http.Transport)
	if !ok || directTransport.Proxy != nil {
		t.Fatal("WeChat HTTP client inherited an ambient proxy")
	}

	proxiedTransport, ok := newWechatAPIHTTPClient("http://127.0.0.1:18080").Transport.(*http.Transport)
	if !ok || proxiedTransport.Proxy == nil {
		t.Fatal("WeChat HTTP client ignored its explicit proxy")
	}
	request := &http.Request{URL: &url.URL{Scheme: "https", Host: "api.weixin.qq.com"}}
	proxyURL, err := proxiedTransport.Proxy(request)
	if err != nil || proxyURL == nil || proxyURL.String() != "http://127.0.0.1:18080" {
		t.Fatalf("explicit proxy=%v error=%v", proxyURL, err)
	}
}

func TestWechatPublishErrorPreservesAccountAndPersistenceFailures(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "account removed during cover upload",
			err:        errors.Join(errWechatCoverUploadFailed, errWechatAccountNotBound),
			wantStatus: http.StatusConflict,
			wantCode:   "wechat_account_not_bound",
		},
		{
			name:       "database failed during image transfer",
			err:        errors.Join(errWechatContentImageFailed, errWechatPersistence),
			wantStatus: http.StatusInternalServerError,
			wantCode:   "server_error",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writeWechatPublishError(recorder, test.err)
			if recorder.Code != test.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", recorder.Code, test.wantStatus, recorder.Body.String())
			}
			var response struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if response.Code != test.wantCode {
				t.Fatalf("code=%q want=%q body=%s", response.Code, test.wantCode, recorder.Body.String())
			}
		})
	}
}

func TestWechatAccessTokenRefreshCoalescesConcurrentRequests(t *testing.T) {
	var requests atomic.Int32
	release := make(chan struct{})
	app := &App{wechatAPIHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests.Add(1)
		<-release
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"access_token":"shared-token","expires_in":7200}`)),
		}, nil
	})}}
	credential := wechatOfficialCredential{AccountID: "account-7", AppID: "wx1234567890abcdef", AppSecret: "secret"}
	const callers = 12
	start := make(chan struct{})
	results := make(chan string, callers)
	errorsFound := make(chan error, callers)
	var waiters sync.WaitGroup
	for index := 0; index < callers; index++ {
		waiters.Add(1)
		go func() {
			defer waiters.Done()
			<-start
			value, err := app.wechatAccessTokenForCredential(context.Background(), credential, false)
			results <- value
			errorsFound <- err
		}()
	}
	close(start)
	deadline := time.Now().Add(time.Second)
	for requests.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	close(release)
	waiters.Wait()
	close(results)
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatalf("coalesced refresh failed: %v", err)
		}
	}
	for value := range results {
		if value != "shared-token" {
			t.Fatalf("coalesced token=%q", value)
		}
	}
	if actual := requests.Load(); actual != 1 {
		t.Fatalf("stable_token requests=%d, want 1", actual)
	}
}

func TestWechatAccessTokenCacheIsScopedByAccount(t *testing.T) {
	now := time.Now()
	app := &App{wechatTokens: map[string]wechatAccessToken{
		"account-one": {AppID: "wx1111111111abcdef", Value: "token-one", ExpiresAt: now.Add(time.Hour)},
		"account-two": {AppID: "wx2222222222abcdef", Value: "token-two", ExpiresAt: now.Add(time.Hour)},
	}}
	for _, test := range []struct {
		accountID string
		appID     string
		want      string
	}{
		{accountID: "account-one", appID: "wx1111111111abcdef", want: "token-one"},
		{accountID: "account-two", appID: "wx2222222222abcdef", want: "token-two"},
	} {
		value, err := app.wechatAccessTokenForCredential(context.Background(), wechatOfficialCredential{
			AccountID: test.accountID,
			AppID:     test.appID,
		}, false)
		if err != nil || value != test.want {
			t.Fatalf("account %s token=%q err=%v want=%q", test.accountID, value, err, test.want)
		}
	}
}

func TestWechatOfficialAccountIDsRejectInvalidUUIDsBeforeQuery(t *testing.T) {
	app := &App{}
	if _, err := app.resolveWechatOfficialAccountRef(context.Background(), 1, "not-a-uuid"); !errors.Is(err, errWechatAccountNotBound) {
		t.Fatalf("resolve invalid account id error=%v", err)
	}
	if _, err := app.setDefaultWechatOfficialAccount(context.Background(), 1, "not-a-uuid"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("set default invalid account id error=%v", err)
	}
	if _, err := app.deleteWechatOfficialAccount(context.Background(), 1, "not-a-uuid"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("delete invalid account id error=%v", err)
	}
}

func TestWechatOfficialMultiAccountPersistence(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	app := New(config.Config{}, pool)
	ctx := context.Background()

	createAccount := func(label string) wechatOfficialAccountView {
		t.Helper()
		accountID, err := randomUUID()
		if err != nil {
			t.Fatalf("generate account id: %v", err)
		}
		view, err := app.createWechatOfficialAccount(ctx, userID, accountID, wechatOfficialAccountInput{
			Label:     &label,
			AppID:     "wx" + strings.ReplaceAll(accountID, "-", ""),
			AppSecret: "test-secret-1234567890",
		}, []byte("encrypted-secret"))
		if err != nil {
			t.Fatalf("create account %q: %v", label, err)
		}
		return view
	}

	first := createAccount("First")
	if !first.IsDefault {
		t.Fatal("the first account was not selected as default")
	}
	renamed, err := app.updateWechatOfficialAccountLabel(ctx, userID, first.AccountID, "Renamed")
	if err != nil || renamed.Label != "Renamed" || renamed.AppID != first.AppID {
		t.Fatalf("rename account=%+v err=%v", renamed, err)
	}
	second := createAccount("Second")
	if second.IsDefault {
		t.Fatal("the second account unexpectedly replaced the default")
	}

	selected, err := app.setDefaultWechatOfficialAccount(ctx, userID, second.AccountID)
	if err != nil || !selected.IsDefault {
		t.Fatalf("set default account=%+v err=%v", selected, err)
	}
	defaultAccount, err := app.loadDefaultWechatOfficialAccountView(ctx, userID)
	if err != nil || defaultAccount.AccountID != second.AccountID {
		t.Fatalf("default account=%+v err=%v want=%s", defaultAccount, err, second.AccountID)
	}
	resolved, err := app.resolveWechatOfficialAccountRef(ctx, userID, "")
	if err != nil || resolved.AccountID != second.AccountID {
		t.Fatalf("legacy default resolution=%+v err=%v", resolved, err)
	}

	for index := 3; index <= wechatOfficialAccountMaxCount; index++ {
		createAccount(fmt.Sprintf("Account %d", index))
	}
	overflowID, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	overflowLabel := "Overflow"
	_, err = app.createWechatOfficialAccount(ctx, userID, overflowID, wechatOfficialAccountInput{
		Label:     &overflowLabel,
		AppID:     "wx" + strings.ReplaceAll(overflowID, "-", ""),
		AppSecret: "test-secret-1234567890",
	}, []byte("encrypted-secret"))
	if !errors.Is(err, errWechatAccountLimit) {
		t.Fatalf("sixth account error=%v want=%v", err, errWechatAccountLimit)
	}

	foreignID, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	foreignSuffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	var foreignUserID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified)
		VALUES ($1, $2, true)
		RETURNING id
	`, "wechat-foreign-"+foreignSuffix, "wechat-foreign-"+foreignSuffix+"@example.test").Scan(&foreignUserID); err != nil {
		t.Fatalf("insert foreign user: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, foreignUserID); err != nil {
			t.Errorf("delete foreign user: %v", err)
		}
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO wechat_official_accounts (
			account_id, user_id, label, app_id, app_secret_ciphertext,
			app_secret_hint, is_default, verified_at
		)
		VALUES ($1, $2, 'Foreign', $3, $4, '••••test', true, now())
	`, foreignID, foreignUserID, "wx"+strings.ReplaceAll(foreignID, "-", ""), []byte("encrypted-secret")); err != nil {
		t.Fatalf("insert foreign account: %v", err)
	}
	if _, err := app.resolveWechatOfficialAccountRef(ctx, userID, foreignID); !errors.Is(err, errWechatAccountNotBound) {
		t.Fatalf("foreign account resolution error=%v want=%v", err, errWechatAccountNotBound)
	}

	unchangedDefaultID, err := app.deleteWechatOfficialAccount(ctx, userID, first.AccountID)
	if err != nil {
		t.Fatalf("delete non-default account: %v", err)
	}
	if unchangedDefaultID != second.AccountID {
		t.Fatalf("default after non-default deletion=%q want=%q", unchangedDefaultID, second.AccountID)
	}
	newDefaultID, err := app.deleteWechatOfficialAccount(ctx, userID, second.AccountID)
	if err != nil {
		t.Fatalf("delete default account: %v", err)
	}
	if newDefaultID == "" || newDefaultID == second.AccountID {
		t.Fatalf("promoted default account=%q", newDefaultID)
	}
	accounts, err := app.listWechatOfficialAccounts(ctx, userID)
	if err != nil {
		t.Fatalf("list accounts: %v", err)
	}
	if len(accounts) != wechatOfficialAccountMaxCount-2 {
		t.Fatalf("account count=%d want=%d", len(accounts), wechatOfficialAccountMaxCount-2)
	}
	defaultCount := 0
	for _, account := range accounts {
		if account.IsDefault {
			defaultCount++
		}
	}
	if defaultCount != 1 {
		t.Fatalf("default account count=%d want=1", defaultCount)
	}
}

func TestWechatAccessTokenForcedRefreshReusesNewerConcurrentToken(t *testing.T) {
	var requests atomic.Int32
	release := make(chan struct{})
	app := &App{
		wechatTokens: map[string]wechatAccessToken{
			"account-7": {AppID: "wx1234567890abcdef", Value: "failed-token", ExpiresAt: time.Now().Add(time.Hour)},
		},
		wechatAPIHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			requests.Add(1)
			var input struct {
				ForceRefresh bool `json:"force_refresh"`
			}
			if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
				return nil, err
			}
			if !input.ForceRefresh {
				t.Error("invalid-token retry did not force refresh")
			}
			<-release
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"access_token":"replacement-token","expires_in":7200}`)),
			}, nil
		})},
	}
	credential := wechatOfficialCredential{AccountID: "account-7", AppID: "wx1234567890abcdef", AppSecret: "secret"}
	const callers = 12
	start := make(chan struct{})
	results := make(chan string, callers)
	var waiters sync.WaitGroup
	for index := 0; index < callers; index++ {
		waiters.Add(1)
		go func() {
			defer waiters.Done()
			<-start
			value, err := app.refreshWechatAccessToken(context.Background(), credential, true, "failed-token")
			if err != nil {
				t.Errorf("forced refresh failed: %v", err)
			}
			results <- value
		}()
	}
	close(start)
	deadline := time.Now().Add(time.Second)
	for requests.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	close(release)
	waiters.Wait()
	close(results)
	for value := range results {
		if value != "replacement-token" {
			t.Fatalf("forced refresh token=%q", value)
		}
	}
	if actual := requests.Load(); actual != 1 {
		t.Fatalf("forced stable_token requests=%d, want 1", actual)
	}
}

func TestWechatAccessTokenRefreshFailureUnblocksWaitersAndCanRetry(t *testing.T) {
	var requests atomic.Int32
	releaseFailure := make(chan struct{})
	app := &App{wechatAPIHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(*http.Request) (*http.Response, error) {
		requestNumber := requests.Add(1)
		if requestNumber == 1 {
			<-releaseFailure
			return &http.Response{
				StatusCode: http.StatusBadGateway,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("provider unavailable")),
			}, nil
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"access_token":"retry-token","expires_in":7200}`)),
		}, nil
	})}}
	credential := wechatOfficialCredential{AccountID: "account-7", AppID: "wx1234567890abcdef", AppSecret: "secret"}
	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() {
		_, err := app.wechatAccessTokenForCredential(context.Background(), credential, false)
		first <- err
	}()
	deadline := time.Now().Add(time.Second)
	for requests.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	go func() {
		_, err := app.wechatAccessTokenForCredential(context.Background(), credential, false)
		second <- err
	}()
	time.Sleep(20 * time.Millisecond)
	if actual := requests.Load(); actual != 1 {
		t.Fatalf("waiting caller started another refresh: requests=%d", actual)
	}
	close(releaseFailure)
	for index, result := range []<-chan error{first, second} {
		if err := <-result; err == nil {
			t.Fatalf("caller %d unexpectedly succeeded", index+1)
		}
	}

	value, err := app.wechatAccessTokenForCredential(context.Background(), credential, false)
	if err != nil || value != "retry-token" {
		t.Fatalf("retry token=%q err=%v", value, err)
	}
	if actual := requests.Load(); actual != 2 {
		t.Fatalf("stable_token requests after retry=%d, want 2", actual)
	}
}

func TestWechatAccessTokenWaiterRetriesWhenRefreshLeaderIsCanceled(t *testing.T) {
	var requests atomic.Int32
	app := &App{wechatAPIHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if requests.Add(1) == 1 {
			<-request.Context().Done()
			return nil, request.Context().Err()
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"access_token":"waiter-token","expires_in":7200}`)),
		}, nil
	})}}
	credential := wechatOfficialCredential{AccountID: "account-7", AppID: "wx1234567890abcdef", AppSecret: "secret"}
	leaderContext, cancelLeader := context.WithCancel(context.Background())
	leaderResult := make(chan error, 1)
	go func() {
		_, err := app.wechatAccessTokenForCredential(leaderContext, credential, false)
		leaderResult <- err
	}()
	deadline := time.Now().Add(time.Second)
	for requests.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	waiterResult := make(chan struct {
		value string
		err   error
	}, 1)
	go func() {
		value, err := app.wechatAccessTokenForCredential(context.Background(), credential, false)
		waiterResult <- struct {
			value string
			err   error
		}{value: value, err: err}
	}()
	time.Sleep(20 * time.Millisecond)
	if actual := requests.Load(); actual != 1 {
		t.Fatalf("waiting caller started another refresh: requests=%d", actual)
	}
	cancelLeader()
	if err := <-leaderResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("leader error=%v, want context cancellation", err)
	}
	result := <-waiterResult
	if result.err != nil || result.value != "waiter-token" {
		t.Fatalf("waiter token=%q error=%v", result.value, result.err)
	}
	if actual := requests.Load(); actual != 2 {
		t.Fatalf("refresh requests=%d, want 2", actual)
	}
}

func TestWechatCoverGenerationEndpoint(t *testing.T) {
	for input, expected := range map[string]string{
		"https://example.test":                       "https://example.test/v1/images/generations",
		"https://example.test/v1":                    "https://example.test/v1/images/generations",
		"https://example.test/v1/images/generations": "https://example.test/v1/images/generations",
	} {
		actual, err := wechatCoverGenerationEndpoint(input)
		if err != nil || actual != expected {
			t.Fatalf("endpoint(%q)=%q err=%v want=%q", input, actual, err, expected)
		}
	}
	for _, input := range []string{"", "http://example.test/v1", "https://user@example.test/v1"} {
		if _, err := wechatCoverGenerationEndpoint(input); err == nil {
			t.Fatalf("invalid endpoint accepted: %q", input)
		}
	}
}

func TestWechatCoverGenerationChargesFixedCredits(t *testing.T) {
	coverData := testWechatCoverJPEG(t)
	app, pool, user, _ := newAgentReviewCreateTest(t, config.Config{
		SessionSecret:           "wechat-cover-credits-test",
		WechatCoverImageBaseURL: "https://cover-provider.example/v1",
		WechatCoverImageAPIKey:  "cover-test-key",
		WechatCoverImageModel:   "cover-test-model",
	})
	if _, err := pool.Exec(context.Background(), `UPDATE users SET is_admin = true WHERE id = $1`, user.ID); err != nil {
		t.Fatalf("grant test admin: %v", err)
	}
	app.wechatCoverHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/images/generations" || request.Header.Get("Authorization") != "Bearer cover-test-key" {
			t.Fatalf("unexpected cover provider request: path=%q authorization=%q", request.URL.Path, request.Header.Get("Authorization"))
		}
		var payload struct {
			Prompt string `json:"prompt"`
			Size   string `json:"size"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode cover provider request: %v", err)
		}
		if payload.Size != "1536x1024" || !strings.Contains(payload.Prompt, "Target aspect ratio: 2.35:1") {
			t.Fatalf("cover provider composition=%q size=%q", payload.Prompt, payload.Size)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(coverData) + `"}]}`)),
		}, nil
	})}
	grantCreditsForTest(t, pool, user.ID, 25, "wechat-cover-credits")

	response := requestWechatCoverGenerate(t, app, user, `{"prompt":"A calm writing desk","ratio":"2.35:1"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("cover generation status=%d body=%s", response.Code, response.Body.String())
	}
	balance, err := app.loadCreditBalance(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("load cover credit balance: %v", err)
	}
	if balance != (creditAccountBalance{Balance: 5, Reserved: 0, Available: 5}) {
		t.Fatalf("cover credit balance=%+v, want 5 available and no reservation", balance)
	}
	var amount int64
	var feature string
	if err := pool.QueryRow(context.Background(), `
		SELECT amount, metadata->>'feature'
		FROM credit_transactions
		WHERE user_id = $1 AND kind = 'agent_usage'
		ORDER BY created_at DESC
		LIMIT 1
	`, user.ID).Scan(&amount, &feature); err != nil {
		t.Fatalf("load cover credit transaction: %v", err)
	}
	if amount != -20 || feature != "wechat_cover_generation" {
		t.Fatalf("cover credit transaction amount=%d feature=%q, want -20/wechat_cover_generation", amount, feature)
	}
}

func TestWechatCoverGenerationFailureReleasesCredits(t *testing.T) {
	app, pool, user, _ := newAgentReviewCreateTest(t, config.Config{
		SessionSecret:           "wechat-cover-release-test",
		WechatCoverImageBaseURL: "https://cover-provider.example/v1",
		WechatCoverImageAPIKey:  "cover-test-key",
		WechatCoverImageModel:   "cover-test-model",
	})
	if _, err := pool.Exec(context.Background(), `UPDATE users SET is_admin = true WHERE id = $1`, user.ID); err != nil {
		t.Fatalf("grant test admin: %v", err)
	}
	app.wechatCoverHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusBadGateway,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`provider unavailable`)),
		}, nil
	})}
	grantCreditsForTest(t, pool, user.ID, 20, "wechat-cover-release")

	response := requestWechatCoverGenerate(t, app, user, `{"prompt":"A calm writing desk","ratio":"1:1"}`)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("failed cover generation status=%d body=%s", response.Code, response.Body.String())
	}
	balance, err := app.loadCreditBalance(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("load failed cover credit balance: %v", err)
	}
	if balance != (creditAccountBalance{Balance: 20, Reserved: 0, Available: 20}) {
		t.Fatalf("failed cover credit balance=%+v, want untouched balance", balance)
	}
}

func testWechatCoverJPEG(t *testing.T) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			source.SetRGBA(x, y, color.RGBA{R: uint8(x * 20), G: uint8(y * 20), B: 120, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, source, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode test cover: %v", err)
	}
	return encoded.Bytes()
}

func requestWechatCoverGenerate(
	t *testing.T,
	app *App,
	user model.User,
	body string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/wechat/cover/generate", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion))
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	return response
}

func TestPrepareWechatThumbRatiosAndLimit(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 1600, 1200))
	for y := 0; y < 1200; y++ {
		for x := 0; x < 1600; x++ {
			source.SetRGBA(x, y, color.RGBA{
				R: uint8((x * 17) % 255),
				G: uint8((y * 29) % 255),
				B: uint8(((x + y) * 11) % 255),
				A: 255,
			})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, source, &jpeg.Options{Quality: 92}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		ratio string
		want  float64
	}{
		{wechatCoverRatioWide, 2.35},
		{wechatCoverRatioSquare, 1},
	} {
		data, width, height, err := prepareWechatThumb(encoded.Bytes(), test.ratio)
		if err != nil {
			t.Fatalf("prepare %s: %v", test.ratio, err)
		}
		if len(data) > wechatThumbMaxBytes {
			t.Fatalf("prepare %s produced %d bytes", test.ratio, len(data))
		}
		if difference := math.Abs(float64(width)/float64(height) - test.want); difference > 0.01 {
			t.Fatalf("prepare %s dimensions=%dx%d", test.ratio, width, height)
		}
		if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
			t.Fatalf("prepare %s returned invalid JPEG: %v", test.ratio, err)
		}
	}
}

func TestDefaultWechatCoverIsValid(t *testing.T) {
	for _, test := range []struct {
		ratio      string
		wantWidth  int
		wantHeight int
	}{
		{ratio: wechatCoverRatioWide, wantWidth: 940, wantHeight: 400},
		{ratio: wechatCoverRatioSquare, wantWidth: 560, wantHeight: 560},
	} {
		data, err := defaultWechatCover("一篇没有 AI 封面的文章", test.ratio)
		if err != nil {
			t.Fatalf("default cover %s: %v", test.ratio, err)
		}
		if len(data) == 0 || len(data) > wechatThumbMaxBytes {
			t.Fatalf("default cover %s size=%d", test.ratio, len(data))
		}
		configuration, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("decode default cover %s: %v", test.ratio, err)
		}
		if format != "jpeg" || configuration.Width != test.wantWidth || configuration.Height != test.wantHeight {
			t.Fatalf("default cover %s format=%s dimensions=%dx%d", test.ratio, format, configuration.Width, configuration.Height)
		}
	}
}

func TestWechatCoverModesAndArticleSourceValidation(t *testing.T) {
	for _, mode := range []string{wechatCoverModeDefault, wechatCoverModeArticle, wechatCoverModeAI} {
		if !validWechatCoverMode(mode) {
			t.Fatalf("cover mode %q was rejected", mode)
		}
	}
	if validWechatCoverMode("unknown") {
		t.Fatal("unknown cover mode was accepted")
	}
	content := `<p><img src="https://cdn.example.test/cover.png"></p>`
	if !wechatHTMLHasImageSource(content, "https://cdn.example.test/cover.png") {
		t.Fatal("article image source was not found")
	}
	if wechatHTMLHasImageSource(content, "https://cdn.example.test/other.png") {
		t.Fatal("unrelated article image source was found")
	}
}

func TestWechatImageSourcePatternUsesRealSrc(t *testing.T) {
	for _, test := range []struct {
		name    string
		content string
		want    string
	}{
		{
			name:    "double quoted",
			content: `<p><img data-src="wrong" src="https://example.test/a.png?x=1&amp;y=2"></p>`,
			want:    "https://example.test/a.png?x=1&y=2",
		},
		{
			name:    "single quoted",
			content: `<p><img src='https://example.test/single.png'></p>`,
			want:    "https://example.test/single.png",
		},
		{
			name:    "unquoted",
			content: `<p><img src=https://example.test/unquoted.png></p>`,
			want:    "https://example.test/unquoted.png",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			match := wechatImageSourcePattern.FindStringSubmatchIndex(test.content)
			if match == nil {
				t.Fatal("image src was not found")
			}
			if source := imageSourceFromMatch(test.content, match); source != test.want {
				t.Fatalf("source=%q want=%q", source, test.want)
			}
		})
	}
}

func TestRewriteWechatImageSourcesPreservesImageTags(t *testing.T) {
	content := `<p><img class="hero" src="https://old.example/a.png?x=1&amp;y=2" alt="A"><img src='data:image/png;base64,AAAA'><img src=https://old.example/c.png></p>`
	matches := wechatImageSourcePattern.FindAllStringSubmatchIndex(content, -1)
	sources := make([]string, 0, len(matches))
	for _, match := range matches {
		sources = append(sources, imageSourceFromMatch(content, match))
	}
	rewritten, err := rewriteWechatImageSources(content, matches, sources, map[string]string{
		"https://old.example/a.png?x=1&y=2": "https://mmbiz.qpic.cn/a?wx=1&y=2",
		"data:image/png;base64,AAAA":        "https://mmbiz.qpic.cn/b",
		"https://old.example/c.png":         "https://mmbiz.qpic.cn/c",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `<p><img class="hero" src="https://mmbiz.qpic.cn/a?wx=1&amp;y=2" alt="A"><img src='https://mmbiz.qpic.cn/b'><img src="https://mmbiz.qpic.cn/c"></p>`
	if rewritten != want {
		t.Fatalf("rewritten HTML=%q want=%q", rewritten, want)
	}
}

func TestPrepareWechatContentImageSupportsTallImages(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 100, 3000))
	for y := 0; y < 3000; y++ {
		for x := 0; x < 100; x++ {
			source.SetRGBA(x, y, color.RGBA{R: uint8(y % 255), G: uint8(x * 2), B: 120, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, source, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	prepared, err := prepareWechatContentImage(encoded.Bytes())
	if err != nil {
		t.Fatalf("prepare tall image: %v", err)
	}
	if len(prepared) > wechatContentImageMaxBytes {
		t.Fatalf("prepared tall image is %d bytes", len(prepared))
	}
}

func TestWechatDraftHTTPChargesAndReleasesFixedCredits(t *testing.T) {
	pool := newGCTestPool(t)
	tests := []struct {
		name        string
		failDraft   bool
		credits     int64
		wantStatus  int
		wantCode    string
		wantBalance int64
	}{
		{name: "successful sync charges 20", credits: 20, wantStatus: http.StatusOK, wantBalance: 0},
		{name: "draft failure releases 20", credits: 20, failDraft: true, wantStatus: http.StatusBadGateway, wantCode: "wechat_draft_create_failed", wantBalance: 20},
		{name: "insufficient credits blocks provider calls", credits: 1, wantStatus: http.StatusPaymentRequired, wantCode: "insufficient_credits", wantBalance: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := New(config.Config{
				SessionSecret:                 "wechat-credit-test-session",
				InternalToken:                 "wechat-credit-test-internal",
				WechatCredentialEncryptionKey: "wechat-credit-test-key",
			}, pool)
			app.wechatAPIHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
				response := func(body string) (*http.Response, error) {
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
				}
				switch request.URL.Path {
				case "/cgi-bin/stable_token":
					return response(`{"access_token":"wechat-credit-token","expires_in":7200}`)
				case "/cgi-bin/material/add_material":
					return response(`{"media_id":"wechat-credit-thumb"}`)
				case "/cgi-bin/material/del_material":
					return response(`{}`)
				case "/cgi-bin/draft/add":
					if test.failDraft {
						return &http.Response{StatusCode: http.StatusBadGateway, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"errcode":-1,"errmsg":"unavailable"}`))}, nil
					}
					return response(`{"media_id":"wechat-credit-draft"}`)
				default:
					return nil, fmt.Errorf("unexpected WeChat API path %s", request.URL.Path)
				}
			})}
			user := seedMCPUser(t, pool, app, membershipTierLifetime)
			grantCreditsForTest(t, pool, user.ID, test.credits, "wechat-http-draft")
			accountID, err := randomUUID()
			if err != nil {
				t.Fatal(err)
			}
			ciphertext, err := app.encryptWechatCredential(user.ID, "wechat-secret")
			if err != nil {
				t.Fatalf("encrypt WeChat credential: %v", err)
			}
			label := "HTTP Publish"
			if _, err := app.createWechatOfficialAccount(context.Background(), user.ID, accountID, wechatOfficialAccountInput{
				Label: &label, AppID: "wx" + strings.ReplaceAll(accountID, "-", ""), AppSecret: "wechat-secret",
			}, ciphertext); err != nil {
				t.Fatalf("create WeChat account: %v", err)
			}
			doc, err := app.createDocument(context.Background(), createDocumentParams{User: user, Title: "Credit test", Content: "Article body"})
			if err != nil {
				t.Fatalf("create document: %v", err)
			}
			request := httptest.NewRequest(
				http.MethodPost,
				"/api/documents/"+doc.DocID+"/wechat-draft",
				strings.NewReader(fmt.Sprintf(`{"accountId":%q,"title":"Credit test","html":"<p>Article body</p>"}`, accountID)),
			)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("x-koinote-internal-token", "wechat-credit-test-internal")
			request.Header.Set("X-Auth-User-Id", user.AuthUserID)
			response := httptest.NewRecorder()
			app.Routes().ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("draft status=%d want=%d body=%s", response.Code, test.wantStatus, response.Body.String())
			}
			if test.wantCode != "" {
				var payload struct {
					Code string `json:"code"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
					t.Fatalf("decode draft error: %v", err)
				}
				if payload.Code != test.wantCode {
					t.Fatalf("draft code=%q want=%q", payload.Code, test.wantCode)
				}
			}
			balance, err := app.loadCreditBalance(context.Background(), user.ID)
			if err != nil {
				t.Fatalf("load credit balance: %v", err)
			}
			if balance.Balance != test.wantBalance || balance.Reserved != 0 || balance.Available != test.wantBalance {
				t.Fatalf("credit balance=%+v want balance=%d and no reservation", balance, test.wantBalance)
			}
		})
	}
}

func TestPrepareWechatDraftImagesUsesBoundedConcurrencyAndKeepsOrder(t *testing.T) {
	imageData := testWechatCoverJPEG(t)
	var active atomic.Int32
	var maximum atomic.Int32
	release := make(chan struct{})
	started := make(chan struct{}, wechatDraftImagePrepareWorkers)
	app := &App{wechatImageHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(*http.Request) (*http.Response, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for {
			observed := maximum.Load()
			if current <= observed || maximum.CompareAndSwap(observed, current) {
				break
			}
		}
		started <- struct{}{}
		<-release
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(bytes.NewReader(imageData)),
		}, nil
	})}}
	sources := []string{
		"https://one.example.test/a.png",
		"https://two.example.test/b.png",
		"https://three.example.test/c.png",
		"https://four.example.test/d.png",
	}
	preserveRaw := []bool{true, false, true, false}
	done := make(chan []wechatDraftImagePreparation, 1)
	go func() {
		done <- app.prepareWechatDraftImages(context.Background(), sources, preserveRaw)
	}()
	for index := 0; index < wechatDraftImagePrepareWorkers; index++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("image preparation did not start concurrently")
		}
	}
	close(release)
	results := <-done
	if maximum.Load() != wechatDraftImagePrepareWorkers {
		t.Fatalf("maximum image preparation concurrency=%d, want %d", maximum.Load(), wechatDraftImagePrepareWorkers)
	}
	for index, result := range results {
		if result.Source != sources[index] || result.Err != nil || len(result.Prepared) == 0 {
			t.Fatalf("result %d=%+v", index, result)
		}
		shouldRetainRaw := preserveRaw[index]
		if (len(result.Raw) > 0) != shouldRetainRaw {
			t.Fatalf("result %d raw retained=%v want=%v", index, len(result.Raw) > 0, shouldRetainRaw)
		}
	}
}

func TestPrepareWechatDraftImagesReportsSafeImageContext(t *testing.T) {
	app := &App{wechatImageHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusBadGateway,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("unavailable")),
		}, nil
	})}}
	source := "https://cdn.example.test/private/token-value/image.png"
	results := app.prepareWechatDraftImages(context.Background(), []string{source}, []bool{false})
	if len(results) != 1 || !errors.Is(results[0].Err, errWechatImageUnreachable) {
		t.Fatalf("unexpected image error: %+v", results)
	}
	message := results[0].Err.Error()
	if !strings.Contains(message, "article image 1 from cdn.example.test") || strings.Contains(message, "token-value") {
		t.Fatalf("unsafe or unhelpful image context: %q", message)
	}
}

type wechatRoundTripFunc func(*http.Request) (*http.Response, error)

func (function wechatRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestWechatPostJSONEscapesAccessToken(t *testing.T) {
	const accessToken = "token+with/slash&query"
	app := &App{wechatAPIHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if actual := request.URL.Query().Get("access_token"); actual != accessToken {
			t.Fatalf("access_token=%q want=%q", actual, accessToken)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"errcode":0,"media_id":"draft-id"}`)),
		}, nil
	})}}
	var output struct {
		MediaID string `json:"media_id"`
	}
	if err := app.wechatPostJSON(context.Background(), "/cgi-bin/draft/add", accessToken, map[string]any{}, &output); err != nil {
		t.Fatal(err)
	}
	if output.MediaID != "draft-id" {
		t.Fatalf("media id=%q", output.MediaID)
	}
}

func TestWechatProviderNetworkErrorDoesNotExposeAccessToken(t *testing.T) {
	const accessToken = "sensitive-token-value"
	app := &App{wechatAPIHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return nil, errors.New("dial failed for " + request.URL.String())
	})}}
	err := app.wechatPostJSON(context.Background(), "/cgi-bin/draft/add", accessToken, map[string]any{}, nil)
	if !errors.Is(err, errWechatProviderUnavailable) {
		t.Fatalf("network error=%v, want provider unavailable", err)
	}
	if strings.Contains(err.Error(), accessToken) || strings.Contains(err.Error(), "access_token") {
		t.Fatalf("network error exposed access token: %q", err)
	}
}

func TestWechatImageNetworkErrorDoesNotExposeSignedURL(t *testing.T) {
	const source = "https://images.example.test/generated.jpg?signature=sensitive-value"
	app := &App{wechatImageHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return nil, errors.New("dial failed for " + request.URL.String())
	})}}
	_, err := app.downloadWechatImage(context.Background(), source, wechatGeneratedCoverMaxBytes)
	if !errors.Is(err, errWechatImageUnreachable) {
		t.Fatalf("network error=%v, want image unreachable", err)
	}
	if strings.Contains(err.Error(), "signature") || strings.Contains(err.Error(), "sensitive-value") {
		t.Fatalf("network error exposed signed image URL: %q", err)
	}
}

func TestRequestWechatStableTokenForwardsForceRefresh(t *testing.T) {
	app := &App{wechatAPIHTTPClient: &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		var input struct {
			ForceRefresh bool `json:"force_refresh"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		if !input.ForceRefresh {
			t.Fatal("force_refresh was not forwarded to WeChat")
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"access_token":"fresh-token","expires_in":7200}`)),
		}, nil
	})}}
	token, err := app.requestWechatStableToken(context.Background(), "wx1234567890abcdef", "secret", true)
	if err != nil {
		t.Fatal(err)
	}
	if token.Value != "fresh-token" {
		t.Fatalf("token=%q", token.Value)
	}
}
