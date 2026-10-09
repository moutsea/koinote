package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestWechatCoverReferenceValidationAndCredits(t *testing.T) {
	raw := testWechatCoverJPEG(t)
	source := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(raw)
	for _, input := range []string{"https://127.0.0.1/private", "https://images.example/reference.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,not_base64", "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("not an image")), "data:image/jpeg;base64," + strings.Repeat("A", base64.StdEncoding.EncodedLen(wechatCoverReferenceMaxBytes)+4)} {
		if _, err := prepareWechatCoverReference(input); err == nil {
			t.Fatal("unsafe reference accepted")
		}
	}
	prepared, err := prepareWechatCoverReference(source)
	if err != nil || !bytes.HasPrefix(prepared, []byte{0xff, 0xd8}) {
		t.Fatal("valid reference was not normalized to JPEG", err)
	}
	app, pool, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "reference-image", WechatCoverImageBaseURL: "https://cover-provider.example/v1", WechatCoverImageAPIKey: "cover-key", WechatCoverImageModel: "configured-model"})
	if _, err = pool.Exec(context.Background(), `UPDATE users SET is_admin=true WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	grantCreditsForTest(t, pool, user.ID, 40, "cover-reference")
	calls := 0
	fail := false
	app.wechatCoverHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Path != "/v1/images/edits" || req.Header.Get("Authorization") != "Bearer cover-key" {
			t.Fatal("incorrect image edit endpoint")
		}
		if err := req.ParseMultipartForm(2 << 20); err != nil {
			t.Fatal(err)
		}
		defer req.MultipartForm.RemoveAll()
		if req.FormValue("model") != "configured-model" || req.FormValue("n") != "1" || !strings.Contains(req.FormValue("prompt"), "reference image") {
			t.Fatal("incorrect edit fields")
		}
		file, header, err := req.FormFile("image[]")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		data, err := io.ReadAll(file)
		if err != nil || !bytes.Equal(data, prepared) || header.Header.Get("Content-Type") != "image/jpeg" {
			t.Fatal("reference upload was corrupted", err)
		}
		if fail {
			return &http.Response{StatusCode: 400, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("unsupported edits"))}, nil
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(raw) + `"}]}`))}, nil
	})}
	payload, _ := json.Marshal(map[string]any{"prompt": "A calm writing desk", "ratio": "3:2", "referenceImageSource": source})
	res := requestWechatCoverGenerate(t, app, user, string(payload))
	if res.Code != 200 {
		t.Fatalf("reference generation %d %s", res.Code, res.Body.String())
	}
	balance, err := app.loadCreditBalance(context.Background(), user.ID)
	if err != nil || balance.Balance != 20 || balance.Reserved != 0 {
		t.Fatal("successful edit should charge the existing fixed fee", err)
	}
	fail = true
	res = requestWechatCoverGenerate(t, app, user, string(payload))
	if res.Code != 502 {
		t.Fatal("provider edit rejection was not surfaced", res.Code)
	}
	balance, err = app.loadCreditBalance(context.Background(), user.ID)
	if err != nil || balance.Balance != 20 || balance.Reserved != 0 {
		t.Fatal("failed image edit did not release credits", err)
	}
	payload, _ = json.Marshal(map[string]any{"prompt": "Desk", "ratio": "1:1", "referenceImageSource": "https://127.0.0.1/private"})
	res = requestWechatCoverGenerate(t, app, user, string(payload))
	if res.Code != 400 || calls != 2 {
		t.Fatal("remote reference caused a model request")
	}
}

type coverBodyReadTracker struct{ reads int }

func (b *coverBodyReadTracker) Read([]byte) (int, error) { b.reads++; return 0, io.EOF }
func (*coverBodyReadTracker) Close() error               { return nil }

func TestWechatCoverRateLimitDoesNotReadBody(t *testing.T) {
	app, pool, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "cover-limit", WechatCoverImageBaseURL: "https://cover.example/v1", WechatCoverImageAPIKey: "key", WechatCoverImageModel: "model"})
	if _, err := pool.Exec(context.Background(), `UPDATE users SET is_admin=true WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	for range wechatCoverGenerateLimit {
		app.rateLimit().allow("wechat-cover:"+strconv.Itoa(user.ID), wechatCoverGenerateLimit, wechatCoverGenerateWindow)
	}
	body := &coverBodyReadTracker{}
	req := httptest.NewRequest("POST", "/api/wechat/cover/generate", body)
	req.ContentLength = wechatCoverGenerateRequestBytes
	req.AddCookie(sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion))
	res := httptest.NewRecorder()
	app.Routes().ServeHTTP(res, req)
	if res.Code != 429 || body.reads != 0 {
		t.Fatalf("limited request read large body: status=%d reads=%d", res.Code, body.reads)
	}
}
