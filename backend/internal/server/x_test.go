package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestOAuthEscape(t *testing.T) {
	if got := oauthEscape("Ladies + Gentlemen"); got != "Ladies%20%2B%20Gentlemen" {
		t.Fatalf("oauthEscape() = %q", got)
	}
	if got := oauthEscape("你好"); got != "%E4%BD%A0%E5%A5%BD" {
		t.Fatalf("oauthEscape unicode = %q", got)
	}
}

func TestXTextWeightAccountsForWideRunes(t *testing.T) {
	if got := xTextWeight(strings.Repeat("中", 140)); got != 280 {
		t.Fatalf("CJK weight = %d, want 280", got)
	}
	if got := xTextWeight(strings.Repeat("a", 280)); got != 280 {
		t.Fatalf("ASCII weight = %d, want 280", got)
	}
	if got := xTextWeight(strings.Repeat("ሀ", 140)); got != 280 {
		t.Fatalf("Armenian weight = %d, want 280", got)
	}
	if got := xTextWeight("https://x.co"); got != xTransformedURLLength {
		t.Fatalf("URL weight = %d, want %d", got, xTransformedURLLength)
	}
}

func TestXOAuth2CodeChallengeUsesS256Base64URL(t *testing.T) {
	verifier := "test-verifier-value"
	digest := sha256.Sum256([]byte(verifier))
	want := base64.RawURLEncoding.EncodeToString(digest[:])
	if got := xOAuth2CodeChallenge(verifier); got != want {
		t.Fatalf("code challenge = %q, want %q", got, want)
	}
	if strings.ContainsAny(xOAuth2CodeChallenge(verifier), "+/= ") {
		t.Fatal("code challenge must use unpadded base64url")
	}
}

func TestXOAuth2AuthorizeURLIncludesPKCEAndRedirect(t *testing.T) {
	app := &App{cfg: config.Config{
		AppURL:              "https://koinote.example",
		XOAuth2ClientID:     "client-id",
		XOAuth2ClientSecret: "client-secret",
	}}
	got, err := app.xOAuth2AuthorizeURL("state-value", "verifier-value")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if parsed.Scheme != "https" || parsed.Host != "x.com" || parsed.Path != "/i/oauth2/authorize" {
		t.Fatalf("authorize URL = %q", got)
	}
	if query.Get("response_type") != "code" || query.Get("client_id") != "client-id" ||
		query.Get("redirect_uri") != "https://koinote.example/api/x/oauth2/callback" ||
		query.Get("state") != "state-value" || query.Get("code_challenge_method") != "S256" {
		t.Fatalf("authorize query = %v", query)
	}
	if query.Get("code_challenge") != xOAuth2CodeChallenge("verifier-value") {
		t.Fatalf("code challenge = %q", query.Get("code_challenge"))
	}
	if query.Get("scope") != xOAuth2Scopes {
		t.Fatalf("scope = %q, want %q", query.Get("scope"), xOAuth2Scopes)
	}
}

func TestXOAuth2StateCookieUsesScopedHttpOnlyCookie(t *testing.T) {
	app := &App{cfg: config.Config{NodeEnv: "production"}}
	recorder := httptest.NewRecorder()
	app.setXOAuth2StateCookie(recorder, "state-value")
	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %v", cookies)
	}
	cookie := cookies[0]
	if cookie.Name != xOAuth2StateCookie || cookie.Value != "state-value" ||
		cookie.Path != "/api/x/oauth2" || !cookie.HttpOnly || !cookie.Secure ||
		cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge <= 0 {
		t.Fatalf("state cookie = %+v", cookie)
	}
}

func TestIsTrustedXImageURLRequiresKoinoteImageOriginAndPath(t *testing.T) {
	tests := []struct {
		name   string
		source string
		want   bool
	}{
		{name: "official image", source: "https://img.koinote.app/u/alice/0123456789abcdef.png?cache=1", want: true},
		{name: "trailing dot host", source: "https://IMG.KOINOTE.APP./u/alice/0123456789abcdef.png", want: true},
		{name: "external host", source: "https://evil.example/u/alice/0123456789abcdef.png", want: false},
		{name: "invalid object path", source: "https://img.koinote.app/not-an-image", want: false},
		{name: "non default port", source: "https://img.koinote.app:8443/u/alice/0123456789abcdef.png", want: false},
		{name: "userinfo", source: "https://alice@img.koinote.app/u/alice/0123456789abcdef.png", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := url.Parse(test.source)
			if err != nil {
				t.Fatal(err)
			}
			if got := isTrustedXImageURL(parsed); got != test.want {
				t.Fatalf("isTrustedXImageURL(%q) = %v, want %v", test.source, got, test.want)
			}
		})
	}
}

func TestReadXImageUsesTrustedClientForKoinoteImages(t *testing.T) {
	trustedCalls := 0
	externalCalls := 0
	trustedClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		trustedCalls++
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("trusted image")), Header: make(http.Header)}, nil
	})}
	externalClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		externalCalls++
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("external image")), Header: make(http.Header)}, nil
	})}
	app := &App{
		cfg:                     config.Config{WorkerURL: "http://worker.example/base"},
		xImageHTTPClient:        externalClient,
		xTrustedImageHTTPClient: trustedClient,
	}
	data, err := app.readXImage(context.Background(), "https://img.koinote.app/u/alice/0123456789abcdef.png")
	if err != nil || string(data) != "trusted image" {
		t.Fatalf("trusted image = %q, %v", data, err)
	}
	if trustedCalls != 1 || externalCalls != 0 {
		t.Fatalf("trusted calls = %d, external calls = %d", trustedCalls, externalCalls)
	}
}

func TestTrustedXImageFetchURLUsesConfiguredWorker(t *testing.T) {
	parsed, err := url.Parse("https://img.koinote.app/u/alice/0123456789abcdef.png?cache=1#fragment")
	if err != nil {
		t.Fatal(err)
	}
	got := trustedXImageFetchURL(parsed, "http://host.docker.internal:8788", "https://koinote.app")
	if got.String() != "http://host.docker.internal:8788/images/u/alice/0123456789abcdef.png?cache=1" {
		t.Fatalf("trusted fetch URL = %q", got)
	}
}

func TestWriteXErrorPrioritizesImageFailure(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeXError(recorder, errors.Join(errXImageFailed, errXProviderUnavailable))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadGateway)
	}
	var response struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != "x_image_upload_failed" {
		t.Fatalf("error code = %q, want x_image_upload_failed", response.Code)
	}
}

func TestWriteXErrorIdentifiesUnavailableImageSource(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeXError(recorder, errors.Join(errXImageFailed, errXImageSourceUnavailable))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUnprocessableEntity)
	}
	var response struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != "x_image_source_unavailable" {
		t.Fatalf("error code = %q, want x_image_source_unavailable", response.Code)
	}
}

func TestReadXImageIdentifiesNotFoundSource(t *testing.T) {
	app := &App{xImageHTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader("missing")), Header: make(http.Header)}, nil
	})}}
	_, err := app.readXImage(context.Background(), "https://images.example/article.png")
	if !errors.Is(err, errXImageSourceUnavailable) {
		t.Fatalf("readXImage error = %v, want errXImageSourceUnavailable", err)
	}
}

func TestExchangeXOAuth2TokenUsesBasicClientAuthentication(t *testing.T) {
	var authorization string
	var body string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		authorization = request.Header.Get("Authorization")
		data, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		body = string(data)
		return jsonResponse(`{"access_token":"access","refresh_token":"refresh","expires_in":7200}`), nil
	})}
	app := &App{
		cfg:               config.Config{XOAuth2ClientID: "client-id", XOAuth2ClientSecret: "client-secret"},
		xOAuth2HTTPClient: client,
	}
	if _, err := app.exchangeXOAuth2Token(context.Background(), url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {"client-id"},
		"client_secret": {"client-secret"},
	}); err != nil {
		t.Fatal(err)
	}
	if authorization != "Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=" {
		t.Fatalf("authorization = %q, want HTTP Basic credentials", authorization)
	}
	if strings.Contains(body, "client_secret") {
		t.Fatalf("client_secret must not be sent in form body: %s", body)
	}
}

func TestAppendXOAuth2QueryRejectsExternalRedirect(t *testing.T) {
	got := appendXOAuth2Query("https://evil.example/steal", "x_oauth2", "connected")
	if !strings.HasPrefix(got, "/dashboard?") || !strings.Contains(got, "x_oauth2=connected") {
		t.Fatalf("external redirect was not reduced to a safe local path: %q", got)
	}
}

func TestCreateXTweetOAuth2UsesBearerToken(t *testing.T) {
	var authorization string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		authorization = request.Header.Get("Authorization")
		return jsonResponse(`{"data":{"id":"tweet-oauth2"}}`), nil
	})}
	app := &App{xOAuth2HTTPClient: client}
	id, err := app.createXTweetOAuth2(context.Background(), xOAuth2Credential{AccessToken: "oauth2-token"}, map[string]any{"text": "hello"})
	if err != nil || id != "tweet-oauth2" {
		t.Fatalf("create tweet = %q, %v", id, err)
	}
	if authorization != "Bearer oauth2-token" {
		t.Fatalf("authorization = %q, want bearer token", authorization)
	}
}

func TestUploadXImageOAuth2UsesJSONAndRetriesUnexpectedEOF(t *testing.T) {
	imageData := []byte{0xff, 0xd8, 0xff, 0xd9}
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return nil, io.ErrUnexpectedEOF
		}
		if request.Header.Get("Authorization") != "Bearer oauth2-token" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		if request.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("content type = %q", request.Header.Get("Content-Type"))
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]string
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["media_category"] != "tweet_image" || payload["media"] != base64.StdEncoding.EncodeToString(imageData) {
			t.Fatalf("media payload = %#v", payload)
		}
		return jsonResponse(`{"data":{"id":"media-oauth2"}}`), nil
	})}
	app := &App{xOAuth2HTTPClient: client}
	id, err := app.uploadXImageOAuth2(context.Background(), xOAuth2Credential{AccessToken: "oauth2-token"}, imageData)
	if err != nil || id != "media-oauth2" {
		t.Fatalf("uploaded media = %q, %v", id, err)
	}
	if calls != 2 {
		t.Fatalf("upload attempts = %d, want 2", calls)
	}
}

func TestPublishXArticleOAuth2CreatesDraftAndPublishes(t *testing.T) {
	type requestRecord struct {
		path          string
		authorization string
		body          string
	}
	var requests []requestRecord
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var body []byte
		if request.Body != nil {
			var err error
			body, err = io.ReadAll(request.Body)
			if err != nil {
				return nil, err
			}
		}
		requests = append(requests, requestRecord{
			path:          request.URL.Path,
			authorization: request.Header.Get("Authorization"),
			body:          string(body),
		})
		if request.URL.Path == xOAuth2ArticleDraftPath {
			response := jsonResponse(`{"data":{"id":"1146654567674912769","title":"Article title"}}`)
			response.StatusCode = http.StatusCreated
			return response, nil
		}
		if request.URL.Path == "/2/articles/1146654567674912769/publish" {
			return jsonResponse(`{"data":{"post_id":"1346889436626259968"}}`), nil
		}
		return nil, errors.New("unexpected X Article path")
	})}
	app := &App{xOAuth2HTTPClient: client}
	result, err := app.publishXArticleOAuth2(
		context.Background(),
		xOAuth2Credential{AccessToken: "oauth2-token"},
		"Article title",
		"## Section\n\nArticle body",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.DraftID != "1146654567674912769" || result.PublishedID != "1346889436626259968" || result.PostCount != 1 {
		t.Fatalf("unexpected Article result: %+v", result)
	}
	if result.URL != "https://x.com/i/status/1346889436626259968" {
		t.Fatalf("Article URL = %q", result.URL)
	}
	if len(requests) != 2 || requests[0].path != xOAuth2ArticleDraftPath || requests[1].path != "/2/articles/1146654567674912769/publish" {
		t.Fatalf("Article requests = %+v", requests)
	}
	if requests[0].authorization != "Bearer oauth2-token" || requests[1].authorization != "Bearer oauth2-token" {
		t.Fatalf("Article authorization headers = %+v", requests)
	}
	var draft map[string]any
	if err := json.Unmarshal([]byte(requests[0].body), &draft); err != nil {
		t.Fatal(err)
	}
	if draft["title"] != "Article title" {
		t.Fatalf("draft title = %#v", draft["title"])
	}
	contentState, ok := draft["content_state"].(map[string]any)
	if !ok {
		t.Fatalf("draft content_state = %#v", draft["content_state"])
	}
	entities, ok := contentState["entities"].([]any)
	if !ok || len(entities) != 1 {
		t.Fatalf("draft entities = %#v", contentState["entities"])
	}
}

func TestPublishXArticleOAuth2RejectsUnavailableImages(t *testing.T) {
	imageClient := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Body:       io.NopCloser(strings.NewReader("missing")),
			Header:     make(http.Header),
		}, nil
	})}
	apiClient := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("the provider must not be called when an image is unavailable")
	})}
	app := &App{xImageHTTPClient: imageClient, xOAuth2HTTPClient: apiClient}
	result, err := app.publishXArticleOAuth2(
		context.Background(),
		xOAuth2Credential{AccessToken: "oauth2-token"},
		"Article title",
		"Article body",
		[]xPublishImageInput{{Source: "https://images.example/missing.png"}},
	)
	if err == nil || !errors.Is(err, errXImageSourceUnavailable) {
		t.Fatalf("publish error = %v, want unavailable image error", err)
	}
	if result != (xPublishResult{}) {
		t.Fatalf("unexpected Article result: %+v", result)
	}
}

func TestBuildXArticleContentStateIncludesMarkdownAndImages(t *testing.T) {
	state := buildXArticleContentState("Body with **formatting**.", []xArticleMedia{{
		ID: "media-1", Caption: "Diagram",
	}})
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, expected := range []string{
		`"type":"markdown"`,
		`"markdown":"Body with **formatting**."`,
		`"type":"image"`,
		`"media_id":"media-1"`,
		`"caption":"Diagram"`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("Article content state missing %s: %s", expected, text)
		}
	}
	if got := normalizeXArticleMarkdown("---\ntitle: Hidden\n---\n\nText\n\n![Alt](https://example.test/a.png)"); got != "Text\n\nAlt" {
		t.Fatalf("normalized Article markdown = %q", got)
	}
}

func TestPublishXArticleOAuth2PreservesDraftOnPublishFailure(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == xOAuth2ArticleDraftPath {
			return jsonResponse(`{"data":{"id":"1146654567674912769","title":"Article title"}}`), nil
		}
		return &http.Response{
			StatusCode: http.StatusBadGateway,
			Body:       io.NopCloser(strings.NewReader(`{"error":"unavailable"}`)),
			Header:     make(http.Header),
		}, nil
	})}
	app := &App{xOAuth2HTTPClient: client}
	result, err := app.publishXArticleOAuth2(
		context.Background(),
		xOAuth2Credential{AccessToken: "oauth2-token"},
		"Article title",
		"Article body",
		nil,
	)
	if err == nil || !errors.Is(err, errXProviderUnavailable) {
		t.Fatalf("publish error = %v", err)
	}
	if result.DraftID != "1146654567674912769" || result.PublishedID != "" {
		t.Fatalf("partial Article result = %+v", result)
	}
}

func TestXArticlePublishingChargesAndReleasesFixedCredits(t *testing.T) {
	pool := newGCTestPool(t)
	tests := []struct {
		name          string
		failDraft     bool
		failPublish   bool
		credits       int64
		wantStatus    int
		wantCode      string
		wantBalance   int64
		wantDraftCall bool
	}{
		{name: "successful publish charges 20", credits: 20, wantStatus: http.StatusOK, wantBalance: 0, wantDraftCall: true},
		{name: "draft failure releases 20", credits: 20, failDraft: true, wantStatus: http.StatusBadGateway, wantCode: "x_provider_unavailable", wantBalance: 20, wantDraftCall: true},
		{name: "created draft charges 20 when publish fails", credits: 20, failPublish: true, wantStatus: http.StatusBadGateway, wantCode: "x_article_draft_only", wantBalance: 0, wantDraftCall: true},
		{name: "insufficient credits blocks provider calls", credits: 1, wantStatus: http.StatusPaymentRequired, wantCode: "insufficient_credits", wantBalance: 1, wantDraftCall: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := New(config.Config{
				SessionSecret:       "x-credit-test-session",
				InternalToken:       "x-credit-test-internal",
				XOAuth2ClientID:     "x-credit-test-client",
				XOAuth2ClientSecret: "x-credit-test-secret",
			}, pool)
			draftCalled := false
			app.xOAuth2HTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				switch request.URL.Path {
				case xOAuth2ArticleDraftPath:
					draftCalled = true
					if test.failDraft {
						return xErrorResponse(http.StatusBadGateway), nil
					}
					return jsonResponse(`{"data":{"id":"1146654567674912769"}}`), nil
				case "/2/articles/1146654567674912769/publish":
					if test.failPublish {
						return xErrorResponse(http.StatusBadGateway), nil
					}
					return jsonResponse(`{"data":{"post_id":"1346889436626259968"}}`), nil
				default:
					return nil, errors.New("unexpected X Article path")
				}
			})}
			user := seedMCPUser(t, pool, app, membershipTierLifetime)
			grantCreditsForTest(t, pool, user.ID, test.credits, "x-article-publish")
			var profile xOAuth2ProfileResponse
			profile.Data.ID = "123456789"
			profile.Data.Username = "koinote_test"
			if err := app.storeXOAuth2Credential(context.Background(), user.ID, xOAuth2TokenResponse{
				AccessToken: "oauth2-token", RefreshToken: "refresh-token", ExpiresIn: 3600, Scope: xOAuth2Scopes,
			}, profile); err != nil {
				t.Fatalf("store X OAuth2 credential: %v", err)
			}
			doc, err := app.createDocument(context.Background(), createDocumentParams{
				User: user, Title: "Credit test", Content: "Article body",
			})
			if err != nil {
				t.Fatalf("create document: %v", err)
			}
			request := httptest.NewRequest(
				http.MethodPost,
				"/api/documents/"+doc.DocID+"/x/publish",
				strings.NewReader(`{"mode":"oauth2","title":"Credit test","markdown":"Article body"}`),
			)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("x-koinote-internal-token", "x-credit-test-internal")
			request.Header.Set("X-Auth-User-Id", user.AuthUserID)
			response := httptest.NewRecorder()
			app.Routes().ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("publish status=%d want=%d body=%s", response.Code, test.wantStatus, response.Body.String())
			}
			if draftCalled != test.wantDraftCall {
				t.Fatalf("draft called=%v want=%v", draftCalled, test.wantDraftCall)
			}
			if test.wantCode != "" {
				var payload struct {
					Code string `json:"code"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
					t.Fatalf("decode publish error: %v", err)
				}
				if payload.Code != test.wantCode {
					t.Fatalf("publish code=%q want=%q", payload.Code, test.wantCode)
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

func xErrorResponse(status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(`{"error":"unavailable"}`)),
	}
}

func TestXCredentialEncryptionRoundTripAndAAD(t *testing.T) {
	app := &App{cfg: config.Config{SessionSecret: "test-session-secret"}}
	ciphertext, err := app.encryptXCredential(42, "api-secret", "secret-value")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(ciphertext, []byte("secret-value")) {
		t.Fatal("credential must not be stored as plaintext")
	}
	plaintext, err := app.decryptXCredential(42, "api-secret", ciphertext)
	if err != nil || plaintext != "secret-value" {
		t.Fatalf("decrypt = %q, %v", plaintext, err)
	}
	if _, err := app.decryptXCredential(43, "api-secret", ciphertext); err == nil {
		t.Fatal("credential decryption must bind the user ID in AAD")
	}
	if _, err := app.decryptXCredential(42, "access-token", ciphertext); err == nil {
		t.Fatal("credential decryption must bind the field in AAD")
	}
}

func TestPublishXThreadUploadsImagesAndReplies(t *testing.T) {
	var imageBytes bytes.Buffer
	if err := jpeg.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 2, 2)), &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	imageData := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(imageBytes.Bytes())

	type requestRecord struct {
		url  string
		body string
	}
	var requests []requestRecord
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		requests = append(requests, requestRecord{url: request.URL.String(), body: string(body)})
		if request.URL.String() == xMediaUploadURL {
			return jsonResponse(`{"media_id_string":"media-1"}`), nil
		}
		if strings.Contains(string(body), `"in_reply_to_tweet_id":"tweet-1"`) {
			return jsonResponse(`{"data":{"id":"tweet-2"}}`), nil
		}
		return jsonResponse(`{"data":{"id":"tweet-1"}}`), nil
	})}
	app := &App{xAPIHTTPClient: client}
	result, err := app.publishXThread(context.Background(), xCredential{
		APIKey: "key", APISecret: "secret", AccessToken: "token", AccessTokenSecret: "token-secret",
	}, []string{"first", "second"}, map[int][]xPublishImageInput{
		0: {{PostIndex: 0, Source: imageData}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.PostCount != 2 || result.PublishedID != "tweet-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(requests) != 3 {
		t.Fatalf("request count = %d, want image upload plus two tweets", len(requests))
	}
	if !strings.Contains(requests[1].body, `"media":{"media_ids":["media-1"]}`) {
		t.Fatalf("first tweet did not include uploaded media: %s", requests[1].body)
	}
	if !strings.Contains(requests[2].body, `"reply":{"in_reply_to_tweet_id":"tweet-1"}`) {
		t.Fatalf("second tweet did not reply to first: %s", requests[2].body)
	}
}

func TestPublishXThreadRejectsUnavailableImages(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "https://images.example/missing.png" {
			return nil, errors.New("unexpected image request")
		}
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Body:       io.NopCloser(strings.NewReader("missing")),
			Header:     make(http.Header),
		}, nil
	})}
	app := &App{xImageHTTPClient: client}
	result, err := app.publishXThreadWith(
		context.Background(),
		[]string{"article text"},
		map[int][]xPublishImageInput{0: {{PostIndex: 0, Source: "https://images.example/missing.png"}}},
		func(context.Context, []byte) (string, error) {
			return "", errors.New("unavailable image must not be uploaded")
		},
		func(context.Context, map[string]any) (string, error) {
			return "tweet-1", nil
		},
	)
	if err == nil || !errors.Is(err, errXImageSourceUnavailable) {
		t.Fatalf("publish error = %v, want unavailable image error", err)
	}
	if result.PostCount != 0 || result.PublishedID != "" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestPublishXThreadReportsPartialProgress(t *testing.T) {
	created := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != xAPIBaseURL+xTweetPath {
			return nil, errors.New("unexpected request")
		}
		created++
		if created == 2 {
			return &http.Response{
				StatusCode: http.StatusBadRequest,
				Body:       io.NopCloser(strings.NewReader(`{"errors":[{"message":"rejected"}]}`)),
				Header:     make(http.Header),
			}, nil
		}
		return jsonResponse(`{"data":{"id":"tweet-1"}}`), nil
	})}
	app := &App{xAPIHTTPClient: client}
	result, err := app.publishXThread(context.Background(), xCredential{
		APIKey: "key", APISecret: "secret", AccessToken: "token", AccessTokenSecret: "token-secret",
	}, []string{"first", "second"}, nil)
	if err == nil || !errors.Is(err, errXPublishFailed) {
		t.Fatalf("publish error = %v, want X publish failure", err)
	}
	if result.PostCount != 1 {
		t.Fatalf("published count = %d, want 1", result.PostCount)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func jsonResponse(body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}
