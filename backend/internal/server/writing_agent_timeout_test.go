package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestWritingModelTimeoutSubmissionAndRestartRetry(t *testing.T) {
	for _, tc := range []struct {
		name         string
		conversation bool
		configured   int
		want         int
	}{
		{"article_default", false, 0, 180000},
		{"article_custom", false, 300000, 300000},
		{"conversation_default", true, 0, 180000},
		{"conversation_custom", true, 300000, 300000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			a.cfg.AgentGPTModelTimeoutMS = tc.configured
			var task writingTask
			if tc.conversation {
				s := agentTestSession(t, a, user, "review")
				task = agentTestTask(t, a, user, s, doc, "Improve this article")
			} else {
				task = writingTestCreate(t, a, user, doc)
			}
			ctx := context.Background()
			task.WorkspaceID = "workspace"
			if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET workspace_id=$2 WHERE id=$1`, task.ID, task.WorkspaceID); err != nil {
				t.Fatal(err)
			}
			type submission struct {
				body []byte
				key  string
			}
			submissions := make(chan submission, 2)
			var attempts, connections atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.Method + " " + r.URL.Path {
				case "POST /api/workspaces/workspace/mcp":
					connections.Add(1)
					io.WriteString(w, `{}`)
				case "POST /api/workspaces/workspace/mcp/koinote/connect":
					io.WriteString(w, `{"state":"ready","tools":["get_document","propose_document_change","search_documents","list_folders","propose_operations","get_conversation","save_artifact"]}`)
				case "GET /api/workspaces/workspace/skills":
					io.WriteString(w, `[]`)
				case "POST /api/workspaces/workspace/skills/install":
					io.WriteString(w, `{"id":"test-skill"}`)
				case "POST /api/workspaces/workspace/skills/test-skill/status":
					io.WriteString(w, `{}`)
				case "POST /api/agent/jobs":
					body, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
					}
					submissions <- submission{body, r.Header.Get("Idempotency-Key")}
					if attempts.Add(1) == 1 {
						http.Error(w, `{"error":"temporarily unavailable"}`, 503)
						return
					}
					io.WriteString(w, `{"id":"job","status":"running"}`)
				case "GET /api/agent/workspace/jobs/job":
					io.WriteString(w, `{"id":"job","status":"running"}`)
				case "GET /api/agent/workspace/jobs/job/events":
					io.WriteString(w, `{"events":[],"hasMore":false}`)
				default:
					t.Errorf("unexpected remote request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer remote.Close()
			a.cfg.AgentGPTBaseURL = remote.URL
			err := a.advanceWritingTask(ctx, &task)
			var remoteErr *writingRemoteError
			if !errors.As(err, &remoteErr) || remoteErr.Status != 503 {
				t.Fatalf("expected retryable submission failure: %v", err)
			}
			first := <-submissions
			var input struct {
				Policy struct {
					ModelTimeoutMS int `json:"modelTimeoutMs"`
					ToolTimeoutMS  int `json:"toolTimeoutMs"`
				} `json:"policy"`
			}
			if err = json.Unmarshal(first.body, &input); err != nil {
				t.Fatal(err)
			}
			if input.Policy.ModelTimeoutMS != tc.want || input.Policy.ToolTimeoutMS != 120000 {
				t.Fatalf("submitted wrong timeouts: %+v", input.Policy)
			}
			// Simulate a process restart with a changed timeout. The exact saved
			// submission must survive, or the same idempotency key gets a new body.
			cfg := a.cfg
			cfg.AgentGPTModelTimeoutMS = 240000
			restarted := New(cfg, a.db)
			task, err = restarted.loadWritingTask(ctx, task.ID, user.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err = restarted.advanceWritingTask(ctx, &task); err != nil {
				t.Fatal(err)
			}
			second := <-submissions
			if !bytes.Equal(first.body, second.body) || first.key != "koinote-writing-"+task.ID || second.key != first.key {
				t.Fatal("retry changed the saved body or idempotency key")
			}
			if connections.Load() != 1 || task.JobID != "job" {
				t.Fatal("retry repeated setup or failed to resume the job")
			}
		})
	}
}
