package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

// Commit another client's allocation change after the first read completes.
// This deterministically exercises the interleaving that used to mix snapshots.
type agentStorageAfterReadQuerier struct {
	imageUsageQuerier
	afterRead func()
}

func (q *agentStorageAfterReadQuerier) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	afterRead := q.afterRead
	q.afterRead = nil
	return agentStorageAfterReadRow{Row: q.imageUsageQuerier.QueryRow(ctx, sql, args...), afterRead: afterRead}
}

type agentStorageAfterReadRow struct {
	pgx.Row
	afterRead func()
}

func (r agentStorageAfterReadRow) Scan(dest ...any) error {
	err := r.Row.Scan(dest...)
	if err == nil && r.afterRead != nil {
		r.afterRead()
	}
	return err
}

func TestAgentStorageReadConsistentDuringAllocationChange(t *testing.T) {
	for _, test := range []struct {
		name          string
		initial, next int64
	}{
		{name: "increase", initial: 0, next: 512 << 20},
		{name: "release", initial: 512 << 20, next: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool, userID := newCreditTestUser(t)
			ctx := context.Background()
			app := &App{db: pool, cfg: config.Config{ImageQuotaBytes: 1 << 30}}
			user := model.User{ID: userID}
			doc, err := app.createDocument(ctx, createDocumentParams{
				User: user, Title: "笔记", Content: "body", CoverMode: "ai",
				CoverImageSource: "https://example.test/cover.png", CoverPrompt: "封面",
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := app.recordImageObject(ctx, userID, fmt.Sprintf("snapshot-image-%d", userID), 123, app.storageQuotaFor(user), imagePurposePersistent, nil); err != nil {
				t.Fatal(err)
			}
			if _, err := app.recordImageObject(ctx, userID, fmt.Sprintf("snapshot-temporary-%d", userID), 456, app.storageQuotaFor(user), imagePurposeWechatExport, nil); err != nil {
				t.Fatal(err)
			}
			envelope := []byte("encrypted test snapshot")
			if _, err := pool.Exec(ctx, `
				INSERT INTO config_snapshots (user_id, name, file_count, bytes, envelope_version, envelope)
				VALUES ($1, 'Storage read test', 1, $2, 1, $3)
			`, userID, len(envelope), envelope); err != nil {
				t.Fatal(err)
			}
			if _, err := app.allocateAgentWorkspaceStorage(ctx, user, test.initial); err != nil {
				t.Fatal(err)
			}
			q := &agentStorageAfterReadQuerier{imageUsageQuerier: pool, afterRead: func() {
				if _, err := app.allocateAgentWorkspaceStorage(ctx, user, test.next); err != nil {
					t.Fatal(err)
				}
			}}
			view, err := app.loadAgentWorkspaceStorage(ctx, q, user)
			if err != nil {
				t.Fatal(err)
			}
			personalUsed := int64(len(doc.Title)+len(doc.Content)+len(doc.CoverImageSource)+len(doc.CoverPrompt)+len(envelope)+123) + test.initial
			want := agentWorkspaceStorageView{
				QuotaBytes: agentWorkspaceDefaultQuotaBytes + test.initial, AllocatedBytes: test.initial,
				PersonalQuotaBytes: 1 << 30, PersonalUsedBytes: personalUsed, AvailableBytes: (1 << 30) - personalUsed,
			}
			if view != want {
				t.Fatalf("storage response mixed snapshots: got %+v, want %+v", view, want)
			}
			latest, err := app.loadAgentWorkspaceStorage(ctx, pool, user)
			if err != nil || latest.AllocatedBytes != test.next || latest.QuotaBytes != agentWorkspaceDefaultQuotaBytes+test.next {
				t.Fatalf("concurrent allocation did not commit: %+v, err=%v", latest, err)
			}
		})
	}
}

func TestAgentStorageAllocationAPI(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	app := &App{db: pool, cfg: config.Config{SessionSecret: "allocation-test"}}
	var authID string
	if err := pool.QueryRow(ctx, `UPDATE users SET membership_tier = 'lifetime', bonus_storage_bytes = 1024 WHERE id = $1 RETURNING auth_user_id`, userID).Scan(&authID); err != nil {
		t.Fatal(err)
	}
	cookie := sessionCookieFor(t, app, authID, 1)
	endpoint := "/api/agent/workspace/storage"
	if response := callLLMChannelAPI(t, app, cookie, http.MethodPut, endpoint, `{"allocatedBytes":0}`); response.Code != http.StatusForbidden {
		t.Fatalf("disabled repositories: %d %s", response.Code, response.Body.String())
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings (user_id, enabled) VALUES ($1, true)`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_storage_quotas (user_id, bonus_bytes) VALUES ($1, 1234)`, userID); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{}`, `{"allocatedBytes":null}`, `{"allocatedBytes":-1}`, `{"allocatedBytes":0.5}`, `{"allocatedBytes":"10"}`} {
		response := callLLMChannelAPI(t, app, cookie, http.MethodPut, endpoint, body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid %s: %d %s", body, response.Code, response.Body.String())
		}
	}
	for _, amount := range []int64{512 << 20, 512 << 20, 128 << 20, 0} {
		response := callLLMChannelAPI(t, app, cookie, http.MethodPut, endpoint, fmt.Sprintf(`{"allocatedBytes":%d}`, amount))
		if response.Code != http.StatusOK {
			t.Fatalf("allocate %d: %d %s", amount, response.Code, response.Body.String())
		}
		var body struct{ Storage agentWorkspaceStorageView }
		decodeJSONResponse(t, response, &body)
		if body.Storage.AllocatedBytes != amount || body.Storage.QuotaBytes != agentWorkspaceDefaultQuotaBytes+1234+amount || body.Storage.AvailableBytes != lifetimeStorageQuotaBytes+1024-amount {
			t.Fatalf("incorrect allocation: %+v", body.Storage)
		}
		usage := callLLMChannelAPI(t, app, cookie, http.MethodGet, "/api/storage/usage", "")
		var reported struct{ UsedBytes, AgentAllocatedBytes int64 }
		decodeJSONResponse(t, usage, &reported)
		if reported.UsedBytes != amount || reported.AgentAllocatedBytes != amount {
			t.Fatalf("allocation must be reserved once: %+v", reported)
		}
	}
	response := callLLMChannelAPI(t, app, cookie, http.MethodPut, endpoint, `{"allocatedBytes":9223372036854775807}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "storage_allocation_insufficient") {
		t.Fatalf("oversized allocation: %d %s", response.Code, response.Body.String())
	}
	// A repository credential must not gain access to account storage settings.
	created := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/mcp/tokens", `{"name":"Allocation test","scope":"agent_write"}`)
	var token struct{ Secret string }
	decodeJSONResponse(t, created, &token)
	if token.Secret == "" {
		t.Fatalf("create repository token: %s", created.Body.String())
	}
	readRequest := httptest.NewRequest(http.MethodGet, endpoint, nil)
	readRequest.Header.Set("Authorization", "Bearer "+token.Secret)
	readResponse := httptest.NewRecorder()
	app.Routes().ServeHTTP(readResponse, readRequest)
	if readResponse.Code != http.StatusOK || strings.Contains(readResponse.Body.String(), "personalUsedBytes") || !strings.Contains(readResponse.Body.String(), "quotaBytes") {
		t.Fatalf("repository token should only see repository storage: %d %s", readResponse.Code, readResponse.Body.String())
	}
	request := httptest.NewRequest(http.MethodPut, endpoint, strings.NewReader(`{"allocatedBytes":1024}`))
	request.Header.Set("Authorization", "Bearer "+token.Secret)
	response = httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized && response.Code != http.StatusForbidden {
		t.Fatalf("repository token allocation: %d %s", response.Code, response.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET membership_tier = 'free' WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	if response := callLLMChannelAPI(t, app, cookie, http.MethodPut, endpoint, `{"allocatedBytes":0}`); response.Code != http.StatusForbidden {
		t.Fatalf("nonmember allocation: %d %s", response.Code, response.Body.String())
	}
}

func TestAgentStorageAllocationReservesPersonalStorage(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	app := &App{db: pool, cfg: config.Config{ImageQuotaBytes: 1024, SessionSecret: "allocation-writers"}}
	var authID string
	if err := pool.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id = $1`, userID).Scan(&authID); err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: userID, AuthUserID: authID}
	doc, err := app.createDocument(ctx, createDocumentParams{User: user, Title: "Doc", Content: "Body"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.allocateAgentWorkspaceStorage(ctx, user, 1017); err != nil {
		t.Fatal(err)
	}
	if _, err = app.allocateAgentWorkspaceStorage(ctx, user, 1018); !errors.Is(err, errAgentStorageAllocationFull) {
		t.Fatalf("allocation must count existing documents: %v", err)
	}
	if _, err = app.createDocument(ctx, createDocumentParams{User: user, Title: "New"}); !errors.Is(err, errDocumentQuotaExceeded) {
		t.Fatalf("document create consumed reserved capacity: %v", err)
	}
	if _, err = app.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme, Content: "Larger body", ExpectedRevision: doc.Revision}); !errors.Is(err, errDocumentQuotaExceeded) {
		t.Fatalf("document update consumed reserved capacity: %v", err)
	}
	if _, err = app.recordImageObject(ctx, userID, fmt.Sprintf("allocation-%d", userID), 1, 1024, imagePurposePersistent, nil); !errors.Is(err, errQuotaExceeded) {
		t.Fatalf("image consumed reserved capacity: %v", err)
	}
	if _, err = app.recordImageObject(ctx, userID, fmt.Sprintf("temporary-%d", userID), 1, 1024, imagePurposeWechatExport, nil); err != nil {
		t.Fatalf("temporary images keep their independent quota: %v", err)
	}
	envelope, _ := json.Marshal(map[string]any{
		"version": 1, "kdf": "PBKDF2-SHA-256", "iterations": 310000,
		"salt": base64.StdEncoding.EncodeToString(make([]byte, 16)), "iv": base64.StdEncoding.EncodeToString(make([]byte, 12)), "ciphertext": base64.StdEncoding.EncodeToString(make([]byte, 16)),
	})
	payload, _ := json.Marshal(configSnapshotCreateInput{Name: "Allocation test", FileCount: 1, EnvelopeVersion: 1, Envelope: string(envelope)})
	cookie := sessionCookieFor(t, app, authID, 1)
	response := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/config-snapshots", string(payload))
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "config_snapshot_quota_exceeded") {
		t.Fatalf("snapshot consumed reserved capacity: %d %s", response.Code, response.Body.String())
	}
	if _, err = app.allocateAgentWorkspaceStorage(ctx, user, 0); err != nil {
		t.Fatal(err)
	}
	if _, err = app.createDocument(ctx, createDocumentParams{User: user, Title: "New"}); err != nil {
		t.Fatalf("released capacity not available: %v", err)
	}
	response = callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/config-snapshots", string(payload))
	if response.Code != http.StatusCreated {
		t.Fatalf("released capacity not available to snapshots: %d %s", response.Code, response.Body.String())
	}
	usage, err := app.storageUsageFor(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.allocateAgentWorkspaceStorage(ctx, user, 1024-usage.Total()+1); !errors.Is(err, errAgentStorageAllocationFull) {
		t.Fatalf("allocation must count snapshots: %v", err)
	}
}

func TestAgentStorageAllocationConcurrentWriters(t *testing.T) {
	for _, writer := range []string{"image", "document"} {
		t.Run(writer, func(t *testing.T) {
			pool, userID := newCreditTestUser(t)
			ctx := context.Background()
			app := &App{db: pool, cfg: config.Config{ImageQuotaBytes: 100}}
			user := model.User{ID: userID}
			start := make(chan struct{})
			results := make(chan error, 2)
			go func() {
				<-start
				_, err := app.allocateAgentWorkspaceStorage(ctx, user, 80)
				results <- err
			}()
			go func() {
				<-start
				var err error
				if writer == "image" {
					_, err = app.recordImageObject(ctx, userID, fmt.Sprintf("race-%d", userID), 80, 100, imagePurposePersistent, nil)
				} else {
					_, err = app.createDocument(ctx, createDocumentParams{User: user, Title: strings.Repeat("x", 80)})
				}
				results <- err
			}()
			close(start)
			succeeded := 0
			for range 2 {
				err := <-results
				if err == nil {
					succeeded++
				} else if !errors.Is(err, errAgentStorageAllocationFull) && !errors.Is(err, errQuotaExceeded) && !errors.Is(err, errDocumentQuotaExceeded) {
					t.Fatal(err)
				}
			}
			usage, err := app.storageUsageFor(ctx, userID)
			if err != nil || succeeded != 1 || usage.Total() != 80 {
				t.Fatalf("concurrent writers: successes=%d usage=%+v err=%v", succeeded, usage, err)
			}
		})
	}
}

func TestAgentStorageAllocationProtectsFilesAndHistory(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	app := &App{db: pool, cfg: config.Config{ImageQuotaBytes: 10 << 20}}
	user := model.User{ID: userID}
	large, err := app.createAgentWorkspace(ctx, userID, "Existing files", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	// Fill the included 100 MB with valid-sized files without transporting a large test payload.
	if _, err := pool.Exec(ctx, `
		INSERT INTO agent_workspace_files (workspace_id, path, content, mime_type, size_bytes, sha256)
		SELECT $1, 'skills/' || n || '.md', convert_to(repeat('x', 5000000), 'UTF8'), 'text/markdown', 5000000,
		       encode(digest(convert_to(repeat('x', 5000000), 'UTF8'), 'sha256'), 'hex')
		FROM generate_series(1, 20) n
	`, large.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = app.createAgentWorkspace(ctx, userID, "Over quota", "", "en"); !errors.Is(err, errAgentWorkspaceQuota) {
		t.Fatalf("repository creation should need more capacity: %v", err)
	}
	if _, err = app.allocateAgentWorkspaceStorage(ctx, user, 1<<20); err != nil {
		t.Fatal(err)
	}
	small, err := app.createAgentWorkspace(ctx, userID, "History", "", "en")
	if err != nil {
		t.Fatalf("allocated capacity must support new repositories: %v", err)
	}
	for _, content := range []string{"first", "second"} {
		files, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{{Path: "SKILL.md", ContentBase64: base64.StdEncoding.EncodeToString([]byte(content))}})
		if err != nil {
			t.Fatal(err)
		}
		small, err = app.patchAgentWorkspace(ctx, userID, small.WorkspaceID, small.Revision, files, nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	var commits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_commits WHERE workspace_id = $1`, small.WorkspaceID).Scan(&commits); err != nil || commits != 3 {
		t.Fatalf("expanded quota must retain history above the original 100 MB: commits=%d err=%v", commits, err)
	}
	view, err := app.loadAgentWorkspaceStorage(ctx, pool, user)
	if err != nil {
		t.Fatal(err)
	}
	minimum := view.UsedBytes - agentWorkspaceDefaultQuotaBytes
	if _, err = app.allocateAgentWorkspaceStorage(ctx, user, minimum-1); !errors.Is(err, errAgentStorageAllocationInUse) {
		t.Fatalf("shrinking must retain existing data: %v", err)
	}
	if _, err = app.allocateAgentWorkspaceStorage(ctx, user, minimum); err != nil {
		t.Fatalf("exact used capacity must be allowed: %v", err)
	}
	var after int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_commits WHERE workspace_id = $1`, small.WorkspaceID).Scan(&after); err != nil || after != commits {
		t.Fatalf("shrinking removed history: %d, err=%v", after, err)
	}
	usage, err := app.storageUsageFor(ctx, userID)
	if err != nil || usage.Total() != minimum {
		t.Fatalf("files must not double-count allocated capacity: %+v err=%v", usage, err)
	}
}
