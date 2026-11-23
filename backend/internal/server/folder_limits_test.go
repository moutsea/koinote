package server

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestFolderLimitsSerializeAllCreationAndReplay(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{SessionSecret: "folder-limits", FolderCountLimit: 2}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	var wg sync.WaitGroup
	codes := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := writingTestRequest(t, a, user, "POST", "/api/folders", map[string]any{"name": "folder-" + strconv.Itoa(i)})
			codes <- w.Code
		}(i)
	}
	wg.Wait()
	close(codes)
	success := 0
	for code := range codes {
		if code == 200 {
			success++
		} else if code != 409 {
			t.Fatalf("unexpected create status %d", code)
		}
	}
	if success != 2 {
		t.Fatalf("concurrent folder cap: %d", success)
	}
	var id string
	if err := pool.QueryRow(context.Background(), `SELECT min(folder_id) FROM folders WHERE user_id=$1`, userID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	a.rateLimit().entries["document-create:user:"+strconv.Itoa(userID)] = &rateEntry{count: documentCreateUserLimit, expiresAt: time.Now().Add(time.Minute)}
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err := a.admitFolderCreate(context.Background(), tx, userID, id); err != nil {
		t.Fatalf("existing ID replay rejected: %v", err)
	}
	if err := a.admitFolderCreate(context.Background(), tx, userID, "new-id"); !errors.Is(err, errDocumentCreateRateLimited) {
		t.Fatalf("folder bypassed shared rate budget: %v", err)
	}
}

func TestFolderLimitOrganizerReplayAndDeletionRecovery(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{SessionSecret: "folder-recovery", FolderCountLimit: 1}, pool)
	ctx := context.Background()
	id, _ := randomUUID()
	first, created, _, err := a.createOrganizerFolder(ctx, userID, id, "", "Organized", folderOrganizerSmart)
	if err != nil || !created {
		t.Fatalf("create organizer: %v %v", created, err)
	}
	_, created, _, err = a.createOrganizerFolder(ctx, userID, id, "", "Organized", folderOrganizerSmart)
	if err != nil || created {
		t.Fatalf("replay at cap: %v %v", created, err)
	}
	other, _ := randomUUID()
	if _, _, _, err := a.createOrganizerFolder(ctx, userID, other, "", "Another", folderOrganizerSmart); !errors.Is(err, errFolderCountLimit) {
		t.Fatalf("organizer bypassed cap: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM folders WHERE folder_id=$1`, first.FolderID); err != nil {
		t.Fatal(err)
	}
	if _, created, _, err := a.createOrganizerFolder(ctx, userID, other, "", "Another", folderOrganizerSmart); err != nil || !created {
		t.Fatalf("deletion did not release folder capacity: %v %v", created, err)
	}
}

func TestFolderLimitMCPUsesSharedBoundary(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{FolderCountLimit: 1}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	ctx := context.WithValue(context.Background(), mcpPrincipalContextKey{}, mcpPrincipal{User: user, Scope: "write"})
	if _, _, err := a.mcpCreateFolder(ctx, nil, mcpCreateFolderInput{Name: "First"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.mcpCreateFolder(ctx, nil, mcpCreateFolderInput{Name: "Second"}); !errors.Is(err, errFolderCountLimit) {
		t.Fatalf("MCP bypassed folder limit: %v", err)
	}
}
