package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"koinote/backend/internal/model"
)

func TestAgentMinorCorrectionsAreDirectional(t *testing.T) {
	for _, tc := range []struct {
		before, after string
		allowed       bool
	}{
		{"有错别子，帐户需检查。", "有错别字，账户需检查。", true},
		{"有错别子，帐户需检查。", "有错别字，帐户需检查。", true},
		{"错别字", "错别子", false},
		{"正确的账户", "正确的帐户", false},
		{"正文 \r\n", "正文\n", true},
		{"第一行  \n第二行", "第一行\n第二行", false},
		{"金额 123", "金额 124", false},
		{"http://example.test/帐户", "http://example.test/账户", false},
	} {
		if got := agentMinorCorrection(tc.before, tc.after); got != tc.allowed {
			t.Errorf("correction %q -> %q = %v", tc.before, tc.after, got)
		}
	}
}

func TestAgentSessionLongHistoryIsBoundedAndPageable(t *testing.T) {
	a, u, _ := writingTestApp(t)
	s := agentTestSession(t, a, u, "review")
	ctx := context.Background()
	for i := 0; i < 6; i++ {
		task := agentTestTask(t, a, u, s, model.Document{}, strings.Repeat("长篇请求", 1200))
		if err := a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":0}`), strings.Repeat("长篇回复", 8000)); err != nil {
			t.Fatal(err)
		}
	}
	current := agentTestTask(t, a, u, s, model.Document{}, "继续")
	cursor := ""
	seen := map[string]bool{}
	for page := 0; page < 8; page++ {
		history, next, err := a.agentConversationHistory(ctx, current, cursor, 6)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(history)
		if len(encoded) > 64<<10 || !utf8.Valid(encoded) {
			t.Fatal("unbounded or invalid context")
		}
		for _, item := range history {
			id := item["taskId"].(string)
			if seen[id] {
				t.Fatal("history cursor repeated a turn")
			}
			seen[id] = true
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if len(seen) != 6 {
		t.Fatalf("lost older history: %d turns", len(seen))
	}
}

func TestAgentSessionEventDeletionRace(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "review")
	task := agentTestTask(t, a, u, s, doc, "读取")
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"events":[{"seq":1,"event":{"type":"tool.completed","toolName":"koinote.get_document"}}],"hasMore":false}`))
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Hold the deletion transaction before commit, so the collector starts
	// against the old MVCC snapshot and must wait for the same account lock.
	tx, err := a.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	for _, q := range []string{
		`SELECT pg_advisory_xact_lock($1)`,
		`UPDATE agent_sessions SET deleted_at=now() WHERE user_id=$1`,
		`UPDATE writing_agent_tasks SET cancel_requested=true WHERE user_id=$1`,
		`DELETE FROM writing_agent_events WHERE task_id IN(SELECT id FROM writing_agent_tasks WHERE user_id=$1)`,
	} {
		if _, err = tx.Exec(ctx, q, u.ID); err != nil {
			t.Fatal(err)
		}
	}
	done := make(chan error, 1)
	go func() { done <- a.collectWritingEvents(ctx, &task, "/job") }()
	waiting := false
	for i := 0; i < 200; i++ {
		if err = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'SELECT pg_advisory_xact_lock%' OR query LIKE 'INSERT INTO writing_agent_events%' OR query LIKE 'UPDATE writing_agent_tasks SET cursor%'))`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waiting {
		t.Fatal("collector did not reach the concurrent write")
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	var count int
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM writing_agent_events WHERE task_id=$1`, task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("late events resurrected deleted history", count, err)
	}
}

func TestAgentSessionImagesSurviveUntilLastReference(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	key := gcKey(u.AuthUserID, gcHexA)
	content := "![图片](https://img.test/" + key + ")"
	t.Cleanup(func() {
		a.db.Exec(context.Background(), `DELETE FROM pending_image_deletions WHERE object_key=$1`, key)
	})
	if _, err := a.db.Exec(ctx, `UPDATE documents SET content=$2 WHERE doc_id=$1`, doc.DocID, content); err != nil {
		t.Fatal(err)
	}
	s := agentTestSession(t, a, u, "review")
	task := agentTestTask(t, a, u, s, doc, "读取文章")
	agentTestRead(t, a, task, doc)
	if _, err := a.db.Exec(ctx, `UPDATE documents SET content='' WHERE doc_id=$1`, doc.DocID); err != nil {
		t.Fatal(err)
	}
	owner := userRef{ID: u.ID, AuthUserID: u.AuthUserID}
	if count, err := a.enqueueOrphanedImageKeysChecked(ctx, owner, []string{key}); err != nil || count != 0 {
		t.Fatal("chat snapshot image was reclaimed", count, err)
	}
	shared, err := a.createDocument(ctx, createDocumentParams{User: u, Title: "保留图片", Content: content})
	if err != nil {
		t.Fatal(err)
	}
	w := writingTestRequest(t, a, u, "DELETE", "/api/agent/sessions/"+s.ID, nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if keys := pendingKeys(t, a.db, u.AuthUserID); len(keys) != 0 {
		t.Fatal("shared document image was reclaimed", keys)
	}
	if _, err = a.db.Exec(ctx, `UPDATE documents SET content='' WHERE doc_id=$1`, shared.DocID); err != nil {
		t.Fatal(err)
	}
	if count, err := a.enqueueOrphanedImageKeysChecked(ctx, owner, []string{key}); err != nil || count != 1 {
		t.Fatal("unreferenced image was retained", count, err)
	}
}

func TestAgentFailureMessagesDoNotExposeProviderSecrets(t *testing.T) {
	if got := writingFailureMessage("[intent_check_failed] Task authorization check failed: document revision conflict secret-value"); !strings.Contains(got, "提案的版本") || strings.Contains(got, "secret-value") {
		t.Fatal("document conflicts should name the stale proposal without exposing provider diagnostics", got)
	}
	if got := writingFailureMessage("Required task instructions and provenance exceed the context budget; secret-value"); !strings.Contains(got, "缩小整理范围") || strings.Contains(got, "secret-value") {
		t.Fatal("missing safe context-budget explanation")
	}
	if !strings.Contains(writingFailureMessage("Model execution timed out after 90000ms"), "超时") {
		t.Fatal("missing timeout explanation")
	}
	if got := writingFailureMessage("[invalid_intent_response] Task interpretation or review did not match its required schema: secret-value"); !strings.Contains(got, "任务解析或操作核对") || strings.Contains(got, "secret-value") {
		t.Fatal("missing safe task protocol explanation", got)
	}
	if strings.Contains(writingFailureMessage("upstream failed: secret-value"), "secret-value") {
		t.Fatal("raw provider error exposed")
	}
}

func TestAgentDocumentReplacementRequiresCompleteRead(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "full")
	content := strings.Repeat("长文", 8000)
	if _, err := a.db.Exec(context.Background(), `UPDATE documents SET content=$2 WHERE doc_id=$1`, doc.DocID, content); err != nil {
		t.Fatal(err)
	}
	task := agentTestTask(t, a, u, s, doc, "修改文章")
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	agentTestRead(t, a, task, doc)
	input := []agentOperationInput{{Key: "edit", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: content + "。"}}
	if _, err := proposeAgentOperationsForTest(a, ctx, task, input); err == nil || !strings.Contains(err.Error(), "12000") {
		t.Fatal("partial document read accepted", err)
	}
	if _, _, err := a.agentReadDocument(ctx, nil, agentReadInput{Path: input[0].Path, Offset: 15000}); err != nil {
		t.Fatal(err)
	}
	if _, err := proposeAgentOperationsForTest(a, ctx, task, input); err == nil {
		t.Fatal("skipping unread middle accepted")
	}
	if _, _, err := a.agentReadDocument(ctx, nil, agentReadInput{Path: input[0].Path, Offset: 12000}); err != nil {
		t.Fatal(err)
	}
	if ops, err := proposeAgentOperationsForTest(a, ctx, task, input); err != nil || ops[0].Status != "applied" {
		t.Fatal("complete read did not apply", err)
	}
}

func TestAgentSessionMessageImageRetention(t *testing.T) {
	a, u, _ := writingTestApp(t)
	s := agentTestSession(t, a, u, "review")
	key := gcKey(u.AuthUserID, gcHexB)
	ctx := context.Background()
	t.Cleanup(func() {
		a.db.Exec(context.Background(), `DELETE FROM pending_image_deletions WHERE object_key=$1`, key)
	})
	agentTestTask(t, a, u, s, model.Document{}, "请分析这张图片：![图片](https://img.test/"+key+")")
	owner := userRef{ID: u.ID, AuthUserID: u.AuthUserID}
	if count, err := a.enqueueOrphanedImageKeysChecked(ctx, owner, []string{key}); err != nil || count != 0 {
		t.Fatal("image referenced by a message reclaimed", count, err)
	}
	if w := writingTestRequest(t, a, u, "DELETE", "/api/agent/sessions/"+s.ID, nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if keys := pendingKeys(t, a.db, u.AuthUserID); len(keys) != 1 || keys[0] != key {
		t.Fatal("exclusive message image not released", keys)
	}
}

func TestAgentSessionDeletionClearsCompletedDispatchPayload(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "review")
	task := agentTestTask(t, a, u, s, doc, "读取")
	ctx := context.Background()
	if err := a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":0}`), "完成"); err != nil {
		t.Fatal(err)
	}
	// Imported legacy completed tasks may still carry the old dispatch body.
	if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET remote_input='{"message":"private old prompt"}',skill='{"instructions":"private skill"}' WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if w := writingTestRequest(t, a, u, "DELETE", "/api/agent/sessions/"+s.ID, nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var cleared bool
	if err := a.db.QueryRow(ctx, `SELECT remote_input IS NULL AND skill='{}'::jsonb FROM writing_agent_tasks WHERE id=$1`, task.ID).Scan(&cleared); err != nil || !cleared {
		t.Fatal("deleted chat retained old prompt", err)
	}
}
