package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestAgentGeoApprovalUndoAndGenerationCost(t *testing.T) {
	for _, mode := range []string{"review", "assist", "full"} {
		for _, existing := range []bool{false, true} {
			name := mode + "/new"
			if existing {
				name = mode + "/replace"
			}
			t.Run(name, func(t *testing.T) {
				a, user, doc := writingTestApp(t)
				ctx := context.Background()
				id, err := a.loadWechatGeoDocumentID(ctx, user.ID, doc.DocID)
				if err != nil {
					t.Fatal(err)
				}
				var previous *wechatGeoSummaryView
				if existing {
					view, err := a.storeWechatGeoSummary(ctx, user.ID, id, doc.DocID, wechatGeoSummaryFingerprint(doc.Title, doc.Content), generatedWechatGeoSummary{Summary: "用户的原摘要", Topics: []string{"写作"}, Keywords: []string{"标题"}}, agentLLMProvider{Mode: "byok", Model: "test"}, "", 0)
					if err != nil {
						t.Fatal(err)
					}
					flag := false
					view, err = a.updateWechatGeoSummaryText(ctx, user.ID, doc.DocID, nil, &flag)
					if err != nil {
						t.Fatal(err)
					}
					previous = &view
				}
				task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, agentTestSession(t, a, user, mode), doc, "重新生成 GEO 摘要", http.Header{agentGeoHeader: {"1"}}))
				taskCtx := context.WithValue(ctx, writingMCPContext{}, task)
				var calls atomic.Int32
				geoTestProvider(a, &calls, nil)
				in := agentGeoGenerateInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ProviderMode: "builtin", Regenerate: existing}
				in.Proof = geoTestProof(t, a, task, "generate_wechat_geo_summary", in)
				before, _ := a.loadCreditBalance(ctx, user.ID)
				_, out, err := a.agentGenerateGeoSummary(taskCtx, nil, in)
				if err != nil || len(out.Operations) != 1 {
					t.Fatal(out, err)
				}
				if mode != "full" {
					if out.OperationStatus != "pending_approval" {
						t.Fatal("GEO did not await approval", out)
					}
					_, _, current, err := a.loadAgentGeo(ctx, a.db, task, in.Path, false)
					if err != nil || publicationDigest(current) != publicationDigest(previous) {
						t.Fatal("unapproved generation overwrote saved summary", current, err)
					}
					out = geoTestApprove(t, a, user, task, out)
				} else if out.OperationStatus != "applied" {
					t.Fatal("full permission did not apply", out)
				}
				// Undo is a durable host operation; retries must not call the model or refund/charge.
				op, err := scanAgentOperation(a.db.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE id=$1`, out.Operations[0]["id"]))
				if err != nil {
					t.Fatal(err)
				}
				for range 2 {
					w := writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+op.ID+"/undo", map[string]string{"hash": op.Hash})
					if w.Code != 200 {
						t.Fatal("undo failed", w.Code, w.Body.String())
					}
				}
				_, _, current, err := a.loadAgentGeo(ctx, a.db, task, in.Path, false)
				if err != nil || (previous == nil && current != nil) || (previous != nil && (current == nil || current.Text != previous.Text || current.Enabled != previous.Enabled || current.SourceHash != previous.SourceHash)) {
					t.Fatal("undo did not restore original GEO state", previous, current, err)
				}
				after, _ := a.loadCreditBalance(ctx, user.ID)
				if calls.Load() != 1 || before.Balance-after.Balance != creditsForTokens(1200) || before.Reserved != after.Reserved {
					t.Fatal("decision changed generation bill", calls.Load(), before, after)
				}
				op.Status = "undone"
				replay, err := a.agentGeoOperationResult(ctx, task, op)
				if err != nil || replay.OperationStatus != "failed" || replay.Status != "undone" {
					t.Fatal("undone proposal reported applied", replay, err)
				}
				saved, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
				if err != nil || saved.Title != doc.Title || saved.Content != doc.Content || saved.Revision != doc.Revision {
					t.Fatal("GEO changed article", err)
				}
			})
		}
	}
}

func TestAgentGeoApprovalRejectCancelAndConflicts(t *testing.T) {
	for _, decision := range []string{"reject", "cancel", "summary_changed", "article_changed"} {
		t.Run(decision, func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			ctx := context.Background()
			id, err := a.loadWechatGeoDocumentID(ctx, user.ID, doc.DocID)
			if err != nil {
				t.Fatal(err)
			}
			previous, err := a.storeWechatGeoSummary(ctx, user.ID, id, doc.DocID, wechatGeoSummaryFingerprint(doc.Title, doc.Content), generatedWechatGeoSummary{Summary: "原摘要", Topics: []string{"写作"}, Keywords: []string{"标题"}}, agentLLMProvider{Mode: "byok", Model: "test"}, "", 0)
			if err != nil {
				t.Fatal(err)
			}
			task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "修改 GEO 摘要", http.Header{agentGeoHeader: {"1"}}))
			taskCtx := context.WithValue(ctx, writingMCPContext{}, task)
			replacement := "<span hidden>需要审阅的摘要</span>"
			input := agentGeoUpdateInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ExpectedUpdatedAt: previous.UpdatedAt.Format(time.RFC3339Nano), Text: &replacement}
			input.Proof = geoTestProof(t, a, task, "update_wechat_geo_summary", input)
			_, out, err := a.agentUpdateGeoSummary(taskCtx, nil, input)
			if err != nil || out.OperationStatus != "pending_approval" {
				t.Fatal(out, err)
			}
			op, err := scanAgentOperation(a.db.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE id=$1`, out.Operations[0]["id"]))
			if err != nil {
				t.Fatal(err)
			}
			action := "approve"
			expected := 409
			text := previous.Text
			switch decision {
			case "reject":
				action = "reject"
				expected = 200
			case "cancel":
				if err = a.cancelAgentTask(ctx, user.ID, task.ID); err != nil {
					t.Fatal(err)
				}
			case "summary_changed":
				text = "后续手动修改"
				_, err = a.updateWechatGeoSummaryText(ctx, user.ID, doc.DocID, &text, nil)
			case "article_changed":
				_, err = a.db.Exec(ctx, `UPDATE documents SET revision=revision+1 WHERE doc_id=$1`, doc.DocID)
			}
			if err != nil {
				t.Fatal(err)
			}
			w := writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+op.ID+"/"+action, map[string]string{"hash": op.Hash})
			if w.Code != expected {
				t.Fatal("GEO decision", w.Code, w.Body.String())
			}
			current, err := a.loadWechatGeoSummary(ctx, id)
			if err != nil || current.Text != text {
				t.Fatal("GEO overwritten", current, err)
			}
			_, resolved, err := a.agentOperationResults(taskCtx, nil, agentApprovalInput{OperationIDs: []string{op.ID}})
			if decision != "cancel" && (err != nil || len(resolved["operationResults"].([]map[string]string)) != 1) {
				t.Fatal("missing approval resolver receipt", resolved, err)
			}
		})
	}
}

func TestAgentGeoOldClientAndEmptyReceiptContract(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, agentTestSession(t, a, user, "full"), doc, "生成 GEO 摘要"))
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	var calls atomic.Int32
	geoTestProvider(a, &calls, nil)
	before, _ := a.loadCreditBalance(ctx, user.ID)
	if _, _, err := a.agentGenerateGeoSummary(ctx, nil, agentGeoGenerateInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ProviderMode: "builtin"}); err == nil || !strings.Contains(err.Error(), "更新客户端") {
		t.Fatal("unsupported client write accepted", err)
	}
	server := httptest.NewServer(a.Routes())
	defer server.Close()
	client, err := connectMCPClient(ctx, server.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	tools, err := client.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if tool.Name == "generate_wechat_geo_summary" || tool.Name == "update_wechat_geo_summary" {
			t.Fatal("unsupported client exposed GEO writes")
		}
	}
	after, _ := a.loadCreditBalance(ctx, user.ID)
	if calls.Load() != 0 || before.Balance != after.Balance || before.Reserved != after.Reserved {
		t.Fatal("unsupported client caused generation or charge")
	}
	// Agent runtime uses operationStatus only when operationResults is absent;
	// an empty array would turn generating/reused into an unknown write outcome.
	for _, status := range []string{"generating", "reused"} {
		out := agentGeoResult(doc, nil, status)
		out.OperationStatus = "proposed"
		raw, _ := json.Marshal(out)
		var data map[string]json.RawMessage
		_ = json.Unmarshal(raw, &data)
		if string(data["operations"]) != "[]" || data["operationResults"] != nil {
			t.Fatal("invalid runtime receipt contract", string(raw))
		}
	}
}

// A paid draft is retained when rejected; the existing host checkpoint resumes
// with a failed write receipt instead of silently re-generating or applying it.
func TestAgentGeoRejectedDraftBillingAndApprovalResume(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "生成 GEO 摘要", http.Header{agentGeoHeader: {"1"}}))
	taskCtx := context.WithValue(ctx, writingMCPContext{}, task)
	var calls, wakes atomic.Int32
	geoTestProvider(a, &calls, nil)
	input := agentGeoGenerateInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ProviderMode: "builtin"}
	input.Proof = geoTestProof(t, a, task, "generate_wechat_geo_summary", input)
	before, _ := a.loadCreditBalance(ctx, user.ID)
	_, out, err := a.agentGenerateGeoSummary(taskCtx, nil, input)
	if err != nil {
		t.Fatal(err)
	}
	op, err := scanAgentOperation(a.db.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE id=$1`, out.Operations[0]["id"]))
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{op.ID}
	raw, _ := json.Marshal(map[string]any{"version": 1, "operationIds": ids})
	job := writingRemoteJob{ID: task.JobID, Status: "awaiting_approval", Approval: &agentRemoteApproval{ToolName: "host_operations", CheckpointID: "geo-checkpoint", ToolCallID: "geo-call", Input: raw, ExpiresAt: time.Now().Add(time.Hour)}}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/approve-checkpoint") {
			t.Error("unexpected approval request", r.Method, r.URL.Path)
		}
		var in struct {
			OperationIDs []string `json:"operationIds"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil || len(in.OperationIDs) != 1 || in.OperationIDs[0] != op.ID {
			t.Error("unbound GEO approval wake")
		}
		wakes.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"approved":true}`)
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	path := "/api/agent/workspace/jobs/" + task.JobID
	if err = a.advanceAgentApproval(ctx, &task, job, path); err != nil {
		t.Fatal(err)
	}
	paused, err := a.loadWritingTask(ctx, task.ID, user.ID)
	if err != nil || paused.Status != "awaiting_approval" || wakes.Load() != 0 {
		t.Fatal("GEO did not pause for approval", paused.Status, err)
	}
	for range 2 {
		w := writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+op.ID+"/reject", map[string]string{"hash": op.Hash})
		if w.Code != 200 {
			t.Fatal("reject GEO", w.Code, w.Body.String())
		}
	}
	if err = a.advanceAgentApproval(ctx, &paused, job, path); err != nil || wakes.Load() != 1 {
		t.Fatal("GEO checkpoint did not resume", err, wakes.Load())
	}
	_, resolved, err := a.agentOperationResults(taskCtx, nil, agentApprovalInput{OperationIDs: ids})
	if err != nil || resolved["operationResults"].([]map[string]string)[0]["status"] != "failed" {
		t.Fatal("rejection lacks authoritative receipt", resolved, err)
	}
	_, replayed, err := a.agentGenerateGeoSummary(taskCtx, nil, input)
	if err != nil || replayed.Status != "rejected" || replayed.OperationStatus != "failed" {
		t.Fatal("rejection replay was applied", replayed, err)
	}
	_, _, view, err := a.loadAgentGeo(ctx, a.db, task, input.Path, false)
	if err != nil || view != nil {
		t.Fatal("rejected generation wrote summary", view, err)
	}
	after, _ := a.loadCreditBalance(ctx, user.ID)
	if calls.Load() != 1 || before.Balance-after.Balance != creditsForTokens(1200) || before.Reserved != after.Reserved {
		t.Fatal("rejection replay changed paid draft bill", calls.Load(), before, after)
	}
}
