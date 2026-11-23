package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func TestDocumentCountIncludesEmptyDocumentsAndTrash(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{SessionSecret: "document-count-test", ImageQuotaBytes: 1, DocumentCountLimit: 2}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	ctx := context.Background()
	var docs []model.Document
	for i := 0; i < 2; i++ {
		w := writingTestRequest(t, a, user, "POST", "/api/documents", map[string]any{})
		if w.Code != 200 {
			t.Fatalf("empty document create: %d %s", w.Code, w.Body.String())
		}
		var result struct {
			Document model.Document `json:"document"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		docs = append(docs, result.Document)
	}
	assertFull := func() {
		t.Helper()
		w := writingTestRequest(t, a, user, "POST", "/api/documents", map[string]any{})
		if w.Code != 409 || decodeErrorCode(t, w) != "document_count_limit_reached" {
			t.Fatalf("count cap bypass: %d %s", w.Code, w.Body.String())
		}
	}
	assertFull()
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.Total() != 0 {
		t.Fatalf("empty document premise: bytes=%d err=%v", usage.Total(), err)
	}
	if _, err := a.trashDocument(ctx, user, docs[0].DocID, docs[0].Revision); err != nil {
		t.Fatal(err)
	}
	assertFull()
	if _, err := a.restoreTrashedDocument(ctx, user, docs[0].DocID, 0); err != nil {
		t.Fatal("count cap prevented restoring an existing document:", err)
	}
	if _, err := a.updateDocument(ctx, updateDocumentParams{User: user, DocID: docs[1].DocID, Theme: docs[1].Theme, Content: "x", ExpectedRevision: docs[1].Revision}); err != nil {
		t.Fatal("count cap prevented editing an existing document:", err)
	}
	if _, err := a.trashDocument(ctx, user, docs[0].DocID, 0); err != nil {
		t.Fatal(err)
	}
	if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, docs[0].DocID, "DELETE", true, false); err != nil {
		t.Fatal(err)
	}
	if w := writingTestRequest(t, a, user, "POST", "/api/documents", map[string]any{}); w.Code != 200 {
		t.Fatalf("permanent deletion did not release count: %d %s", w.Code, w.Body.String())
	}
}

func TestDocumentCreateConcurrencyAndReplayAtLimits(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{SessionSecret: "document-concurrency", DocumentCountLimit: 3}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := a.createDocument(context.Background(), createDocumentParams{User: user})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil && !errors.Is(err, errDocumentCountLimit) && !errors.Is(err, errDocumentCreateRateLimited) {
			t.Fatal(err)
		}
	}
	var count int
	var docID string
	if err := pool.QueryRow(context.Background(), `SELECT count(*),min(doc_id) FROM documents WHERE user_id=$1`, user.ID).Scan(&count, &docID); err != nil || count != 3 {
		t.Fatalf("concurrent cap: count=%d err=%v", count, err)
	}
	a.rateLimit().entries["document-create:user:"+strconv.Itoa(user.ID)] = &rateEntry{count: documentCreateUserLimit, expiresAt: time.Now().Add(time.Minute)}
	doc, err := a.createDocument(context.Background(), createDocumentParams{User: user, DocID: docID})
	if err != nil || doc.DocID != docID {
		t.Fatalf("desktop replay failed at count/rate cap: %v", err)
	}
	if _, err := a.createDocument(context.Background(), createDocumentParams{User: user, DocID: docID, Content: "different"}); !errors.Is(err, errDocumentIDConflict) {
		t.Fatalf("mismatched replay overwrote data: %v", err)
	}
	// Agent operations enter the transaction helper directly.
	a.rateLimit().reset("document-create:user:" + strconv.Itoa(user.ID))
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := a.createDocumentTx(context.Background(), tx, createDocumentParams{User: user}); !errors.Is(err, errDocumentCountLimit) {
		t.Fatalf("transaction helper bypassed count limit: %v", err)
	}
}

func TestDocumentCreateRateLimitResponse(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	for _, scope := range []string{"user", "global"} {
		t.Run(scope, func(t *testing.T) {
			a := New(config.Config{SessionSecret: "document-rate-test"}, pool)
			user := loadAgentReviewTestUser(t, a, pool, userID)
			key, limit := "document-create:global", documentCreateGlobalLimit
			if scope == "user" {
				key, limit = "document-create:user:"+strconv.Itoa(user.ID), documentCreateUserLimit
			}
			a.rateLimit().entries[key] = &rateEntry{count: limit, expiresAt: time.Now().Add(time.Minute)}
			w := writingTestRequest(t, a, user, "POST", "/api/documents", map[string]any{})
			if w.Code != 429 || w.Header().Get("Retry-After") != "60" || decodeErrorCode(t, w) != "too_many_requests" {
				t.Fatalf("rate response: %d %s", w.Code, w.Body.String())
			}
			var count int
			if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM documents WHERE user_id=$1`, user.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("rejected create persisted data: %d %v", count, err)
			}
		})
	}
}

func TestMCPCreateDocumentCountLimit(t *testing.T) {
	pool := newGCTestPool(t)
	a := New(config.Config{SessionSecret: "mcp-count-limit", DocumentCountLimit: 1}, pool)
	user := seedMCPUser(t, pool, a, membershipTierLifetime)
	server := httptest.NewServer(a.Routes())
	defer server.Close()
	token := createMCPTokenForTest(t, server, mcpSessionCookie(a, user.AuthUserID), "count-limit", "write")
	client, err := connectMCPClient(context.Background(), server.URL+"/mcp", token.Secret)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for i := 0; i < 2; i++ {
		result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: "create_document", Arguments: map[string]any{"title": "Count limit", "content": ""}})
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 && result.IsError {
			t.Fatal("first MCP create failed")
		}
		if i == 1 {
			raw, _ := json.Marshal(result)
			if !result.IsError || !strings.Contains(string(raw), "document count limit") || !strings.Contains(string(raw), "trash") {
				t.Fatalf("MCP hid or bypassed count limit: %s", raw)
			}
		}
	}
}
