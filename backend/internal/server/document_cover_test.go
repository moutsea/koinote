package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func TestDocumentCoverValidation(testRunner *testing.T) {
	for _, test := range []struct {
		name   string
		mode   string
		source string
		prompt string
	}{
		{name: "oversized source", source: strings.Repeat("x", maxDocumentCoverSourceBytes+1)},
		{name: "embedded data", source: "data:image/png;base64,Y292ZXI="},
		{name: "uppercase data", source: " DATA:image/png;base64,Y292ZXI= "},
		{name: "oversized prompt", mode: "ai", prompt: strings.Repeat("图", wechatCoverPromptMaxRunes+1)},
		{name: "missing article image", mode: "article"},
	} {
		testRunner.Run(test.name, func(testRunner *testing.T) {
			_, err := (&App{}).createDocument(context.Background(), createDocumentParams{
				Title: "Cover", CoverMode: test.mode, CoverImageSource: test.source, CoverPrompt: test.prompt,
			})
			if !errors.Is(err, errDocumentCoverInvalid) {
				testRunner.Fatalf("create error = %v, want invalid cover", err)
			}
		})
	}
}

func TestDocumentCoverStorageQuota(testRunner *testing.T) {
	pool := newGCTestPool(testRunner)
	reference, _ := seedGCUser(testRunner, pool, "cover-quota-review", "body")
	user := model.User{ID: reference.ID, AuthUserID: reference.AuthUserID}
	app := New(config.Config{ImageQuotaBytes: 4096}, pool)
	ctx := context.Background()
	before, err := app.storageUsageFor(ctx, user.ID)
	if err != nil {
		testRunner.Fatal(err)
	}
	source := "https://example.test/" + strings.Repeat("x", maxDocumentCoverSourceBytes-len("https://example.test/"))
	doc, err := app.createDocument(ctx, createDocumentParams{
		User: user, Title: "Cover", Content: "Body", CoverMode: "ai", CoverRatio: "3:2", CoverImageSource: source, CoverPrompt: "封面",
	})
	if err != nil {
		testRunner.Fatalf("create at source size limit: %v", err)
	}
	usage, err := app.storageUsageFor(ctx, user.ID)
	if err != nil {
		testRunner.Fatal(err)
	}
	wantBytes := before.DocumentBytes + int64(len(doc.Title)+len(doc.Content)+len(source)+len("封面"))
	if usage.DocumentBytes != wantBytes {
		testRunner.Fatalf("document bytes = %d, want %d", usage.DocumentBytes, wantBytes)
	}
	app.cfg.ImageQuotaBytes = usage.Total() + int64(len("new"))
	_, err = app.createDocument(ctx, createDocumentParams{User: user, Title: "new", CoverImageSource: "https://example.test/new.png"})
	if !errors.Is(err, errDocumentQuotaExceeded) {
		testRunner.Fatalf("create must count cover metadata: %v", err)
	}
	prompt := "封面更加详细"
	_, err = app.updateDocument(ctx, updateDocumentParams{
		User: user, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme, Content: doc.Content,
		ExpectedRevision: doc.Revision, CoverPrompt: &prompt,
	})
	if !errors.Is(err, errDocumentQuotaExceeded) {
		testRunner.Fatalf("update must count cover metadata: %v", err)
	}
	app.cfg.ImageQuotaBytes = 1
	smallerSource := "https://example.test/small.png"
	updated, err := app.updateDocument(ctx, updateDocumentParams{
		User: user, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme, Content: doc.Content,
		ExpectedRevision: doc.Revision, CoverImageSource: &smallerSource,
	})
	if err != nil {
		testRunner.Fatalf("shrinking cover while over quota must succeed: %v", err)
	}
	usage, err = app.storageUsageFor(ctx, user.ID)
	if err != nil || usage.DocumentBytes != wantBytes-int64(len(source)-len(smallerSource)) {
		testRunner.Fatalf("updated usage = %+v, error = %v", usage, err)
	}
	invalid := "data:image/png;base64,Y292ZXI="
	_, err = app.updateDocument(ctx, updateDocumentParams{
		User: user, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme, Content: doc.Content,
		ExpectedRevision: updated.Revision, CoverImageSource: &invalid,
	})
	if !errors.Is(err, errDocumentCoverInvalid) {
		testRunner.Fatalf("update must reject embedded data: %v", err)
	}
}

func TestDocumentCoverHTTPBoundaries(testRunner *testing.T) {
	pool := newGCTestPool(testRunner)
	user, docID := seedGCUser(testRunner, pool, "cover-http-review", "body")
	app := New(config.Config{InternalToken: "cover-review-internal"}, pool)
	routes := app.Routes()
	request := func(method, path string, body map[string]any) *httptest.ResponseRecorder {
		testRunner.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			testRunner.Fatal(err)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		req.Header.Set("X-Koinote-Internal-Token", "cover-review-internal")
		req.Header.Set("X-Auth-User-Id", user.AuthUserID)
		response := httptest.NewRecorder()
		routes.ServeHTTP(response, req)
		return response
	}
	for _, method := range []string{http.MethodPost, http.MethodPut} {
		path := "/api/documents"
		if method == http.MethodPut {
			path += "/" + docID
		}
		for _, test := range []struct {
			source string
			status int
		}{
			{strings.Repeat("x", maxDocumentRequestBytes+1), http.StatusRequestEntityTooLarge},
			{strings.Repeat("x", maxDocumentCoverSourceBytes+1), http.StatusBadRequest},
			{"data:image/png;base64,Y292ZXI=", http.StatusBadRequest},
		} {
			response := request(method, path, map[string]any{
				"title": "Title", "content": "Body", "expectedRevision": 1, "coverImageSource": test.source,
			})
			if response.Code != test.status {
				testRunner.Fatalf("%s status = %d, want %d: %s", method, response.Code, test.status, response.Body.String())
			}
		}
	}
	response := request(http.MethodPost, "/api/documents", map[string]any{"title": "Escaped", "content": strings.Repeat("\x01", maxContentBytes)})
	if response.Code != http.StatusOK {
		testRunner.Fatalf("legal JSON escaping must fit: HTTP %d", response.Code)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE documents SET cover_mode = 'article', cover_image_source = 'https://example.test/cover.png' WHERE doc_id = $1`, docID); err != nil {
		testRunner.Fatal(err)
	}
	response = request(http.MethodPut, "/api/documents/"+docID, map[string]any{
		"title": "Title", "content": "Body", "expectedRevision": 1, "coverRatio": "3:2",
	})
	if response.Code != http.StatusOK {
		testRunner.Fatalf("partial cover update: %d %s", response.Code, response.Body.String())
	}
	var result struct {
		Document model.Document `json:"document"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		testRunner.Fatal(err)
	}
	if result.Document.CoverMode != "article" || result.Document.CoverImageSource != "https://example.test/cover.png" || result.Document.CoverRatio != "3:2" {
		testRunner.Fatalf("partial update lost stored fields: %+v", result.Document)
	}
}
