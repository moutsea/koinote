package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

func approvalBatchBody(ops []agentOperation) map[string]any {
	items := []map[string]string{}
	for _, op := range ops {
		items = append(items, map[string]string{"id": op.ID, "hash": op.Hash})
	}
	return map[string]any{"operations": items}
}
func approvalFolderInputs() []agentOperationInput {
	inputs := []agentOperationInput{}
	for i := 0; i < 4; i++ {
		inputs = append(inputs, agentOperationInput{Key: fmt.Sprintf("folder-%d", i), Kind: "folder", Title: fmt.Sprintf("Topic %d", i), Explanation: "Group documents"})
	}
	return inputs
}

func TestAgentApprovalBatchAtomicReplayAndSnapshot(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	task := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "Organize my documents by topic")
	ops, err := proposeAgentOperationsForTest(a, ctx, task, approvalFolderInputs())
	if err != nil {
		t.Fatal(err)
	}
	extra, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "later", Kind: "folder", Title: "Later proposal"}})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/agent/tasks/" + task.ID + "/operations/approve"
	bad := append([]agentOperation(nil), ops...)
	bad[3].Hash = "stale"
	if w := writingTestRequest(t, a, u, "POST", path, approvalBatchBody(bad)); w.Code != 409 {
		t.Fatalf("stale batch: %d %s", w.Code, w.Body.String())
	}
	var count int
	a.db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE user_id=$1`, u.ID).Scan(&count)
	if count != 0 {
		t.Fatal("partial batch was committed", count)
	}
	for i := 0; i < 2; i++ {
		if w := writingTestRequest(t, a, u, "POST", path, approvalBatchBody(ops)); w.Code != 200 {
			t.Fatalf("approve: %d %s", w.Code, w.Body.String())
		}
	}
	a.db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE user_id=$1`, u.ID).Scan(&count)
	if count != 4 {
		t.Fatal("folders duplicated or missing", count)
	}
	var status string
	a.db.QueryRow(ctx, `SELECT status FROM agent_operations WHERE id=$1`, extra[0].ID).Scan(&status)
	if status != "pending" {
		t.Fatal("unseen later proposal approved", status)
	}
	if w := writingTestRequest(t, a, u, "POST", path, approvalBatchBody([]agentOperation{ops[0], ops[0]})); w.Code != 400 {
		t.Fatalf("duplicate ids: %d", w.Code)
	}
}

func TestAgentApprovalBatchFailureRollsBackWrites(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	task := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "Organize my documents")
	inputs := approvalFolderInputs()
	inputs[1].Title = inputs[0].Title
	ops, err := proposeAgentOperationsForTest(a, ctx, task, inputs)
	if err != nil {
		t.Fatal(err)
	}
	w := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/approve", approvalBatchBody(ops))
	if w.Code == 200 {
		t.Fatal("conflicting folders accepted")
	}
	var count int
	a.db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE user_id=$1`, u.ID).Scan(&count)
	if count != 0 {
		t.Fatal("partial folders committed", count)
	}
	a.db.QueryRow(ctx, `SELECT count(*) FROM agent_operations WHERE task_id=$1 AND status='pending'`, task.ID).Scan(&count)
	if count != 4 {
		t.Fatal("partial decisions committed", count)
	}
}

func TestAgentApprovalPauseResumeAndIsolation(t *testing.T) {
	for _, decision := range []string{"approve", "reject", "cancel", "retry"} {
		t.Run(decision, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			task := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "Organize my documents")
			if claimed, err := a.claimAgentDispatch(ctx, &task); err != nil || !claimed {
				t.Fatal("dispatch", claimed, err)
			}
			ops, err := proposeAgentOperationsForTest(a, ctx, task, approvalFolderInputs())
			if err != nil {
				t.Fatal(err)
			}
			ids := []string{}
			for _, op := range ops {
				ids = append(ids, op.ID)
			}
			input, _ := json.Marshal(map[string]any{"version": 1, "operationIds": ids})
			job := writingRemoteJob{ID: "job-approval", Status: "awaiting_approval", Approval: &agentRemoteApproval{ToolName: "host_operations", CheckpointID: "gate-A", ToolCallID: "host-operations:2", Input: input, ExpiresAt: time.Now().Add(time.Hour).UTC()}}
			var requests atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/api/agent/workspace/jobs/job-approval/approve-checkpoint" {
					t.Errorf("unexpected remote request %s %s", r.Method, r.URL.Path)
				}
				var wake struct {
					CheckpointID string   `json:"checkpointId"`
					ToolCallID   string   `json:"toolCallId"`
					OperationIDs []string `json:"operationIds"`
				}
				if err := json.NewDecoder(r.Body).Decode(&wake); err != nil || wake.CheckpointID != job.Approval.CheckpointID || wake.ToolCallID != job.Approval.ToolCallID || !slices.Equal(wake.OperationIDs, ids) {
					t.Errorf("unbound wake-up: %+v", wake)
				}
				if decision == "approve" {
					exportAgentContract(t, "wake", wake)
				}
				if requests.Add(1) == 1 && decision == "retry" {
					w.WriteHeader(503)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"approved":true}`)
			}))
			defer remote.Close()
			a.cfg.AgentGPTBaseURL = remote.URL
			path := "/api/agent/workspace/jobs/job-approval"
			if err = a.advanceAgentApproval(ctx, &task, job, path); err != nil {
				t.Fatal(err)
			}
			paused, err := a.loadWritingTask(ctx, task.ID, u.ID)
			if err != nil {
				t.Fatal(err)
			}
			if paused.Status != "awaiting_approval" || paused.BillingStatus != "reserved" || !paused.Deadline.After(task.Deadline.Add(30*time.Minute)) {
				t.Fatal("wait was not persisted or charged prematurely", paused.Status, paused.BillingStatus, paused.Deadline)
			}
			if err = a.advanceAgentApproval(ctx, &paused, job, path); err != nil {
				t.Fatal(err)
			}
			repeated, _ := a.loadWritingTask(ctx, task.ID, u.ID)
			if !repeated.Deadline.Equal(paused.Deadline) {
				t.Fatal("poll extended approval indefinitely")
			}
			if requests.Load() != 0 {
				t.Fatal("resumed without decisions")
			}
			mcpctx := context.WithValue(ctx, writingMCPContext{}, paused)
			if _, _, err = a.agentOperationResults(mcpctx, nil, agentApprovalInput{OperationIDs: []string{mustAgentUUID(t)}}); err == nil {
				t.Fatal("foreign operation accepted")
			}
			if decision == "cancel" {
				if err = a.cancelAgentTask(ctx, u.ID, task.ID); err != nil {
					t.Fatal(err)
				}
				if err = a.advanceAgentApproval(ctx, &paused, job, path); err == nil {
					t.Fatal("cancelled task resumed")
				}
				if requests.Load() != 0 {
					t.Fatal("cancelled task sent wake-up")
				}
				return
			}
			action := decision
			if action == "retry" {
				action = "approve"
			}
			// Individual decisions cannot wake a partially resolved batch.
			w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/"+action, map[string]string{"hash": ops[0].Hash})
			if w.Code != 200 {
				t.Fatalf("first decision: %d %s", w.Code, w.Body.String())
			}
			if err = a.advanceAgentApproval(ctx, &paused, job, path); err != nil {
				t.Fatal(err)
			}
			if requests.Load() != 0 {
				t.Fatal("partial batch resumed")
			}
			w = writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/"+action, approvalBatchBody(ops))
			if w.Code != 200 {
				t.Fatalf("batch decision: %d %s", w.Code, w.Body.String())
			}
			_, result, err := a.agentOperationResults(mcpctx, nil, agentApprovalInput{OperationIDs: ids})
			if err != nil {
				t.Fatal(err)
			}
			statuses := result["operations"].([]map[string]any)
			for _, op := range statuses {
				if op["status"] == "pending" {
					t.Fatal("stale resolution")
				}
			}
			if decision == "approve" {
				var occupying []writingTask
				for i := 0; i < 2; i++ {
					other := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "阅读文章")
					claimed, e := a.claimAgentDispatch(ctx, &other)
					if e != nil || !claimed {
						t.Fatal("paused task occupied a slot", claimed, e)
					}
					occupying = append(occupying, other)
				}
				if err = a.advanceAgentApproval(ctx, &paused, job, path); err != nil || requests.Load() != 0 {
					t.Fatal("wake-up bypassed execution limit", requests.Load(), err)
				}
				if err = a.finishWritingTask(ctx, occupying[0], "completed", "", json.RawMessage(`{"totalTokens":0}`), ""); err != nil {
					t.Fatal(err)
				}
			}
			if decision == "retry" {
				if err = a.advanceAgentApproval(ctx, &paused, job, path); err == nil {
					t.Fatal("network failure hidden")
				}
				paused, err = a.loadWritingTask(ctx, task.ID, u.ID)
				if err != nil {
					t.Fatal(err)
				}
			}
			if err = a.advanceAgentApproval(ctx, &paused, job, path); err != nil {
				t.Fatal(err)
			}
			resumed, _ := a.loadWritingTask(ctx, task.ID, u.ID)
			if decision == "retry" && !resumed.Deadline.Equal(paused.Deadline) {
				t.Fatal("wake-up retry extended the execution deadline")
			}
			if resumed.Status != "queued" || resumed.ID != task.ID || resumed.IntentVersion != task.IntentVersion || resumed.ReservationID != task.ReservationID {
				t.Fatal("resume replaced logical task or reservation")
			}
			var count int
			a.db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE user_id=$1`, u.ID).Scan(&count)
			want := 4
			if decision == "reject" {
				want = 0
			}
			if count != want {
				t.Fatal("incorrect folder side effects", count)
			}
		})
	}
}

func TestAgentApprovalPublishedWhileEventsUnavailable(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	task := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "整理")
	if ok, err := a.claimAgentDispatch(ctx, &task); err != nil || !ok {
		t.Fatal(ok, err)
	}
	task.WorkspaceID, task.JobID = "workspace", "job-approval"
	if _, err := a.db.Exec(ctx, "UPDATE writing_agent_tasks SET workspace_id=$2,job_id=$3,status='running' WHERE id=$1", task.ID, task.WorkspaceID, task.JobID); err != nil {
		t.Fatal(err)
	}
	ops, err := proposeAgentOperationsForTest(a, ctx, task, approvalFolderInputs()[:1])
	if err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{"version": 1, "operationIds": []string{ops[0].ID}})
	job := writingRemoteJob{ID: task.JobID, Status: "awaiting_approval", Approval: &agentRemoteApproval{ToolName: "host_operations", CheckpointID: "gate", ToolCallID: "host-operations:1", Input: input, ExpiresAt: time.Now().Add(time.Hour)}}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("view") == "settlement" {
			json.NewEncoder(w).Encode(job)
			return
		}
		http.Error(w, "events unavailable", 503)
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	if err = a.advanceWritingTask(ctx, &task); err == nil {
		t.Fatal("event outage was not surfaced for retry")
	}
	saved, err := a.loadWritingTask(ctx, task.ID, u.ID)
	if err != nil || saved.Status != "awaiting_approval" || !saved.Deadline.After(task.Deadline) {
		t.Fatal(saved.Status, err)
	}
}
