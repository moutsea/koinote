package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"koinote/backend/internal/config"
)

func TestFeishuSyncConcurrencyPreservesDatabaseCapacity(test *testing.T) {
	seedPool := newGCTestPool(test)
	poolConfig := seedPool.Config()
	poolConfig.MaxConns = 10
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		test.Fatal(err)
	}
	defer pool.Close()
	app := New(config.Config{InternalToken: "test-internal", FeishuClientID: "cli_test", FeishuClientSecret: "test-secret", FeishuCredentialEncryptionKey: "test-key"}, pool)
	var requests []*http.Request
	for index := 0; index < 10; index++ {
		user, documentID := seedGCUser(test, seedPool, "feishu-concurrency-"+strconv.Itoa(index), "Content")
		if _, err := seedPool.Exec(context.Background(), `UPDATE users SET membership_tier='lifetime' WHERE id=$1`, user.ID); err != nil {
			test.Fatal(err)
		}
		connection, release, err := app.lockFeishuAccount(context.Background(), user.ID)
		if err != nil {
			test.Fatal(err)
		}
		err = app.storeFeishuCredential(context.Background(), connection, user.ID, feishuTokenResponse{AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 3600}, feishuAccountView{OpenID: "ou_test", Name: "Test user"})
		release()
		if err != nil {
			test.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/documents/"+documentID+"/feishu-sync", nil)
		request.Header.Set("X-Koinote-Internal-Token", "test-internal")
		request.Header.Set("X-Auth-User-Id", user.AuthUserID)
		requests = append(requests, request)
	}
	entered := make(chan struct{}, len(requests))
	releaseProvider := make(chan struct{})
	var unblock sync.Once
	defer unblock.Do(func() { close(releaseProvider) })
	app.feishuDocsHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		entered <- struct{}{}
		select {
		case <-releaseProvider:
		case <-request.Context().Done():
		}
		return nil, errors.New("simulated provider failure")
	})}
	finished := make(chan *httptest.ResponseRecorder, len(requests))
	routes := app.Routes()
	for _, request := range requests {
		go func(request *http.Request) {
			recorder := httptest.NewRecorder()
			routes.ServeHTTP(recorder, request)
			finished <- recorder
		}(request)
	}
	timeout := time.NewTimer(10 * time.Second)
	defer timeout.Stop()
	active, rejected := 0, 0
	for active < feishuAccountConcurrency || rejected < len(requests)-feishuAccountConcurrency {
		select {
		case <-entered:
			active++
			if active > feishuAccountConcurrency {
				test.Fatal("too many requests reached the provider")
			}
		case response := <-finished:
			if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "feishu_server_busy") {
				test.Fatalf("unexpected rejection: %d %s", response.Code, response.Body.String())
			}
			rejected++
		case <-timeout.C:
			test.Fatalf("concurrency admission stalled: active=%d rejected=%d", active, rejected)
		}
	}
	queryContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var result int
	if err := pool.QueryRow(queryContext, `SELECT 1`).Scan(&result); err != nil || result != 1 {
		test.Fatalf("ordinary query blocked by Feishu requests: %v", err)
	}
	unblock.Do(func() { close(releaseProvider) })
	for index := 0; index < active; index++ {
		select {
		case response := <-finished:
			if response.Code != http.StatusBadGateway {
				test.Fatalf("unexpected provider failure response: %d", response.Code)
			}
		case <-timeout.C:
			test.Fatal("sync did not finish after provider failure")
		}
	}
	retry := httptest.NewRecorder()
	routes.ServeHTTP(retry, requests[0].Clone(context.Background()))
	if retry.Code != http.StatusBadGateway {
		test.Fatalf("sync slot was not released after failure: %d %s", retry.Code, retry.Body.String())
	}
}

func TestFeishuAccountSlotsReleasedAfterLockErrors(test *testing.T) {
	pool := newGCTestPool(test)
	app := New(config.Config{}, pool)
	_, release, err := app.lockFeishuAccount(context.Background(), 1)
	if err != nil {
		test.Fatal(err)
	}
	defer release()
	for attempt := 0; attempt < feishuAccountConcurrency*2; attempt++ {
		if _, unexpectedRelease, err := app.lockFeishuAccount(context.Background(), 1); err == nil {
			unexpectedRelease()
			test.Fatal("acquired a second lock for the same account")
		} else if !errors.Is(err, errFeishuBusy) {
			test.Fatalf("unexpected lock contention error: %v", err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, unexpectedRelease, err := app.lockFeishuAccount(ctx, 2); err == nil {
			unexpectedRelease()
			test.Fatal("acquired an account lock with a cancelled context")
		} else if !errors.Is(err, context.Canceled) {
			test.Fatalf("unexpected cancellation error: %v", err)
		}
	}
	_, releaseOther, err := app.lockFeishuAccount(context.Background(), 2)
	if err != nil {
		test.Fatalf("failed lock attempts leaked concurrency slots: %v", err)
	}
	releaseOther()
}

func TestFeishuOAuthDesktopStartRejectsOversizedState(t *testing.T) {
	app := &App{cfg: config.Config{
		FeishuClientID:                "cli_test",
		FeishuClientSecret:            "secret",
		FeishuCredentialEncryptionKey: "test-key",
	}}
	request := httptest.NewRequest(http.MethodGet, "/api/feishu/oauth/desktop-start?state="+url.QueryEscape(strings.Repeat("a", 129)), nil)
	recorder := httptest.NewRecorder()
	app.feishuOAuthDesktopStart(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("oversized state status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestFeishuCredentialEncryptionRoundTrip(t *testing.T) {
	app := &App{cfg: config.Config{FeishuCredentialEncryptionKey: "test-secret"}}
	ciphertext, err := app.encryptFeishuCredential(42, "access", "access-token")
	if err != nil {
		t.Fatalf("encryptFeishuCredential() error = %v", err)
	}
	if string(ciphertext) == "access-token" {
		t.Fatal("credential ciphertext must not contain plaintext")
	}
	plaintext, err := app.decryptFeishuCredential(42, "access", ciphertext)
	if err != nil || plaintext != "access-token" {
		t.Fatalf("decryptFeishuCredential() = %q, %v", plaintext, err)
	}
	if _, err = app.decryptFeishuCredential(43, "access", ciphertext); err == nil {
		t.Fatal("decrypting with another user must fail")
	}
	if _, err = app.decryptFeishuCredential(42, "refresh", ciphertext); err == nil {
		t.Fatal("decrypting as another field must fail")
	}
	ciphertext[len(ciphertext)-1] ^= 1
	if _, err = app.decryptFeishuCredential(42, "access", ciphertext); err == nil {
		t.Fatal("tampered credentials must fail")
	}
}

func TestPrepareFeishuBatchesPreservesOrderAndNestedTrees(t *testing.T) {
	converted := feishuConversion{}
	for index := 0; index < 2001; index++ {
		blockID := strconv.Itoa(index)
		converted.Roots = append(converted.Roots, blockID)
		converted.Blocks = append(converted.Blocks, map[string]any{"block_id": blockID, "block_type": 2, "children": nil})
	}
	batches, err := prepareFeishuBatches(converted)
	if err != nil || len(batches) != 3 {
		t.Fatalf("batching: %d batches, %v", len(batches), err)
	}
	var roots []string
	for _, batch := range batches {
		if len(batch.Blocks) > 1000 {
			t.Fatal("batch exceeds provider limit")
		}
		roots = append(roots, batch.Roots...)
	}
	if !slices.Equal(roots, converted.Roots) {
		t.Fatal("batching changed document order")
	}
	converted.Roots = converted.Roots[:1]
	children := make([]any, 0, 1000)
	for index := 1; index <= 1000; index++ {
		children = append(children, strconv.Itoa(index))
	}
	converted.Blocks = converted.Blocks[:1001]
	converted.Blocks[0]["children"] = children
	if _, err := prepareFeishuBatches(converted); !errors.Is(err, errFeishuContentLimit) {
		t.Fatalf("oversized nested tree: %v", err)
	}
}

func TestFeishuMutationRetriesRateLimitWithSameToken(t *testing.T) {
	app := &App{}
	var firstURL, firstBody string
	calls := 0
	app.feishuDocsHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls++
		body, _ := io.ReadAll(request.Body)
		if request.Header.Get("Authorization") != "Bearer token" || request.URL.Query().Get("client_token") == "" {
			t.Fatal("mutation credentials or idempotency key missing")
		}
		if calls == 1 {
			firstURL, firstBody = request.URL.String(), string(body)
			response := jsonResponse(`{"code":99991400}`)
			response.StatusCode = http.StatusTooManyRequests
			return response, nil
		}
		if request.URL.String() != firstURL || string(body) != firstBody {
			t.Fatal("retry changed mutation identity or payload")
		}
		return jsonResponse(`{"code":0,"data":{}}`), nil
	})}
	err := app.mutateFeishuBlock(context.Background(), "token", http.MethodPatch, "/docx/v1/documents/doc/blocks/doc", map[string]string{"title": "Title"}, nil)
	if err != nil || calls != 2 {
		t.Fatalf("retry result: calls=%d error=%v", calls, err)
	}
}

func TestFeishuImageFailureRestoresOriginalBody(t *testing.T) {
	app := &App{}
	children := []string{"old"}
	app.feishuDocsHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		app.feishuRequestMu.Lock()
		app.feishuNextRequest = time.Time{}
		app.feishuRequestMu.Unlock()
		switch request.Method {
		case http.MethodGet:
			payload, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"block": map[string]any{"block_id": "doc", "children": children}}})
			return jsonResponse(string(payload)), nil
		case http.MethodPost:
			if strings.HasSuffix(request.URL.Path, "/descendant") {
				children = append(children, "new-image")
				return jsonResponse(`{"code":0,"data":{"block_id_relations":[{"temporary_block_id":"image","block_id":"new-image"}]}}`), nil
			}
			if err := request.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			if request.FormValue("parent_node") != "new-image" || request.FormValue("parent_type") != "docx_image" {
				t.Fatal("image upload did not target the created block")
			}
			return nil, errors.New("image upload failed")
		case http.MethodDelete:
			var body struct {
				Start int `json:"start_index"`
				End   int `json:"end_index"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Start != 1 || body.End != 2 {
				t.Fatalf("cleanup would delete original content: %+v", body)
			}
			children = children[:1]
			return jsonResponse(`{"code":0,"data":{}}`), nil
		default:
			t.Fatalf("unexpected request %s", request.Method)
			return nil, errors.New("unexpected request")
		}
	})}
	err := app.replaceFeishuDocument(context.Background(), "token", "doc", "Title",
		[]feishuBlockBatch{{Roots: []string{"image"}, Blocks: []map[string]any{{"block_id": "image", "block_type": 27, "image": map[string]any{}}}}},
		map[string][]byte{"image": []byte("image-bytes")})
	if err == nil || !slices.Equal(children, []string{"old"}) {
		t.Fatalf("failed sync did not preserve old body: children=%v error=%v", children, err)
	}
}

func TestFeishuCreateAndUpdateSameDocument(t *testing.T) {
	pool := newGCTestPool(t)
	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	user, documentID := seedGCUser(t, pool, "feishu-"+suffix, "First content")
	if _, err := pool.Exec(context.Background(), `UPDATE users SET membership_tier='lifetime' WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	app := New(config.Config{InternalToken: "test-internal", FeishuClientID: "cli_test", FeishuClientSecret: "test-secret", FeishuCredentialEncryptionKey: "test-key"}, pool)
	connection, release, err := app.lockFeishuAccount(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	err = app.storeFeishuCredential(context.Background(), connection, user.ID, feishuTokenResponse{AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 3600}, feishuAccountView{OpenID: "ou_test", Name: "Test user"})
	release()
	if err != nil {
		t.Fatal(err)
	}
	createdCount := 0
	var children []string
	var convertedContents []string
	var remoteTitle string
	app.feishuDocsHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		app.feishuRequestMu.Lock()
		app.feishuNextRequest = time.Time{}
		app.feishuRequestMu.Unlock()
		if request.URL.Host != "open.feishu.cn" || request.Header.Get("Authorization") != "Bearer access" {
			t.Fatal("unexpected provider or authorization")
		}
		switch {
		case strings.HasSuffix(request.URL.Path, "/blocks/convert"):
			var body map[string]string
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			convertedContents = append(convertedContents, body["content"])
			return jsonResponse(`{"code":0,"data":{"first_level_block_ids":["text"],"blocks":[{"block_id":"text","block_type":2,"text":{"elements":[{"text_run":{"content":"body"}}]}}]}}`), nil
		case request.URL.Path == "/open-apis/docx/v1/documents":
			createdCount++
			return jsonResponse(`{"code":0,"data":{"document":{"document_id":"remote"}}}`), nil
		case request.Method == http.MethodGet:
			payload, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"block": map[string]any{"block_id": "remote", "children": children}}})
			return jsonResponse(string(payload)), nil
		case strings.HasSuffix(request.URL.Path, "/descendant"):
			blockID := "block-" + strconv.Itoa(len(convertedContents))
			children = append(children, blockID)
			return jsonResponse(`{"code":0,"data":{"block_id_relations":[{"temporary_block_id":"text","block_id":"` + blockID + `"}]}}`), nil
		case request.Method == http.MethodPatch:
			var body struct {
				Update struct {
					Elements []struct {
						Text struct {
							Content string `json:"content"`
						} `json:"text_run"`
					} `json:"elements"`
				} `json:"update_text_elements"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			remoteTitle = body.Update.Elements[0].Text.Content
			return jsonResponse(`{"code":0,"data":{}}`), nil
		case request.Method == http.MethodDelete:
			var body struct {
				Start int `json:"start_index"`
				End   int `json:"end_index"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			children = append(children[:body.Start], children[body.End:]...)
			return jsonResponse(`{"code":0,"data":{}}`), nil
		default:
			t.Fatalf("unexpected API request: %s %s", request.Method, request.URL.Path)
			return nil, errors.New("unexpected request")
		}
	})}
	requestSync := func(wantCreated bool) {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/api/documents/"+documentID+"/feishu-sync", nil)
		request.Header.Set("X-Koinote-Internal-Token", "test-internal")
		request.Header.Set("X-Auth-User-Id", user.AuthUserID)
		recorder := httptest.NewRecorder()
		app.Routes().ServeHTTP(recorder, request)
		var result feishuSyncResult
		if recorder.Code != http.StatusOK || json.Unmarshal(recorder.Body.Bytes(), &result) != nil || result.Created != wantCreated || result.URL != feishuDocumentURL("remote") {
			t.Fatalf("sync response %d: %s", recorder.Code, recorder.Body.String())
		}
	}
	requestSync(true)
	if _, err := pool.Exec(context.Background(), `UPDATE documents SET title='Updated title',content='Second content',revision=revision+1 WHERE doc_id=$1`, documentID); err != nil {
		t.Fatal(err)
	}
	requestSync(false)
	if createdCount != 1 || !slices.Equal(children, []string{"block-2"}) || remoteTitle != "Updated title" || !slices.Equal(convertedContents, []string{"First content", "Second content"}) {
		t.Fatalf("unexpected sync result: created=%d children=%v title=%s converted=%v", createdCount, children, remoteTitle, convertedContents)
	}
	var revision int64
	if err := pool.QueryRow(context.Background(), `SELECT source_revision FROM feishu_document_links WHERE user_id=$1 AND document_id=$2`, user.ID, documentID).Scan(&revision); err != nil || revision != 2 {
		t.Fatalf("stored revision=%d error=%v", revision, err)
	}
	otherUser, _ := seedGCUser(t, pool, "feishu-other-"+suffix, "Private content")
	if _, err := pool.Exec(context.Background(), `UPDATE users SET membership_tier='lifetime' WHERE id=$1`, otherUser.ID); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/documents/"+documentID+"/feishu-sync", nil)
	request.Header.Set("X-Koinote-Internal-Token", "test-internal")
	request.Header.Set("X-Auth-User-Id", otherUser.AuthUserID)
	recorder := httptest.NewRecorder()
	app.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || len(convertedContents) != 2 {
		t.Fatalf("cross-account sync reached provider: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestFeishuSyncRecoversDeletedDocument(test *testing.T) {
	pool := newGCTestPool(test)
	for _, testCase := range []struct {
		name                 string
		rootStatus           int
		rootCode             int
		mutationCode         int
		recreate             bool
		failReplacementWrite bool
	}{
		{name: "not-found", rootStatus: 404, rootCode: 1770002, recreate: true},
		{name: "deleted", rootStatus: 400, rootCode: 1770003, recreate: true},
		{name: "retry-replacement", rootStatus: 404, rootCode: 1770002, recreate: true, failReplacementWrite: true},
		{name: "forbidden", rootStatus: 403, rootCode: 1770032},
		{name: "unknown-not-found", rootStatus: 404, rootCode: -1},
		{name: "unavailable", rootStatus: 500, rootCode: 1771001},
		{name: "missing-child", mutationCode: 1770002},
	} {
		test.Run(testCase.name, func(test *testing.T) {
			ctx := context.Background()
			user, documentID := seedGCUser(test, pool, "feishu-recovery-"+testCase.name, "")
			if _, err := pool.Exec(ctx, `UPDATE users SET membership_tier='lifetime' WHERE id=$1`, user.ID); err != nil {
				test.Fatal(err)
			}
			app := New(config.Config{InternalToken: "test-internal", FeishuClientID: "cli_test", FeishuClientSecret: "test-secret", FeishuCredentialEncryptionKey: "test-key"}, pool)
			connection, release, err := app.lockFeishuAccount(ctx, user.ID)
			if err != nil {
				test.Fatal(err)
			}
			err = app.storeFeishuCredential(ctx, connection, user.ID, feishuTokenResponse{AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 3600}, feishuAccountView{OpenID: "ou_test", Name: "Test user"})
			release()
			if err != nil {
				test.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO feishu_document_links (user_id,document_id,app_id,open_id,feishu_document_id,source_revision,synced_at) VALUES ($1,$2,'cli_test','ou_test','original',42,now())`, user.ID, documentID); err != nil {
				test.Fatal(err)
			}
			createdCount := 0
			failWrite := testCase.failReplacementWrite
			app.feishuDocsHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				app.feishuRequestMu.Lock()
				app.feishuNextRequest = time.Time{}
				app.feishuRequestMu.Unlock()
				failure := func(status, code int) *http.Response {
					response := jsonResponse(`{"code":` + strconv.Itoa(code) + `}`)
					response.StatusCode = status
					return response
				}
				switch {
				case request.URL.Path == "/open-apis/docx/v1/documents":
					createdCount++
					return jsonResponse(`{"code":0,"data":{"document":{"document_id":"replacement"}}}`), nil
				case request.Method == http.MethodGet:
					remoteID := "replacement"
					if strings.HasSuffix(request.URL.Path, "/blocks/original") {
						if testCase.rootCode != 0 {
							return failure(testCase.rootStatus, testCase.rootCode), nil
						}
						remoteID = "original"
					}
					return jsonResponse(`{"code":0,"data":{"block":{"block_id":"` + remoteID + `","children":[]}}}`), nil
				case strings.HasSuffix(request.URL.Path, "/descendant"):
					if testCase.mutationCode != 0 {
						return failure(http.StatusNotFound, testCase.mutationCode), nil
					}
					if failWrite {
						return failure(http.StatusInternalServerError, 1771001), nil
					}
					return jsonResponse(`{"code":0,"data":{"block_id_relations":[{"temporary_block_id":"empty","block_id":"new-block"}]}}`), nil
				case request.Method == http.MethodPatch:
					return jsonResponse(`{"code":0,"data":{}}`), nil
				default:
					test.Fatalf("unexpected API request: %s %s", request.Method, request.URL.Path)
					return nil, errors.New("unexpected request")
				}
			})}
			requestSync := func(wantStatus int, wantCreated bool) {
				test.Helper()
				request := httptest.NewRequest(http.MethodPost, "/api/documents/"+documentID+"/feishu-sync", nil)
				request.Header.Set("X-Koinote-Internal-Token", "test-internal")
				request.Header.Set("X-Auth-User-Id", user.AuthUserID)
				recorder := httptest.NewRecorder()
				app.Routes().ServeHTTP(recorder, request)
				if recorder.Code != wantStatus {
					test.Fatalf("sync response %d: %s", recorder.Code, recorder.Body.String())
				}
				if wantStatus == http.StatusOK {
					var result feishuSyncResult
					if json.Unmarshal(recorder.Body.Bytes(), &result) != nil || result.Created != wantCreated || result.URL != feishuDocumentURL("replacement") {
						test.Fatalf("unexpected sync result: %s", recorder.Body.String())
					}
				}
			}
			checkLink := func(wantID string, wantRevision int64, wantSynced bool) {
				test.Helper()
				var remoteID string
				var revision int64
				var synced bool
				if err := pool.QueryRow(ctx, `SELECT feishu_document_id,source_revision,synced_at IS NOT NULL FROM feishu_document_links WHERE user_id=$1 AND document_id=$2`, user.ID, documentID).Scan(&remoteID, &revision, &synced); err != nil {
					test.Fatal(err)
				}
				if remoteID != wantID || revision != wantRevision || synced != wantSynced {
					test.Fatalf("unexpected link: id=%s revision=%d synced=%v", remoteID, revision, synced)
				}
			}
			if testCase.recreate {
				if failWrite {
					requestSync(http.StatusBadGateway, false)
					checkLink("replacement", 0, false)
					failWrite = false
					requestSync(http.StatusOK, false)
				} else {
					requestSync(http.StatusOK, true)
				}
				requestSync(http.StatusOK, false)
				checkLink("replacement", 1, true)
				if createdCount != 1 {
					test.Fatalf("created %d replacements, want 1", createdCount)
				}
			} else {
				requestSync(http.StatusBadGateway, false)
				checkLink("original", 42, true)
				if createdCount != 0 {
					test.Fatal("recreated a document after an unrelated provider error")
				}
			}
		})
	}
}

func TestFeishuOAuthAndCredentialRefresh(t *testing.T) {
	pool := newGCTestPool(t)
	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	user, _ := seedGCUser(t, pool, "feishu-oauth-"+suffix, "Document")
	if _, err := pool.Exec(context.Background(), `UPDATE users SET membership_tier='lifetime' WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	app := New(config.Config{AppURL: "https://notes.example", NodeEnv: "production", InternalToken: "test-internal", FeishuClientID: "cli_test", FeishuClientSecret: "secret", FeishuCredentialEncryptionKey: "test-key"}, pool)
	routes := app.Routes()
	request := httptest.NewRequest(http.MethodGet, "/api/feishu/oauth/start", nil)
	request.Header.Set("X-Koinote-Internal-Token", "test-internal")
	request.Header.Set("X-Auth-User-Id", user.AuthUserID)
	start := httptest.NewRecorder()
	routes.ServeHTTP(start, request)
	var authorization struct {
		URL string `json:"url"`
	}
	if start.Code != http.StatusOK || json.Unmarshal(start.Body.Bytes(), &authorization) != nil {
		t.Fatalf("authorization start: %d %s", start.Code, start.Body.String())
	}
	authorizeURL, err := url.Parse(authorization.URL)
	if err != nil || authorizeURL.Host != "accounts.feishu.cn" {
		t.Fatalf("invalid authorization URL: %s", authorization.URL)
	}
	query := authorizeURL.Query()
	state, challenge := query.Get("state"), query.Get("code_challenge")
	if state == "" || challenge == "" || query.Get("code_challenge_method") != "S256" || !strings.Contains(query.Get("scope"), "offline_access") {
		t.Fatal("authorization did not include state, PKCE, and offline access")
	}
	cookies := start.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].Value != state {
		t.Fatal("authorization state cookie missing or insecure")
	}
	exchanges := 0
	refreshes := 0
	app.feishuDocsHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/open-apis/authen/v1/user_info" {
			return jsonResponse(`{"code":0,"data":{"open_id":"ou_test","name":"Test user"}}`), nil
		}
		if request.URL.String() != feishuTokenURL {
			t.Fatalf("unexpected authorization request: %s", request.URL)
		}
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["client_id"] != "cli_test" || body["client_secret"] != "secret" {
			t.Fatal("missing OAuth app credentials")
		}
		if body["grant_type"] == "refresh_token" {
			refreshes++
			if body["refresh_token"] != "refresh-first" {
				t.Fatal("refresh did not use the stored credential")
			}
			return jsonResponse(`{"code":0,"access_token":"access-second","refresh_token":"refresh-second","expires_in":7200}`), nil
		}
		exchanges++
		digest := sha256.Sum256([]byte(body["code_verifier"]))
		if base64.RawURLEncoding.EncodeToString(digest[:]) != challenge || body["redirect_uri"] != app.feishuRedirectURI() {
			t.Fatal("token exchange did not match the PKCE challenge and redirect URI")
		}
		return jsonResponse(`{"code":0,"access_token":"access-first","refresh_token":"refresh-first","expires_in":7200}`), nil
	})}
	callback := func(cookie *http.Cookie) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/api/feishu/oauth/callback?state="+url.QueryEscape(state)+"&code=test-code", nil)
		if cookie != nil {
			request.AddCookie(cookie)
		}
		recorder := httptest.NewRecorder()
		routes.ServeHTTP(recorder, request)
		return recorder
	}
	if response := callback(nil); exchanges != 0 || !strings.Contains(response.Header().Get("Location"), "feishu=error") {
		t.Fatal("callback without state cookie must not exchange credentials")
	}
	if response := callback(cookies[0]); exchanges != 1 || !strings.Contains(response.Header().Get("Location"), "feishu=success") {
		t.Fatalf("callback failed: %d %s", response.Code, response.Header().Get("Location"))
	}
	callback(cookies[0])
	if exchanges != 1 {
		t.Fatal("OAuth callback replay exchanged the same code twice")
	}
	connection, release, err := app.lockFeishuAccount(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err := connection.Exec(context.Background(), `UPDATE feishu_accounts SET expires_at=now() WHERE user_id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	credential, err := app.loadFeishuCredential(context.Background(), connection, user.ID)
	if err != nil || credential.AccessToken != "access-second" || refreshes != 1 {
		t.Fatalf("refresh: credential=%v refreshes=%d error=%v", credential.feishuAccountView, refreshes, err)
	}
	if _, err := app.loadFeishuCredential(context.Background(), connection, user.ID); err != nil || refreshes != 1 {
		t.Fatalf("fresh token was refreshed again: %v", err)
	}
	var ciphertext []byte
	if err := connection.QueryRow(context.Background(), `SELECT refresh_token_ciphertext FROM feishu_accounts WHERE user_id=$1`, user.ID).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte("refresh-second")) {
		t.Fatal("refresh token was stored in plaintext")
	}
	if plain, err := app.decryptFeishuCredential(user.ID, "refresh", ciphertext); err != nil || plain != "refresh-second" {
		t.Fatal("rotated refresh token was not persisted")
	}
}

func TestFeishuMembershipGates(t *testing.T) {
	pool := newGCTestPool(t)
	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	user, documentID := seedGCUser(t, pool, "feishu-membership-"+suffix, "Document")
	app := New(config.Config{AppURL: "http://localhost:5273", InternalToken: "test-internal", FeishuClientID: "cli_test", FeishuClientSecret: "secret", FeishuCredentialEncryptionKey: "test-key"}, pool)
	providerCalls := 0
	app.feishuDocsHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		providerCalls++
		return nil, errors.New("free users must not reach Feishu")
	})}
	routes := app.Routes()
	requestAsUser := func(method, target string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, target, nil)
		request.Header.Set("X-Koinote-Internal-Token", "test-internal")
		request.Header.Set("X-Auth-User-Id", user.AuthUserID)
		recorder := httptest.NewRecorder()
		routes.ServeHTTP(recorder, request)
		return recorder
	}
	setMembership := func(tier string) {
		t.Helper()
		if _, err := pool.Exec(context.Background(), `UPDATE users SET membership_tier=$2 WHERE id=$1`, user.ID, tier); err != nil {
			t.Fatal(err)
		}
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/feishu/oauth/start"},
		{http.MethodGet, "/api/feishu/oauth/start?client=desktop-local"},
		{http.MethodGet, "/api/feishu/account"},
		{http.MethodPost, "/api/documents/" + documentID + "/feishu-sync"},
	} {
		response := requestAsUser(route.method, route.path)
		if response.Code != http.StatusForbidden || decodeHTTPErrorCode(t, response.Result()) != "membership_required" {
			t.Fatalf("free user reached %s: %d %s", route.path, response.Code, response.Body.String())
		}
	}
	var pendingCount int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM feishu_oauth_pending WHERE user_id=$1`, user.ID).Scan(&pendingCount); err != nil || pendingCount != 0 {
		t.Fatalf("free user created authorization state: count=%d error=%v", pendingCount, err)
	}
	for _, client := range []string{"", "desktop-local"} {
		setMembership(membershipTierLifetime)
		start := requestAsUser(http.MethodGet, "/api/feishu/oauth/start?client="+client)
		var authorization struct {
			URL string `json:"url"`
		}
		if start.Code != http.StatusOK || json.Unmarshal(start.Body.Bytes(), &authorization) != nil {
			t.Fatalf("member could not start authorization: %d %s", start.Code, start.Body.String())
		}
		authorizeURL, err := url.Parse(authorization.URL)
		if err != nil {
			t.Fatal(err)
		}
		state := authorizeURL.Query().Get("state")
		if client != "" {
			desktopStart := requestAsUser(http.MethodGet, authorization.URL)
			if desktopStart.Code != http.StatusFound || len(desktopStart.Result().Cookies()) != 1 {
				t.Fatalf("member desktop authorization failed: %d", desktopStart.Code)
			}
		}
		setMembership(membershipTierFree)
		if client != "" {
			if response := requestAsUser(http.MethodGet, authorization.URL); response.Code != http.StatusBadRequest || response.Header().Get("Location") != "" {
				t.Fatalf("downgraded member reached desktop authorization: %d", response.Code)
			}
		}
		request := httptest.NewRequest(http.MethodGet, "/api/feishu/oauth/callback?state="+url.QueryEscape(state)+"&code=test-code", nil)
		request.AddCookie(&http.Cookie{Name: feishuStateCookie, Value: state})
		response := httptest.NewRecorder()
		routes.ServeHTTP(response, request)
		redirect, err := url.Parse(response.Header().Get("Location"))
		if err != nil || response.Code != http.StatusFound || (redirect.Query().Get("status") != "error" && redirect.Query().Get("feishu") != "error") {
			t.Fatalf("downgraded member callback succeeded: %d %s", response.Code, response.Header().Get("Location"))
		}
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM feishu_oauth_pending WHERE state=$1`, state).Scan(&pendingCount); err != nil || pendingCount != 0 {
			t.Fatalf("rejected callback was not consumed: count=%d error=%v", pendingCount, err)
		}
	}
	connection, release, err := app.lockFeishuAccount(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	err = app.storeFeishuCredential(context.Background(), connection, user.ID, feishuTokenResponse{AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 3600}, feishuAccountView{OpenID: "ou_test", Name: "Test user"})
	release()
	if err != nil {
		t.Fatal(err)
	}
	response := requestAsUser(http.MethodPost, "/api/documents/"+documentID+"/feishu-sync")
	if response.Code != http.StatusForbidden || decodeHTTPErrorCode(t, response.Result()) != "membership_required" || providerCalls != 0 {
		t.Fatalf("previously bound free user reached sync: %d, provider calls=%d", response.Code, providerCalls)
	}
	if response := requestAsUser(http.MethodDelete, "/api/feishu/account"); response.Code != http.StatusOK {
		t.Fatalf("free user cannot revoke existing binding: %d %s", response.Code, response.Body.String())
	}
	var accountCount int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM feishu_accounts WHERE user_id=$1`, user.ID).Scan(&accountCount); err != nil || accountCount != 0 {
		t.Fatalf("binding was not removed: count=%d error=%v", accountCount, err)
	}
}

func TestFeishuImageLimits(t *testing.T) {
	app := &App{}
	var converted feishuConversion
	if err := json.Unmarshal([]byte(`{"blocks":[{"block_id":"image","image":{}}],"block_id_to_image_urls":[{"block_id":"image","image_url":"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="}]}`), &converted); err != nil {
		t.Fatal(err)
	}
	if _, err := app.prepareFeishuImages(context.Background(), converted); !errors.Is(err, errFeishuImage) {
		t.Fatalf("unsupported image format: %v", err)
	}
	for len(converted.Images) < 21 {
		converted.Images = append(converted.Images, converted.Images[0])
	}
	if _, err := app.prepareFeishuImages(context.Background(), converted); !errors.Is(err, errFeishuContentLimit) {
		t.Fatalf("image count limit: %v", err)
	}
	converted.Images = converted.Images[:6]
	for index := range converted.Images {
		converted.Images[index].URL = "https://images.example/test.png"
		converted.Images[index].BlockID = strconv.Itoa(index)
	}
	imageData := make([]byte, 9<<20)
	copy(imageData, "\x89PNG\r\n\x1a\n")
	fetches := 0
	app.xImageHTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		fetches++
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(imageData)), Header: make(http.Header)}, nil
	})}
	if _, err := app.prepareFeishuImages(context.Background(), converted); !errors.Is(err, errFeishuContentLimit) || fetches != 1 {
		t.Fatalf("total upload limit with cached image: fetches=%d error=%v", fetches, err)
	}
}

func TestPrepareFeishuBatchesStripsReadOnlyFields(t *testing.T) {
	converted := feishuConversion{
		Roots: []string{"root"},
		Blocks: []map[string]any{
			{
				"block_id":   "root",
				"block_type": float64(2),
				"merge_info": map[string]any{"row": float64(1)},
				"children":   []any{"child"},
			},
			{
				"block_id":   "child",
				"block_type": float64(2),
				"merge_info": map[string]any{"row": float64(2)},
			},
		},
	}
	batches, err := prepareFeishuBatches(converted)
	if err != nil {
		t.Fatalf("prepareFeishuBatches() error = %v", err)
	}
	if len(batches) != 1 || len(batches[0].Blocks) != 2 {
		t.Fatalf("prepareFeishuBatches() = %#v", batches)
	}
	for _, block := range batches[0].Blocks {
		if _, exists := block["merge_info"]; exists {
			t.Fatal("merge_info must be removed before writing blocks")
		}
	}
}

func TestPrepareFeishuBatchesRejectsLimitsAndUnreachableBlocks(t *testing.T) {
	tooMany := feishuConversion{Roots: []string{"root"}}
	tooMany.Blocks = append(tooMany.Blocks, map[string]any{"block_id": "root", "block_type": float64(2)})
	for index := 1; index < 5001; index++ {
		tooMany.Blocks = append(tooMany.Blocks, map[string]any{"block_id": "block" + strconv.Itoa(index), "block_type": float64(2)})
	}
	if _, err := prepareFeishuBatches(tooMany); err != errFeishuContentLimit {
		t.Fatalf("too many blocks error = %v, want %v", err, errFeishuContentLimit)
	}
	invalid := feishuConversion{
		Roots:  []string{"root"},
		Blocks: []map[string]any{{"block_id": "root", "children": []any{"missing"}}},
	}
	if _, err := prepareFeishuBatches(invalid); err == nil {
		t.Fatal("unreachable child must be rejected")
	}
}
