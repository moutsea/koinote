package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

func coverTestTask(t *testing.T, article bool) (*App, model.User, model.Document, writingTask, agentCoverInput) {
	t.Helper()
	a, user, doc := writingTestApp(t)
	a.cfg.WechatCoverImageBaseURL, a.cfg.WechatCoverImageAPIKey, a.cfg.WechatCoverImageModel = "https://cover.example/v1", "cover-key", "image-model"
	var s agentSession
	if article {
		w := writingTestRequest(t, a, user, "POST", "/api/documents/"+doc.DocID+"/koi-session", nil)
		var page struct{ Session agentSession }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		s = page.Session
	} else {
		s = agentTestSession(t, a, user, "review")
	}
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, s, doc, "读这篇文章，帮我生成封面图", http.Header{agentCoversHeader: {"1"}}))
	in := agentCoverInput{Prompt: "A quiet writing desk, warm light", Ratio: "16:9"}
	in.Proof = coverTestProof(t, a, task, in)
	return a, user, doc, task, in
}

func coverTestProof(t *testing.T, a *App, task writingTask, in agentCoverInput) *agentIntentProof {
	t.Helper()
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	_, proof, err := a.agentValidateOperation(ctx, nil, agentIntentValidateInput{ToolName: "generate_cover", Task: intentBindingForTest(task), Arguments: map[string]any{"prompt": in.Prompt, "ratio": in.Ratio}})
	if err != nil {
		t.Fatal(err)
	}
	return proof
}

func coverProviderResponse(data []byte) *http.Response {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(data) + `"}]}`))}
}

func TestAgentCoverArticleMCPAndBilling(t *testing.T) {
	a, user, doc, task, in := coverTestTask(t, true)
	ctx := context.Background()
	poolConfig := a.db.Config()
	poolConfig.MaxConns, poolConfig.MinConns = 1, 0
	limited, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(limited.Close)
	a.db = limited
	before, _ := a.loadCreditBalance(ctx, user.ID)
	raw := testWechatCoverJPEG(t)
	var calls atomic.Int32
	a.wechatCoverHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		// Image I/O must leave the pool available to ordinary API requests.
		probe, stop := context.WithTimeout(ctx, 2*time.Second)
		defer stop()
		if _, err := a.db.Exec(probe, `SELECT 1`); err != nil {
			t.Error("image generation pinned a database connection", err)
		}
		var payload struct {
			Model, Prompt string
			N             int
		}
		if json.NewDecoder(r.Body).Decode(&payload) != nil || payload.Model != "image-model" || payload.N != 1 || !strings.Contains(payload.Prompt, in.Prompt) || r.URL.Path != "/v1/images/generations" || r.Header.Get("Authorization") != "Bearer cover-key" {
			t.Error("image provider contract mismatch")
		}
		return coverProviderResponse(raw), nil
	})}
	wire := map[string]any{"policy": map[string]any{}}
	if err := a.prepareAgentConversationInput(ctx, &task, wire, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(wire["policy"].(map[string]any)["allowTools"].([]string), ","), "koinote.generate_cover") || !strings.Contains(wire["systemPrompt"].(string), agentCoverInstructions) {
		t.Fatal("cover tool missing from article input")
	}
	srv := httptest.NewServer(a.Routes())
	defer srv.Close()
	client, err := connectMCPClient(ctx, srv.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	listed, err := client.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatal(err)
	}
	guarded := false
	for _, tool := range listed.Tools {
		if tool.Name == "generate_cover" {
			data, _ := json.Marshal(tool.Meta)
			guarded = strings.Contains(string(data), "guarded")
		}
	}
	if !guarded {
		t.Fatal("runtime would block unclassified image tool")
	}
	var result agentCoverOutput
	for range 2 {
		out, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "generate_cover", Arguments: in})
		if err != nil || out.IsError {
			t.Fatal(out, err)
		}
		data, _ := json.Marshal(out.StructuredContent)
		if err = json.Unmarshal(data, &result); err != nil || result.Artifact.ID == "" || result.OperationStatus != "applied" {
			t.Fatal("invalid image receipt", string(data), err)
		}
	}
	after, _ := a.loadCreditBalance(ctx, user.ID)
	if calls.Load() != 1 || after.Balance != before.Balance-20 || after.Reserved != before.Reserved {
		t.Fatal("replayed cover double-charged", calls.Load(), before, after)
	}
	path := "/api/agent/artifacts/" + result.Artifact.ID
	preview := writingTestRequest(t, a, user, "GET", path+"?preview=1", nil)
	if preview.Code != 200 || preview.Header().Get("Content-Type") != "image/jpeg" || preview.Header().Get("Content-Disposition") != "inline" || http.DetectContentType(preview.Body.Bytes()) != "image/jpeg" {
		t.Fatal("invalid private preview", preview.Code)
	}
	download := writingTestRequest(t, a, user, "GET", path, nil)
	if download.Code != 200 || !strings.HasPrefix(download.Header().Get("Content-Disposition"), "attachment") || !bytes.Equal(download.Body.Bytes(), preview.Body.Bytes()) {
		t.Fatal("download changed")
	}
	other := insertAgentReviewTestUser(t, a.db)
	if w := writingTestRequest(t, a, other, "GET", path+"?preview=1", nil); w.Code == 200 {
		t.Fatal("cross-account preview")
	}
	page := writingTestRequest(t, a, user, "GET", "/api/agent/sessions/"+task.SessionID, nil)
	if page.Code != 200 || !strings.Contains(page.Body.String(), result.Artifact.ID) {
		t.Fatal("image absent from conversation", page.Code)
	}
	changed := in
	changed.Prompt += " in blue"
	changed.Proof = coverTestProof(t, a, task, changed)
	toolCtx := context.WithValue(ctx, writingMCPContext{}, task)
	if _, _, err = a.agentGenerateCover(toolCtx, nil, changed); err == nil || calls.Load() != 1 {
		t.Fatal("second variant started in same task")
	}
	var content string
	var revision int64
	if err = a.db.QueryRow(ctx, `SELECT content,revision FROM documents WHERE doc_id=$1`, doc.DocID).Scan(&content, &revision); err != nil || content != doc.Content || revision != doc.Revision {
		t.Fatal("image generation edited article", err)
	}
	reply := "三个标题建议：\n1. 山间来信\n2. 云南慢行\n3. 把日子写成诗"
	state := map[string]any{"goal": map[string]any{"text": task.Message, "sources": []any{map[string]string{"messageId": agentUserMessageID(task.ID), "quote": task.Message}}}, "targets": []any{}, "constraints": []any{}, "questions": []any{}, "suggestions": []any{}}
	task.IntentResult, _ = json.Marshal(map[string]any{"taskId": task.SessionID, "sessionId": task.SessionID, "inputVersion": task.IntentVersion, "currentMessageId": agentUserMessageID(task.ID), "jobId": task.JobID, "state": state, "stateOrigin": "model_inference", "outcome": "operations_reported", "modelOutput": reply})
	if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":2001}`), "封面已生成"); err != nil {
		t.Fatal(err)
	}
	if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":2001}`), "封面已生成"); err != nil {
		t.Fatal(err)
	}
	fresh, _ := a.loadWritingTask(ctx, task.ID, user.ID)
	after, _ = a.loadCreditBalance(ctx, user.ID)
	want := int64(20) + creditsForTokens(2001)
	if fresh.ChargedCredits != want || after.Balance != before.Balance-want || after.Reserved != 0 {
		t.Fatal("text settlement lost/doubled image fee", fresh.ChargedCredits, after)
	}
	if fresh.TaskIntent == nil || fresh.TaskIntent.Reply != reply || fresh.CoverGeneration == nil || fresh.CoverGeneration.Status != "completed" {
		t.Fatal("image settlement lost the final text reply")
	}
	for _, endpoint := range []string{"/api/agent/sessions/" + task.SessionID, "/api/writing-agent/tasks/" + task.ID} {
		w := writingTestRequest(t, a, user, "GET", endpoint, nil)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "山间来信") || strings.Contains(w.Body.String(), "modelOutput") || strings.Contains(w.Body.String(), "stateOrigin") {
			t.Fatal("text missing from restored task/session or private state leaked", w.Code)
		}
	}
	if w := writingTestRequest(t, a, user, "DELETE", "/api/agent/sessions/"+task.SessionID, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := writingTestRequest(t, a, user, "GET", path, nil); w.Code == 200 {
		t.Fatal("deleted session image still accessible")
	}
}

func TestAgentCoverFailureAndAuthorization(t *testing.T) {
	for _, scenario := range []string{"provider_failure", "no_model", "rate_limited", "insufficient_credits", "invalid_proof", "cancel_during_generation", "new_intent_during_generation", "invalid_input"} {
		t.Run(scenario, func(t *testing.T) {
			a, user, _, task, in := coverTestTask(t, false)
			ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
			before, _ := a.loadCreditBalance(ctx, user.ID)
			calls := 0
			raw := testWechatCoverJPEG(t)
			a.wechatCoverHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				switch scenario {
				case "provider_failure":
					return nil, errors.New("provider unavailable")
				case "cancel_during_generation":
					if err := a.cancelAgentTask(ctx, user.ID, task.ID); err != nil {
						t.Error(err)
					}
				case "new_intent_during_generation":
					if _, err := a.db.Exec(ctx, `UPDATE agent_sessions SET intent_version=intent_version+1 WHERE id=$1`, task.SessionID); err != nil {
						t.Error(err)
					}
				}
				return coverProviderResponse(raw), nil
			})}
			switch scenario {
			case "no_model":
				a.cfg.WechatCoverImageAPIKey = ""
			case "rate_limited":
				for range wechatCoverGenerateLimit {
					a.rateLimit().allow("wechat-cover:"+strconv.Itoa(user.ID), wechatCoverGenerateLimit, wechatCoverGenerateWindow)
				}
			case "insufficient_credits":
				if _, err := a.db.Exec(ctx, `UPDATE credit_accounts SET balance=reserved WHERE user_id=$1`, user.ID); err != nil {
					t.Fatal(err)
				}
				before, _ = a.loadCreditBalance(ctx, user.ID)
			case "invalid_proof":
				in.Prompt += " tampered"
			case "invalid_input":
				in.Ratio = "bad"
			}
			if _, _, err := a.agentGenerateCover(ctx, nil, in); err == nil {
				t.Fatal("failed generation accepted")
			}
			var artifacts int
			if err := a.db.QueryRow(ctx, `SELECT count(*) FROM agent_artifacts WHERE task_id=$1`, task.ID).Scan(&artifacts); err != nil {
				t.Fatal(err)
			}
			after, _ := a.loadCreditBalance(ctx, user.ID)
			if artifacts != 0 || after != before {
				t.Fatal("failed/cancelled generation retained image or charged", before, after)
			}
			if code := map[string]string{"provider_failure": "generation_failed", "no_model": "service_unavailable", "rate_limited": "rate_limited", "insufficient_credits": "insufficient_credits"}[scenario]; code != "" {
				fresh, err := a.loadWritingTask(ctx, task.ID, user.ID)
				if err != nil || fresh.CoverGeneration == nil || fresh.CoverGeneration.Status != "failed" || fresh.CoverGeneration.ErrorCode != code || fresh.CoverGeneration.ChargedCredits != 0 {
					t.Fatalf("failure receipt not persisted: %+v %v", fresh.CoverGeneration, err)
				}
				// Delivery survives refresh/settlement even when the native result
				// contains only an unknown operation receipt instead of model prose.
				page := writingTestRequest(t, a, user, "GET", "/api/agent/sessions/"+task.SessionID, nil)
				if page.Code != 200 || !strings.Contains(page.Body.String(), `"errorCode":"`+code+`"`) {
					t.Fatal("failure missing from session API", page.Code, page.Body.String())
				}
				if _, _, err = a.agentGenerateCover(ctx, nil, in); err == nil || err.Error() != agentCoverError(code).Error() {
					t.Fatal("retry lost original failure", err)
				}
			}
			if scenario == "provider_failure" {
				if _, _, err := a.agentGenerateCover(ctx, nil, in); err == nil || calls != 1 {
					t.Fatal("retry restarted failed provider")
				}
			} else if scenario != "cancel_during_generation" && scenario != "new_intent_during_generation" && calls != 0 {
				t.Fatal("preflight failure contacted provider")
			}
			if _, _, err := a.agentSaveArtifact(ctx, nil, agentArtifactInput{Name: "koi-cover-spoof.jpg", Content: "fake"}); err == nil {
				t.Fatal("spoofed generation receipt")
			}
		})
	}
}

func TestAgentCoverSlowGenerationPolling(t *testing.T) {
	a, user, _, task, in := coverTestTask(t, true)
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	raw := testWechatCoverJPEG(t)
	var calls atomic.Int32
	finish := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(finish) }) }
	defer release()
	a.wechatCoverHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		select {
		case <-finish:
			return coverProviderResponse(raw), nil
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
	})}
	request, cancelRequest := context.WithCancel(ctx)
	defer cancelRequest()
	_, pending, err := a.agentGenerateCover(request, nil, in)
	if err != nil || pending.Status != "generating" || calls.Load() != 1 {
		t.Fatal("slow generation did not return polling receipt", pending, err)
	}
	cancelRequest()
	if _, _, err = a.generateAgentCover(ctx, in); !errors.Is(err, errAgentCoverGenerating) || calls.Load() != 1 {
		t.Fatal("concurrent polling restarted provider", err)
	}
	// A disconnected request must not abandon the paid provider call. A second
	// backend instance shares the DB receipt/lock and returns the existing image.
	second := New(a.cfg, a.db)
	before, _ := a.loadCreditBalance(ctx, user.ID)
	release()
	_, result, err := second.agentGenerateCover(ctx, nil, in)
	if err != nil || result.Artifact.ID == "" || result.Status != "generated_not_applied" || calls.Load() != 1 {
		t.Fatal("polling did not reuse generation", result, err)
	}
	after, _ := a.loadCreditBalance(ctx, user.ID)
	if after.Balance != before.Balance-20 || after.Reserved != before.Reserved-20 {
		t.Fatal("polling settlement incorrect", before, after)
	}
}

func TestAgentCoverClientCapability(t *testing.T) {
	for _, article := range []bool{false, true} {
		for _, capable := range []bool{false, true} {
			t.Run(fmt.Sprintf("article=%t/capable=%t", article, capable), func(t *testing.T) {
				a, user, doc := writingTestApp(t)
				s := agentTestSession(t, a, user, "review")
				if article {
					w := writingTestRequest(t, a, user, "POST", "/api/documents/"+doc.DocID+"/koi-session", nil)
					var page struct{ Session agentSession }
					if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil {
						t.Fatal(w.Code, w.Body.String())
					}
					s = page.Session
				}
				value := ""
				if capable {
					value = "1"
				}
				requestID := mustAgentUUID(t)
				payload := map[string]any{"requestId": requestID, "message": "生成封面", "context": map[string]string{"path": agentDocumentPath(doc.DocID)}}
				path := "/api/agent/sessions/" + s.ID + "/tasks"
				w := writingTestRequest(t, a, user, "POST", path, payload, http.Header{agentCoversHeader: {value}})
				var response struct{ Task writingTask }
				if w.Code != 202 || json.Unmarshal(w.Body.Bytes(), &response) != nil {
					t.Fatal(w.Code, w.Body.String())
				}
				task, err := a.loadWritingTask(context.Background(), response.Task.ID, user.ID)
				if err != nil || task.CoverEnabled != capable {
					t.Fatal("capability not frozen", err)
				}
				// A retry from a different client must not change accepted capabilities.
				w = writingTestRequest(t, a, user, "POST", path, payload, http.Header{agentCoversHeader: {map[bool]string{true: "", false: "1"}[capable]}})
				if w.Code != 200 {
					t.Fatal("cross-version retry rejected", w.Code, w.Body.String())
				}
				task, err = a.loadWritingTask(context.Background(), task.ID, user.ID)
				if err != nil || task.CoverEnabled != capable {
					t.Fatal("retry changed capability", err)
				}
				task = bindIntentTaskForTest(t, a, task)
				wire := map[string]any{"policy": map[string]any{}}
				if err = a.prepareAgentConversationInput(context.Background(), &task, wire, ""); err != nil {
					t.Fatal(err)
				}
				if strings.Contains(strings.Join(wire["policy"].(map[string]any)["allowTools"].([]string), ","), "koinote.generate_cover") != capable {
					t.Fatal("policy disagrees with client")
				}
				if strings.Contains(wire["systemPrompt"].(string), agentCoverInstructions) != capable {
					t.Fatal("prompt disagrees with client")
				}
				legacy := map[string]any{"policy": map[string]any{}}
				if err = a.prepareAgentLegacyConversationInput(context.Background(), &task, legacy, ""); err != nil {
					t.Fatal(err)
				}
				if strings.Contains(strings.Join(legacy["policy"].(map[string]any)["allowTools"].([]string), ","), "koinote.generate_cover") != capable {
					t.Fatal("legacy policy disagrees with client")
				}
				srv := httptest.NewServer(a.Routes())
				defer srv.Close()
				client, err := connectMCPClient(context.Background(), srv.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
				if err != nil {
					t.Fatal(err)
				}
				defer client.Close()
				list, err := client.ListTools(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, tool := range list.Tools {
					found = found || tool.Name == "generate_cover"
				}
				if found != capable {
					t.Fatal("MCP catalog disagrees with client")
				}
				if !capable {
					ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
					before, _ := a.loadCreditBalance(ctx, user.ID)
					if _, _, err = a.agentGenerateCover(ctx, nil, agentCoverInput{Prompt: "A desk"}); !errors.Is(err, errAgentCoverClient) {
						t.Fatal("direct execution bypassed capability", err)
					}
					if _, _, err = a.agentValidateOperation(ctx, nil, agentIntentValidateInput{ToolName: "generate_cover", Task: intentBindingForTest(task)}); !errors.Is(err, errAgentCoverClient) {
						t.Fatal("proof bypassed capability", err)
					}
					after, _ := a.loadCreditBalance(ctx, user.ID)
					if after != before {
						t.Fatal("old client charged for undeliverable image")
					}
				}
			})
		}
	}
}

func TestAgentCoverIncompleteUsageBilling(t *testing.T) {
	a, user, _, task, in := coverTestTask(t, false)
	ctx := context.Background()
	before, _ := a.loadCreditBalance(ctx, user.ID)
	raw := testWechatCoverJPEG(t)
	a.wechatCoverHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(r *http.Request) (*http.Response, error) { return coverProviderResponse(raw), nil })}
	if _, _, err := a.agentGenerateCover(context.WithValue(ctx, writingMCPContext{}, task), nil, in); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := a.finishWritingTask(ctx, task, "completed", "", nil, "封面已生成"); err != nil {
			t.Fatal(err)
		}
	}
	fresh, err := a.loadWritingTask(ctx, task.ID, user.ID)
	after, _ := a.loadCreditBalance(ctx, user.ID)
	if err != nil || fresh.BillingStatus != "needs_review" || fresh.ChargedCredits != 20 || fresh.CoverGeneration == nil || fresh.CoverGeneration.ChargedCredits != 20 || after.Balance != before.Balance-20 || after.Reserved != 0 {
		t.Fatalf("incorrect split billing: %+v %+v %v", fresh, after, err)
	}
}

func TestAgentCoverInterruptedReceipt(t *testing.T) {
	a, user, _, task, in := coverTestTask(t, false)
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	if _, err := a.db.Exec(ctx, `INSERT INTO agent_cover_generations(task_id,created_at) VALUES($1,now()-interval '6 minutes')`, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.agentGenerateCover(ctx, nil, in); err == nil || err.Error() != agentCoverFailed {
		t.Fatal("interrupted run was restarted", err)
	}
	fresh, err := a.loadWritingTask(ctx, task.ID, user.ID)
	if err != nil || fresh.CoverGeneration == nil || fresh.CoverGeneration.Status != "failed" || fresh.CoverGeneration.ChargedCredits != 0 {
		t.Fatal("interrupted generation lacks visible failure", fresh.CoverGeneration, err)
	}
}
