package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func writingTestRequest(t *testing.T, a *App, user model.User, method, path string, input any, headers ...http.Header) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(input)
	r := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
	r.Header.Set("Content-Type", "application/json")
	for _, fields := range headers {
		for name, values := range fields {
			r.Header[name] = values
		}
	}
	r.AddCookie(sessionCookieFor(t, a, user.AuthUserID, user.SessionVersion))
	w := httptest.NewRecorder()
	a.Routes().ServeHTTP(w, r)
	return w
}
func writingTestCreate(t *testing.T, a *App, user model.User, doc model.Document) writingTask {
	t.Helper()
	id, _ := randomUUID()
	w := writingTestRequest(t, a, user, "POST", "/api/writing-agent/tasks", writingCreateInput{RequestID: id, DocID: doc.DocID, ExpectedRevision: doc.Revision, Message: "Improve this article"})
	if w.Code != 202 {
		t.Fatalf("create %d: %s", w.Code, w.Body.String())
	}
	var result struct {
		Task writingTask `json:"task"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	task, err := a.loadWritingTask(context.Background(), result.Task.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	return task
}
func writingTestApp(t *testing.T) (*App, model.User, model.Document) {
	t.Helper()
	a, pool, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "writing-test-secret", AgentGPTBaseURL: "https://agent.example.test", AgentGPTAPIKey: "test-key", AgentGPTAppID: "test-app", AgentGPTSigningSecret: "test-signing"})
	grantLifetimeCreditsForTest(t, pool, user.ID)
	return a, user, doc
}

func TestWritingCallbackAndUsageValidation(t *testing.T) {
	now := time.Unix(1800000000, 0)
	stamp := strconv.FormatInt(now.Unix(), 10)
	body := []byte(`{"jobId":"job"}`)
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write([]byte(stamp + "."))
	mac.Write(body)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if !verifyWritingCallback("secret", stamp, signature, body, now) {
		t.Fatal("valid callback rejected")
	}
	if verifyWritingCallback("secret", stamp, signature, []byte(`{}`), now) || verifyWritingCallback("secret", stamp, signature, body, now.Add(301*time.Second)) || verifyWritingCallback("other", stamp, signature, body, now) {
		t.Fatal("forged or expired callback accepted")
	}
	for _, raw := range []string{`null`, `{}`, `{"totalTokens":-1}`, `{"totalTokens":1.5}`, `{"totalTokens":2000,"incomplete":true}`, `{"inputTokens":100}`} {
		if _, ok := writingUsageTokens([]byte(raw)); ok {
			t.Fatalf("invalid usage accepted: %s", raw)
		}
	}
	for raw, want := range map[string]int{`{"totalTokens":0}`: 0, `{"totalTokens":2001}`: 2001, `{"inputTokens":100,"outputTokens":200}`: 300} {
		got, ok := writingUsageTokens([]byte(raw))
		if !ok || got != want {
			t.Fatalf("usage %s = %d,%v", raw, got, ok)
		}
	}
}

func TestWritingRequestSignatureCanonicalization(t *testing.T) {
	u, _ := url.Parse("https://example.test/a%20b?z=hello+world&x=%21&x=a")
	digest := sha256.Sum256([]byte(`{}`))
	message := "agts-v1\nPOST\n/a%20b\nx=!&x=a&z=hello%20world\n123\nnonce-123456789012\n" + hex.EncodeToString(digest[:])
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write([]byte(message))
	want := "t=123,n=nonce-123456789012,v1=" + hex.EncodeToString(mac.Sum(nil))
	if got := agentRequestSignature("secret", "POST", u, []byte(`{}`), "123", "nonce-123456789012"); got != want {
		t.Fatalf("wrong signature: %s", got)
	}
}

func TestWritingTaskMCPApplyAndBilling(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := writingTestCreate(t, a, user, doc)
	ctx := context.Background()
	server := httptest.NewServer(a.Routes())
	defer server.Close()
	client, err := connectMCPClient(ctx, server.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	assertMCPToolSet(t, client, []string{"get_document", "propose_document_change"})
	read, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "get_document", Arguments: writingReadInput{}})
	if err != nil || read.IsError {
		t.Fatalf("read: %v %v", read, err)
	}
	var snapshot writingReadOutput
	structured, err := json.Marshal(read.StructuredContent)
	if err != nil || json.Unmarshal(structured, &snapshot) != nil || snapshot.DocID != doc.DocID || snapshot.Revision != doc.Revision || snapshot.Content != doc.Content {
		t.Fatal("implicit current-document read did not return the bound document identity, revision and content")
	}
	other, _ := randomUUID()
	bad, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "get_document", Arguments: writingReadInput{DocID: other}})
	if err != nil || !bad.IsError {
		t.Fatalf("outside scope read: %v %v", bad, err)
	}
	proposed := writingProposalInput{DocID: doc.DocID, ExpectedRevision: doc.Revision, Title: "Improved title", Content: "Revised complete article.", Explanation: "Clearer writing"}
	saved, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "propose_document_change", Arguments: proposed})
	if err != nil || saved.IsError {
		t.Fatalf("proposal: %v %v", saved, err)
	}
	unchanged, _ := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if unchanged.Content != doc.Content {
		t.Fatal("MCP changed document before confirmation")
	}
	proposed.Content = "Another proposal"
	different, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "propose_document_change", Arguments: proposed})
	if err != nil || !different.IsError {
		t.Fatal("proposal was not immutable")
	}
	task.JobID = "remote-job"
	if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":2001}`), "Ready for review"); err != nil {
		t.Fatal(err)
	}
	if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":2001}`), "Ready for review"); err != nil {
		t.Fatal(err)
	}
	task, _ = a.loadWritingTask(ctx, task.ID, user.ID)
	if task.ChargedCredits != 2 || task.BillingStatus != "settled" {
		t.Fatalf("billing %+v", task)
	}
	for i := 0; i < 2; i++ {
		response := writingTestRequest(t, a, user, "POST", "/api/writing-agent/tasks/"+task.ID+"/apply", map[string]any{"expectedRevision": doc.Revision, "proposalHash": task.Proposal.Hash})
		if response.Code != 200 {
			t.Fatalf("apply: %d %s", response.Code, response.Body.String())
		}
	}
	final, _ := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if final.Content != "Revised complete article." || final.Revision != doc.Revision+1 {
		t.Fatalf("applied content/revision: %+v", final)
	}
	var count int
	err = a.db.QueryRow(ctx, `SELECT count(*) FROM credit_transactions WHERE user_id=$1 AND kind='agent_usage'`, user.ID).Scan(&count)
	if err != nil || count != 1 {
		t.Fatalf("duplicate charges: %d %v", count, err)
	}
	_, err = connectMCPClient(ctx, server.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err == nil {
		t.Fatal("terminal task credential still accepted")
	}
}

func TestWritingTaskStaleProposalAndIdempotency(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := writingTestCreate(t, a, user, doc)
	ctx := context.Background()
	var requestID string
	if err := a.db.QueryRow(ctx, `SELECT request_key::text FROM writing_agent_tasks WHERE id=$1`, task.ID).Scan(&requestID); err != nil {
		t.Fatal(err)
	}
	for _, message := range []string{task.Message, "Different input"} {
		w := writingTestRequest(t, a, user, "POST", "/api/writing-agent/tasks", writingCreateInput{RequestID: requestID, DocID: doc.DocID, ExpectedRevision: doc.Revision, Message: message})
		want := 200
		if message != task.Message {
			want = 409
		}
		if w.Code != want {
			t.Fatalf("replay: %d %s", w.Code, w.Body.String())
		}
	}
	_, _, err := a.writingProposeDocument(context.WithValue(ctx, writingMCPContext{}, task), nil, writingProposalInput{DocID: doc.DocID, ExpectedRevision: doc.Revision, Title: doc.Title, Content: "Proposal", Explanation: "Edit"})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":0}`), ""); err != nil {
		t.Fatal(err)
	}
	task, _ = a.loadWritingTask(ctx, task.ID, user.ID)
	_, err = a.db.Exec(ctx, `UPDATE documents SET content='Newer user edit',revision=revision+1 WHERE doc_id=$1`, doc.DocID)
	if err != nil {
		t.Fatal(err)
	}
	w := writingTestRequest(t, a, user, "POST", "/api/writing-agent/tasks/"+task.ID+"/apply", map[string]any{"expectedRevision": doc.Revision, "proposalHash": task.Proposal.Hash})
	if w.Code != 409 {
		t.Fatalf("stale proposal: %d %s", w.Code, w.Body.String())
	}
	current, _ := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if current.Content != "Newer user edit" {
		t.Fatal("newer edit lost")
	}
	otherApp, otherUser, _ := writingTestApp(t)
	w = writingTestRequest(t, otherApp, otherUser, "GET", "/api/writing-agent/tasks/"+task.ID, nil)
	if w.Code != 404 {
		t.Fatalf("cross-user task exposed: %d", w.Code)
	}
}

func TestWritingSettlementCapMissingUsageAndCancellation(t *testing.T) {
	for _, test := range []struct {
		name, usage, billing string
		charged              int64
	}{{"cap", `{"totalTokens":300000}`, "settled", 100}, {"missing", `null`, "needs_review", 0}, {"incomplete", `{"totalTokens":2001,"incomplete":true}`, "needs_review", 0}, {"zero", `{"totalTokens":0}`, "settled", 0}} {
		t.Run(test.name, func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			task := writingTestCreate(t, a, user, doc)
			task.JobID = "job"
			if err := a.finishWritingTask(context.Background(), task, "failed", "", json.RawMessage(test.usage), ""); err != nil {
				t.Fatal(err)
			}
			updated, _ := a.loadWritingTask(context.Background(), task.ID, user.ID)
			if updated.ChargedCredits != test.charged || updated.BillingStatus != test.billing {
				t.Fatalf("settlement: %+v", updated)
			}
			var reserved int64
			if err := a.db.QueryRow(context.Background(), `SELECT reserved FROM credit_accounts WHERE user_id=$1`, user.ID).Scan(&reserved); err != nil || reserved != 0 {
				t.Fatalf("reservation leaked: %d %v", reserved, err)
			}
		})
	}
	t.Run("cancel before enqueue", func(t *testing.T) {
		a, user, doc := writingTestApp(t)
		task := writingTestCreate(t, a, user, doc)
		task.CancelRequested = true
		if err := a.advanceWritingTask(context.Background(), &task); err != nil {
			t.Fatal(err)
		}
		task, _ = a.loadWritingTask(context.Background(), task.ID, user.ID)
		if task.Status != "cancelled" || task.BillingStatus != "released" {
			t.Fatal("cancel did not release reservation")
		}
	})
}

func TestWritingWorkerResumesIdempotentSubmission(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := writingTestCreate(t, a, user, doc)
	var mu sync.Mutex
	submissions := 0
	var original []byte
	published := false
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/users"):
			io.WriteString(w, `{}`)
		case r.URL.Path == "/api/workspaces" && r.Method == "GET":
			io.WriteString(w, `{"workspaces":[]}`)
		case r.URL.Path == "/api/workspaces/ensure":
			io.WriteString(w, `{"workspace":{"id":"workspace"}}`)
		case strings.HasSuffix(r.URL.Path, "/mcp"):
			io.WriteString(w, `{}`)
		case strings.HasSuffix(r.URL.Path, "/connect"):
			io.WriteString(w, `{"state":"ready","tools":["get_document","propose_document_change"]}`)
		case strings.HasSuffix(r.URL.Path, "/skills"):
			io.WriteString(w, `[]`)
		case strings.HasSuffix(r.URL.Path, "/install"):
			io.WriteString(w, `{"id":"skill"}`)
		case strings.HasSuffix(r.URL.Path, "/status"):
			published = true
			io.WriteString(w, `{}`)
		case r.URL.Path == "/api/agent/jobs":
			if !published {
				t.Error("job submitted without publishing skill")
			}
			submissions++
			body, _ := io.ReadAll(r.Body)
			if submissions == 1 {
				original = body
				http.Error(w, "lost response", 503)
				return
			}
			if string(body) != string(original) {
				t.Error("retry input changed")
			}
			if r.Header.Get("Idempotency-Key") != "koinote-writing-"+task.ID {
				t.Error("missing idempotency key")
			}
			io.WriteString(w, `{"id":"job","status":"running"}`)
		case strings.HasSuffix(r.URL.Path, "/events"):
			io.WriteString(w, `{"events":[{"seq":1,"event":{"type":"run.completed"}}],"hasMore":false}`)
		case strings.HasSuffix(r.URL.Path, "/job"):
			io.WriteString(w, `{"id":"job","status":"completed","result":{"text":"Done","usage":{"totalTokens":123}}}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	a.cfg.AgentGPTPublicURL = "https://koinote.example.test"
	if err := a.advanceWritingTask(context.Background(), &task); err == nil {
		t.Fatal("expected ambiguous enqueue failure")
	}
	task, err := a.loadWritingTask(context.Background(), task.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(task.RemoteInput) == 0 {
		t.Fatal("submission not persisted")
	}
	a.cfg.AgentGPTPublicURL = "https://changed.example.test"
	if err = a.advanceWritingTask(context.Background(), &task); err != nil {
		t.Fatal(err)
	}
	task, _ = a.loadWritingTask(context.Background(), task.ID, user.ID)
	if task.Status != "completed" || task.ChargedCredits != 1 || task.Cursor != 1 {
		t.Fatalf("recovered task %+v", task)
	}
}

func TestWritingWebhookReplayOnlyWakesWorker(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := writingTestCreate(t, a, user, doc)
	ctx := context.Background()
	_, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET workspace_id='workspace',job_id='job' WHERE id=$1`, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	body := `{"jobId":"job","workspaceId":"workspace","data":{"usage":{"totalTokens":999999}}}`
	stamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(a.writingSecret(task.ID, "callback")))
	fmt.Fprint(mac, stamp+"."+body)
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest("POST", "/api/writing-agent/callback/"+task.ID, strings.NewReader(body))
		r.Header.Set("X-Agent-Timestamp", stamp)
		r.Header.Set("X-Agent-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		r.Header.Set("X-Agent-Delivery", "delivery-1")
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, r)
		if w.Code != 204 {
			t.Fatalf("callback: %d %s", w.Code, w.Body.String())
		}
	}
	task, _ = a.loadWritingTask(ctx, task.ID, user.ID)
	if task.BillingStatus != "reserved" || task.ChargedCredits != 0 {
		t.Fatal("callback charged credits")
	}
	var deliveries int
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM writing_agent_deliveries WHERE task_id=$1`, task.ID).Scan(&deliveries); err != nil || deliveries != 1 {
		t.Fatalf("deliveries: %d %v", deliveries, err)
	}
}

func TestWritingSkillSnapshotPreservesNativeMetadataAndOwnership(t *testing.T) {
	a, user, _ := writingTestApp(t)
	ctx := context.Background()
	var repositoryID int64
	if err := a.db.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description,revision) VALUES($1,'My Skill','Test',1) RETURNING id`, user.ID).Scan(&repositoryID); err != nil {
		t.Fatal(err)
	}
	instruction := "---\nname: Writer\ndescription: Writes articles\nscripts:\n  calculate: scripts/calculate.py\nruntime:\n  kind: python\n---\nRead the article before proposing changes."
	for path, content := range map[string]string{"skills/writer/SKILL.md": instruction, "skills/writer/scripts/calculate.py": "print(55)", "unrelated.txt": "excluded"} {
		digest := sha256.Sum256([]byte(content))
		hash := hex.EncodeToString(digest[:])
		if _, err := a.db.Exec(ctx, `INSERT INTO agent_workspace_blobs(workspace_id,sha256,content) VALUES($1,$2,$3)`, repositoryID, hash, []byte(content)); err != nil {
			t.Fatal(err)
		}
		if _, err := a.db.Exec(ctx, `INSERT INTO agent_workspace_files(workspace_id,path,content,mime_type,size_bytes,sha256) VALUES($1,$2,NULL,'text/plain',$3,$4)`, repositoryID, path, len(content), hash); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := a.writingSkill(ctx, user.ID, repositoryID, "skills/writer/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Instructions string          `json:"instructions"`
		Manifest     json.RawMessage `json:"manifest"`
		Files        []struct {
			Path string `json:"path"`
		} `json:"files"`
	}
	if err = json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	if pkg.Instructions != instruction || len(pkg.Manifest) != 0 || len(pkg.Files) != 1 || pkg.Files[0].Path != "scripts/calculate.py" {
		t.Fatalf("skill metadata or directory scope lost: %s", raw)
	}
	if _, err = a.writingSkill(ctx, user.ID+100000, repositoryID, "skills/writer/SKILL.md"); err == nil {
		t.Fatal("another user's skill accepted")
	}
	if _, err = a.writingSkill(ctx, user.ID, repositoryID, "skills/../SKILL.md"); err == nil {
		t.Fatal("traversal accepted")
	}
	response := writingTestRequest(t, a, user, "GET", "/api/writing-agent/config", nil)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"path":"skills/writer/SKILL.md"`) {
		t.Fatalf("Skill options missing: %d %s", response.Code, response.Body.String())
	}
}

func TestWritingWorkerClaimAndExpiredRecovery(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := writingTestCreate(t, a, user, doc)
	ctx := context.Background()
	if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET deadline=now()-interval '11 minutes',lease_until=now()-interval '1 minute',remote_input='{}' WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if err := a.writingTick(ctx); err != nil {
		t.Fatal(err)
	}
	updated, err := a.loadWritingTask(ctx, task.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != "failed" || updated.ChargedCredits != 0 || updated.BillingStatus != "needs_review" {
		t.Fatalf("expired recovery: %+v", updated)
	}
	var reserved int64
	if err = a.db.QueryRow(ctx, `SELECT reserved FROM credit_accounts WHERE user_id=$1`, user.ID).Scan(&reserved); err != nil || reserved != 0 {
		t.Fatalf("expired reservation: %d %v", reserved, err)
	}
}

func TestWritingWorkerWaitsForDocumentTools(t *testing.T) {
	for _, response := range []string{`{"state":"failed","tools":[]}`, `{"state":"ready","tools":["get_document"]}`, `{}`} {
		t.Run(response, func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			task := writingTestCreate(t, a, user, doc)
			task.WorkspaceID = "workspace"
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/workspaces/workspace/mcp":
					io.WriteString(w, `{}`)
				case "/api/workspaces/workspace/mcp/koinote/connect":
					io.WriteString(w, response)
				default:
					t.Errorf("started setup/job without document tools: %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer remote.Close()
			a.cfg.AgentGPTBaseURL = remote.URL
			if err := a.advanceWritingTask(context.Background(), &task); err == nil || !strings.Contains(err.Error(), "not ready") {
				t.Fatalf("unready MCP accepted: %v", err)
			}
			if task.JobID != "" || len(task.RemoteInput) != 0 {
				t.Fatal("job prepared before document connection was ready")
			}
		})
	}
}

func TestWritingEventBacklogResumesBeforeSettlement(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := writingTestCreate(t, a, user, doc)
	task.WorkspaceID, task.JobID = "workspace", "job"
	const total = 277
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.HasSuffix(r.URL.Path, "/events") {
			io.WriteString(w, `{"id":"job","status":"completed","result":{"text":"Done","usage":{"totalTokens":123}}}`)
			return
		}
		after, err := strconv.Atoi(r.URL.Query().Get("after"))
		if err != nil || r.URL.Query().Get("page") != "1" {
			t.Error("missing event cursor or pagination mode")
		}
		events := []map[string]any{}
		for seq := after + 1; seq <= min(after+25, total); seq++ {
			events = append(events, map[string]any{"seq": seq, "event": map[string]any{"type": "model.delta", "text": "x"}})
		}
		json.NewEncoder(w).Encode(map[string]any{"events": events, "hasMore": after+25 < total})
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	ctx := context.Background()
	if err := a.advanceWritingTask(ctx, &task); !errors.Is(err, errWritingEventBacklog) {
		t.Fatalf("expected bounded event backlog, got %v", err)
	}
	stored, err := a.loadWritingTask(ctx, task.ID, user.ID)
	if err != nil || stored.Cursor != 250 || stored.BillingStatus != "reserved" || writingTerminal(stored.Status) {
		t.Fatalf("settled before events persisted: cursor=%d billing=%s status=%s error=%v", stored.Cursor, stored.BillingStatus, stored.Status, err)
	}
	if err = a.advanceWritingTask(ctx, &task); err != nil {
		t.Fatal(err)
	}
	stored, err = a.loadWritingTask(ctx, task.ID, user.ID)
	if err != nil || stored.Cursor != total || stored.Status != "completed" || stored.ChargedCredits != 1 {
		t.Fatalf("backlog did not resume: cursor=%d status=%s charged=%d error=%v", stored.Cursor, stored.Status, stored.ChargedCredits, err)
	}
	var count int
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM writing_agent_events WHERE task_id=$1`, task.ID).Scan(&count); err != nil || count != total {
		t.Fatalf("events lost or duplicated: %d %v", count, err)
	}
}

func TestWritingClientSigningDoesNotDowngrade(t *testing.T) {
	calls := 0
	var nonce string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		raw, _ := io.ReadAll(r.Body)
		fields := strings.Split(r.Header.Get("X-Agent-Signature"), ",")
		if len(fields) != 3 {
			t.Error("signature missing")
			http.Error(w, "missing signature", 401)
			return
		}
		timestamp := strings.TrimPrefix(fields[0], "t=")
		currentNonce := strings.TrimPrefix(fields[1], "n=")
		if currentNonce == nonce {
			t.Error("nonce reused")
		}
		nonce = currentNonce
		if got := agentRequestSignature("test-signing", "POST", r.URL, raw, timestamp, currentNonce); got != r.Header.Get("X-Agent-Signature") {
			t.Error("wire body differs from signed bytes")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(401)
		io.WriteString(w, `{"error":"signature rejected"}`)
	}))
	defer remote.Close()
	a := &App{cfg: config.Config{AgentGPTBaseURL: remote.URL, AgentGPTAPIKey: "key", AgentGPTSignRequests: true, AgentGPTSigningSecret: "test-signing"}}
	for i := 0; i < 2; i++ {
		if err := a.agentGPTRequest(context.Background(), "POST", "/test?b=hello+world&a=1", "", "same-business-key", map[string]string{"message": "中文 <article>"}, nil); err == nil {
			t.Fatal("401 accepted")
		}
	}
	if calls != 2 {
		t.Fatalf("unexpected retries or signature downgrade: %d", calls)
	}
}

func TestWritingConcurrentCreateOnlyReservesOnce(t *testing.T) {
	a, user, doc := writingTestApp(t)
	id, _ := randomUUID()
	input := writingCreateInput{RequestID: id, DocID: doc.DocID, ExpectedRevision: doc.Revision, Message: "Improve the article"}
	codes := make(chan int, 2)
	var group sync.WaitGroup
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			codes <- writingTestRequest(t, a, user, "POST", "/api/writing-agent/tasks", input).Code
		}()
	}
	group.Wait()
	close(codes)
	for code := range codes {
		if code != 200 && code != 202 {
			t.Fatalf("concurrent create status %d", code)
		}
	}
	var count int
	var reserved int64
	ctx := context.Background()
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM writing_agent_tasks WHERE user_id=$1`, user.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(ctx, `SELECT reserved FROM credit_accounts WHERE user_id=$1`, user.ID).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if count != 1 || reserved != writingReservationCredits {
		t.Fatalf("duplicate task/reservation: %d %d", count, reserved)
	}
}

func TestWritingExpiredTaskReconcilesRemoteSettlement(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := writingTestCreate(t, a, user, doc)
	task.WorkspaceID, task.JobID = "workspace", "job"
	task.Deadline = time.Now().Add(-15 * time.Minute)
	if _, err := a.db.Exec(context.Background(), "UPDATE writing_agent_tasks SET deadline=$2 WHERE id=$1", task.ID, task.Deadline); err != nil {
		t.Fatal(err)
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Query().Get("view") != "settlement" {
			t.Error("expected final read-only settlement", r.URL)
			w.WriteHeader(503)
			return
		}
		fmt.Fprint(w, `{"id":"job","status":"completed","result":{"text":"远端已完成","usage":{"totalTokens":123}}}`)
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := a.advanceWritingTask(ctx, &task); err != nil {
			t.Fatal(err)
		}
		saved, err := a.loadWritingTask(ctx, task.ID, user.ID)
		if err != nil || saved.Status != "completed" || saved.Result != "远端已完成" || saved.ChargedCredits <= 0 {
			t.Fatal(saved.Status, saved.ChargedCredits, err)
		}
	}
}

func TestWritingResumeHonorsRenewedDeadline(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := writingTestCreate(t, a, user, doc)
	task.WorkspaceID, task.JobID = "workspace", "job"
	// The worker snapshot predates an approval transaction which renewed the deadline.
	task.Deadline = time.Now().Add(-15 * time.Minute)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("unexpected remote mutation after renewal: %s", r.URL)
			http.Error(w, "unexpected cancellation", 500)
			return
		}
		if r.URL.Query().Get("view") == "settlement" {
			fmt.Fprint(w, `{"id":"job","status":"running"}`)
			return
		}
		fmt.Fprint(w, `{"events":[],"hasMore":false}`)
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	if err := a.advanceWritingTask(context.Background(), &task); err != nil {
		t.Fatal(err)
	}
	saved, err := a.loadWritingTask(context.Background(), task.ID, user.ID)
	if err != nil || saved.Status != "running" || saved.BillingStatus != "reserved" {
		t.Fatal(saved.Status, saved.BillingStatus, err)
	}
}
