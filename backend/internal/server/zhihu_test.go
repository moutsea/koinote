package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestZhihuOpenAPISignature(t *testing.T) {
	const want = "cKn71WOazlaMK9HeEBl25zBklHKS1ccIn9sB6izy9j4="
	if got := zhihuOpenAPISignature("test-key", "1700000000", "log-1", "", "test-secret"); got != want {
		t.Fatalf("signature = %q, want %q", got, want)
	}
}

func TestZhihuCredentialEncryptionUsesUserAAD(t *testing.T) {
	app := &App{cfg: config.Config{ZhihuCredentialEncryptionKey: "zhihu-test-key"}}
	ciphertext, err := app.encryptZhihuCredential(42, "zh-secret")
	if err != nil {
		t.Fatalf("encrypt credential: %v", err)
	}
	if bytes.Contains(ciphertext, []byte("zh-secret")) {
		t.Fatal("ciphertext contains plaintext AppSecret")
	}
	plain, err := app.decryptZhihuCredential(42, ciphertext)
	if err != nil || plain != "zh-secret" {
		t.Fatalf("decrypt credential = %q, %v", plain, err)
	}
	if _, err := app.decryptZhihuCredential(43, ciphertext); err == nil {
		t.Fatal("credential decrypted with the wrong user ID")
	}
}

func TestZhihuCredentialEncryptionDevelopmentFallback(t *testing.T) {
	app := &App{cfg: config.Config{SessionSecret: "session-secret"}}
	ciphertext, err := app.encryptZhihuCredential(1, "secret")
	if err != nil {
		t.Fatalf("development fallback encryption failed: %v", err)
	}
	if got, err := app.decryptZhihuCredential(1, ciphertext); err != nil || got != "secret" {
		t.Fatalf("development fallback decryption = %q, %v", got, err)
	}

	production := &App{cfg: config.Config{NodeEnv: "production", SessionSecret: "session-secret"}}
	if _, err := production.encryptZhihuCredential(1, "secret"); err == nil {
		t.Fatal("production unexpectedly fell back to SESSION_SECRET")
	}
}

func TestPublishZhihuArticleRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != zhihuPublishPath {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		for _, header := range []string{"X-App-Key", "X-Timestamp", "X-Log-Id", "X-Extra-Info", "X-Sign"} {
			if r.Header.Get(header) == "" && header != "X-Extra-Info" {
				t.Errorf("missing %s header", header)
			}
		}
		if _, ok := r.Header["X-Extra-Info"]; !ok {
			t.Error("X-Extra-Info must be sent even when empty")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		content, _ := body["content"].(map[string]any)
		if body["type"] != "article" || body["confirmed"] != true ||
			content["title"] != "Title" || content["html"] != "<p>Body</p>" {
			t.Fatalf("unexpected request body: %+v", body)
		}
		_, _ = w.Write([]byte("{\"status\":0,\"msg\":\"success\",\"data\":{\"content_token\":\"token-1\",\"url\":\"https://zhuanlan.zhihu.com/p/123\"}}"))
	}))
	defer server.Close()

	app := &App{
		zhihuAPIHTTPClient: server.Client(),
		zhihuAPIBaseURL:    server.URL,
	}
	result, err := app.publishZhihuArticle(
		context.Background(),
		zhihuCredential{AppKey: "test-key", AppSecret: "test-secret"},
		"Title",
		"<p>Body</p>",
	)
	if err != nil {
		t.Fatalf("publish article: %v", err)
	}
	if result.Status == nil || *result.Status != 0 || result.Data.ContentToken != "token-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestPublishZhihuArticleRejectsProviderFailureAndUnsafeURL(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "provider status",
			body: "{\"status\":1,\"msg\":\"rejected\",\"data\":null}",
		},
		{
			name: "unsafe URL",
			body: "{\"status\":0,\"msg\":\"success\",\"data\":{\"url\":\"javascript:alert(1)\"}}",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			app := &App{zhihuAPIHTTPClient: server.Client(), zhihuAPIBaseURL: server.URL}
			_, err := app.publishZhihuArticle(
				context.Background(),
				zhihuCredential{AppKey: "test-key", AppSecret: "test-secret"},
				"Title",
				"<p>Body</p>",
			)
			if err == nil || !strings.Contains(err.Error(), "zhihu article publish failed") {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestValidZhihuPublishedURL(t *testing.T) {
	for _, raw := range []string{
		"https://zhuanlan.zhihu.com/p/123",
		"https://www.zhihu.com/question/123",
		"https://zhihu.com/p/123?x=1",
	} {
		if !validZhihuPublishedURL(raw) {
			t.Errorf("valid URL rejected: %s", raw)
		}
	}
	for _, raw := range []string{
		"",
		"http://zhuanlan.zhihu.com/p/123",
		"javascript:alert(1)",
		"https://evil.com/p/123",
		"https://zhihu.com.evil.com/p/123",
		"https://user:pass@zhihu.com/p/123",
	} {
		if validZhihuPublishedURL(raw) {
			t.Errorf("unsafe URL accepted: %s", raw)
		}
	}
}

func TestZhihuImageTagPattern(t *testing.T) {
	for _, html := range []string{
		`<p><img src="https://example.com/image.png"></p>`,
		"<p><IMG\tsrc='https://example.com/image.png'></p>",
		`<img/>`,
		`<img />`,
	} {
		if !zhihuImageTagPattern.MatchString(html) {
			t.Errorf("image tag was not rejected: %q", html)
		}
	}
	for _, html := range []string{
		`<p>an escaped &lt;img src="https://example.com/image.png"&gt;</p>`,
		`<p>text without media</p>`,
	} {
		if zhihuImageTagPattern.MatchString(html) {
			t.Errorf("non-image HTML was rejected: %q", html)
		}
	}
}
