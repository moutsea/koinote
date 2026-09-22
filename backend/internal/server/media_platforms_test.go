package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestNormalizeCustomMediaEndpoint(t *testing.T) {
	valid := map[string]string{
		"https://publisher.example.com/api/articles/": "https://publisher.example.com/api/articles",
		" https://8.8.8.8:8443/publish ":              "https://8.8.8.8:8443/publish",
	}
	for input, want := range valid {
		t.Run("valid", func(t *testing.T) {
			got, err := normalizeCustomMediaEndpoint(input)
			if err != nil {
				t.Fatalf("normalize %q: %v", input, err)
			}
			if got != want {
				t.Fatalf("normalize %q = %q, want %q", input, got, want)
			}
		})
	}
	for _, input := range []string{
		"http://publisher.example.com/publish",
		"https://publisher.example.com/publish?token=secret",
		"https://user:pass@publisher.example.com/publish",
		"https://publisher.example.com/publish#fragment",
		"https://publisher.example.com:0/publish",
		"https://publisher.example.com:65536/publish",
		"https://localhost/publish",
		"https://service.internal/publish",
		"https://127.0.0.1/publish",
		"https://169.254.169.254/latest/meta-data",
		"ftp://publisher.example.com/publish",
	} {
		t.Run("invalid", func(t *testing.T) {
			if _, err := normalizeCustomMediaEndpoint(input); err == nil {
				t.Fatalf("normalize %q unexpectedly succeeded", input)
			}
		})
	}
}

func TestMediaTokenHint(t *testing.T) {
	if got := mediaTokenHint(""); got != "" {
		t.Fatalf("empty token hint = %q", got)
	}
	if got := mediaTokenHint("abc"); got != "configured" {
		t.Fatalf("short token hint = %q", got)
	}
	if got := mediaTokenHint("secret-token"); got != "••••oken" {
		t.Fatalf("token hint = %q", got)
	}
	if got := mediaTokenHint("abcd"); got != "configured" {
		t.Fatalf("four-character token hint = %q", got)
	}
	if got := mediaTokenHint("秘密令牌"); got != "configured" {
		t.Fatalf("short unicode token hint = %q", got)
	}
}

func TestCustomMediaCredentialEncryptionUsesPlatformAAD(t *testing.T) {
	app := &App{cfg: config.Config{CustomMediaCredentialEncryptionKey: "test-custom-media-key"}}
	const (
		platformID = "platform-a"
		token      = "secret-token-value"
	)
	ciphertext, err := app.encryptCustomMediaToken(platformID, token)
	if err != nil {
		t.Fatalf("encrypt token: %v", err)
	}
	if bytes.Contains(ciphertext, []byte(token)) {
		t.Fatal("ciphertext contains plaintext token")
	}
	plain, err := app.decryptCustomMediaToken(platformID, ciphertext)
	if err != nil || plain != token {
		t.Fatalf("decrypt token = %q, %v", plain, err)
	}
	if _, err := app.decryptCustomMediaToken("other-platform", ciphertext); err == nil {
		t.Fatal("token decrypted with a different platform AAD")
	}
}

func TestCustomMediaCredentialEncryptionDoesNotFallbackInProduction(t *testing.T) {
	app := &App{cfg: config.Config{NodeEnv: "production", SessionSecret: "session-only"}}
	if _, err := app.encryptCustomMediaToken("platform-a", "secret"); err == nil {
		t.Fatal("production unexpectedly fell back to SESSION_SECRET")
	}
}

func TestCustomMediaCredentialSurvivesSessionRotation(t *testing.T) {
	app := &App{cfg: config.Config{NodeEnv: "production", SessionSecret: "first", CustomMediaCredentialEncryptionKey: "media-key"}}
	ciphertext, err := app.encryptCustomMediaToken("platform-a", "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	app.cfg.SessionSecret = "second"
	if token, err := app.decryptCustomMediaToken("platform-a", ciphertext); err != nil || token != "secret-token" {
		t.Fatalf("session rotation broke media credentials: %v", err)
	}
}

func mediaRequest(t *testing.T, routes http.Handler, cookie *http.Cookie, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	routes.ServeHTTP(response, request)
	return response
}

func requireMediaStatus(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var result struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if response.Code != status || result.Code != code {
		t.Fatalf("HTTP %d, code %q; want %d, %q: %s", response.Code, result.Code, status, code, response.Body.String())
	}
}

func TestMediaPlatformSettingsAndTokenLifecycleHTTP(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "media-test", CustomMediaCredentialEncryptionKey: "media-encryption-test"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	other := seedMCPUser(t, pool, app, membershipTierFree)
	cookie := mcpSessionCookie(app, owner.AuthUserID)
	routes := app.Routes()
	ctx := context.Background()
	response := mediaRequest(t, routes, cookie, http.MethodGet, "/api/media/settings", nil)
	requireMediaStatus(t, response, http.StatusOK, "")
	var settings mediaPlatformSettingsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings.Settings != (mediaPlatformSettingsView{true, true, true}) || len(settings.CustomPlatforms) != 0 {
		t.Fatalf("unexpected defaults: %+v", settings)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM media_platform_settings WHERE user_id = $1`, owner.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("GET wrote settings: count=%d, err=%v", count, err)
	}
	response = mediaRequest(t, routes, cookie, http.MethodPut, "/api/media/settings", map[string]any{
		"wechatEnabled": false, "zhihuEnabled": false, "xEnabled": false, "futurePlatformEnabled": true,
	})
	requireMediaStatus(t, response, http.StatusOK, "")
	for _, path := range []string{"wechat-draft", "zhihu/publish", "x/publish"} {
		response = mediaRequest(t, routes, cookie, http.MethodPost, "/api/documents/test/"+path, map[string]any{})
		requireMediaStatus(t, response, http.StatusConflict, "media_platform_disabled")
	}
	otherSettings, err := app.loadBuiltInMediaSettings(ctx, other.ID)
	if err != nil || otherSettings != (mediaPlatformSettingsView{true, true, true}) {
		t.Fatalf("settings leaked between users: %+v %v", otherSettings, err)
	}
	input := customMediaPlatformInput{Name: "Publisher", EndpointURL: "https://publisher.example.com/publish", AuthToken: "abcd", Enabled: true}
	response = mediaRequest(t, routes, cookie, http.MethodPost, "/api/media/custom-platforms", input)
	requireMediaStatus(t, response, http.StatusCreated, "")
	var created struct {
		Platform customMediaPlatformView `json:"platform"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Platform.AuthTokenHint != "configured" || strings.Contains(response.Body.String(), "abcd") {
		t.Fatal("short token was exposed")
	}
	path := "/api/media/custom-platforms/" + created.Platform.PlatformID
	input.AuthToken = ""
	input.Name = "Renamed"
	requireMediaStatus(t, mediaRequest(t, routes, cookie, http.MethodPut, path, input), http.StatusOK, "")
	var ciphertext []byte
	if err := pool.QueryRow(ctx, `SELECT auth_token_ciphertext FROM custom_media_platforms WHERE platform_id = $1`, created.Platform.PlatformID).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if token, err := app.decryptCustomMediaToken(created.Platform.PlatformID, ciphertext); err != nil || token != "abcd" {
		t.Fatalf("blank edit did not retain the token: %v", err)
	}
	input.ClearAuthToken = true
	requireMediaStatus(t, mediaRequest(t, routes, cookie, http.MethodPut, path, input), http.StatusOK, "")
	var hint string
	if err := pool.QueryRow(ctx, `SELECT auth_token_ciphertext, auth_token_hint FROM custom_media_platforms WHERE platform_id = $1`, created.Platform.PlatformID).Scan(&ciphertext, &hint); err != nil || len(ciphertext) != 0 || hint != "" {
		t.Fatalf("explicit removal did not clear token and hint: %v", err)
	}
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		requireMediaStatus(t, mediaRequest(t, routes, mcpSessionCookie(app, other.AuthUserID), method, path, input), http.StatusNotFound, "not_found")
	}
}

func TestCustomMediaCreateConcurrentLimitHTTP(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "media-limit-test"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierFree)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO custom_media_platforms (user_id, name, endpoint_url)
		SELECT $1, 'Platform ' || number, 'https://publisher.example.com/publish'
		FROM generate_series(1, $2::int) AS number
	`, owner.ID, customMediaMaxCount-1); err != nil {
		t.Fatal(err)
	}
	routes := app.Routes()
	cookie := mcpSessionCookie(app, owner.AuthUserID)
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 4)
	for index := 0; index < 4; index++ {
		go func(index int) {
			<-start
			responses <- mediaRequest(t, routes, cookie, http.MethodPost, "/api/media/custom-platforms", customMediaPlatformInput{
				Name: fmt.Sprintf("Concurrent %d", index), EndpointURL: "https://publisher.example.com/publish", Enabled: true,
			})
		}(index)
	}
	close(start)
	created := 0
	for index := 0; index < 4; index++ {
		response := <-responses
		if response.Code == http.StatusCreated {
			created++
		} else {
			requireMediaStatus(t, response, http.StatusConflict, "custom_media_platform_limit_reached")
		}
	}
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM custom_media_platforms WHERE user_id = $1`, owner.ID).Scan(&count); err != nil || count != customMediaMaxCount || created != 1 {
		t.Fatalf("concurrent cap failed: count=%d, created=%d, err=%v", count, created, err)
	}
}

func TestCustomMediaPublishHTTP(t *testing.T) {
	pool := newGCTestPool(t)
	for _, test := range []struct {
		name            string
		providerStatus  int
		providerBody    string
		wantStatus      int
		wantCode        string
		wantURL         string
		disabled        bool
		foreignPlatform bool
		foreignDocument bool
		escapedBoundary bool
		oversizedField  bool
		oversizedBody   bool
	}{
		{name: "success", providerStatus: 201, providerBody: `{"url":"https://publisher.example.com/article/1"}`, wantStatus: 200, wantURL: "https://publisher.example.com/article/1"},
		{name: "non JSON success", providerStatus: 200, providerBody: "accepted", wantStatus: 200},
		{name: "empty success", providerStatus: 204, wantStatus: 200},
		{name: "upstream error", providerStatus: 500, providerBody: "failed", wantStatus: 502, wantCode: "custom_media_publish_failed"},
		{name: "response too large", providerStatus: 200, providerBody: strings.Repeat("x", customMediaMaxResponseBytes+1), wantStatus: 502, wantCode: "custom_media_publish_failed"},
		{name: "disabled", disabled: true, wantStatus: 409, wantCode: "custom_media_platform_disabled"},
		{name: "other platform owner", foreignPlatform: true, wantStatus: 404, wantCode: "not_found"},
		{name: "other document owner", foreignDocument: true, wantStatus: 404, wantCode: "not_found"},
		{name: "escaped field limits", escapedBoundary: true, providerStatus: 200, providerBody: "{}", wantStatus: 200},
		{name: "field too large", oversizedField: true, wantStatus: 400, wantCode: "custom_media_article_invalid"},
		{name: "body too large", oversizedBody: true, wantStatus: 413, wantCode: "content_too_large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := New(config.Config{SessionSecret: "publish-test", CustomMediaCredentialEncryptionKey: "publish-test-key", ImageQuotaBytes: 64 << 20}, pool)
			owner := seedMCPUser(t, pool, app, membershipTierFree)
			other := seedMCPUser(t, pool, app, membershipTierFree)
			documentOwner := owner
			if test.foreignDocument {
				documentOwner = other
			}
			doc, err := app.createDocument(context.Background(), createDocumentParams{User: documentOwner, Title: "Article", Content: "Body"})
			if err != nil {
				t.Fatal(err)
			}
			platformOwner := owner
			if test.foreignPlatform {
				platformOwner = other
			}
			routes := app.Routes()
			response := mediaRequest(t, routes, mcpSessionCookie(app, platformOwner.AuthUserID), http.MethodPost, "/api/media/custom-platforms", customMediaPlatformInput{
				Name: "Publisher", EndpointURL: "https://publisher.example.com/publish", AuthToken: "secret-token", Enabled: !test.disabled,
			})
			requireMediaStatus(t, response, http.StatusCreated, "")
			var created struct {
				Platform customMediaPlatformView `json:"platform"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
				t.Fatal(err)
			}
			input := map[string]string{"title": "Article", "markdown": "# Article\n\nBody", "html": "<p>Body</p>", "coverImageSource": "https://publisher.example.com/cover.png"}
			if test.escapedBoundary {
				input["markdown"] = strings.Repeat("\x01", maxContentBytes)
				input["html"] = strings.Repeat("\x01", customMediaMaxHTMLBytes)
			}
			if test.oversizedField {
				input["html"] = strings.Repeat("x", customMediaMaxHTMLBytes+1)
			}
			if test.oversizedBody {
				input["html"] = strings.Repeat("x", customMediaPublishRequestBytes+1)
			}
			calls := 0
			app.mediaHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				calls++
				if request.Method != http.MethodPost || request.URL.String() != "https://publisher.example.com/publish" || request.Header.Get("Authorization") != "Bearer secret-token" {
					t.Fatal("invalid outgoing endpoint or authentication")
				}
				var payload struct {
					Event  string `json:"event"`
					Source struct {
						DocumentID string `json:"documentId"`
						Revision   int64  `json:"revision"`
					} `json:"source"`
					Article map[string]string `json:"article"`
				}
				if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
					t.Fatal(err)
				}
				if payload.Event != "article.publish" || payload.Source.DocumentID != doc.DocID || payload.Source.Revision != doc.Revision {
					t.Fatal("invalid outgoing source metadata")
				}
				for field, want := range input {
					if payload.Article[field] != want {
						t.Fatalf("article field %s changed", field)
					}
				}
				return &http.Response{StatusCode: test.providerStatus, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(test.providerBody))}, nil
			})}
			response = mediaRequest(t, routes, mcpSessionCookie(app, owner.AuthUserID), http.MethodPost, "/api/documents/"+doc.DocID+"/media/"+created.Platform.PlatformID+"/publish", input)
			requireMediaStatus(t, response, test.wantStatus, test.wantCode)
			if (test.providerStatus != 0 && calls != 1) || (test.providerStatus == 0 && calls != 0) {
				t.Fatalf("unexpected upstream calls: %d", calls)
			}
			if test.wantStatus == http.StatusOK {
				var published struct {
					Published bool   `json:"published"`
					URL       string `json:"url"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &published); err != nil || !published.Published || published.URL != test.wantURL {
					t.Fatalf("unexpected publish response: %s", response.Body.String())
				}
			}
		})
	}
}
