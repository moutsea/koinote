package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

func geoTestProvider(a *App, calls *atomic.Int32, before func()) {
	a.cfg.AgentLLMProtocol, a.cfg.AgentLLMBaseURL, a.cfg.AgentLLMAPIKey, a.cfg.AgentLLMModel = "openai", "https://geo.example/v1", "test-geo-key", "test-geo-model"
	a.agentLLMHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if before != nil {
			before()
		}
		return jsonResponse(`{"choices":[{"message":{"content":"{\"summary\":\"我按主题整理资料，并记录来源，方便后续查找。\",\"topics\":[\"知识管理\"],\"keywords\":[\"资料归档\"]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":200,"total_tokens":1200}}`), nil
	})}
}

func geoTestProof(t *testing.T, a *App, task writingTask, tool string, args any) *agentIntentProof {
	t.Helper()
	raw, _ := json.Marshal(args)
	var arguments map[string]any
	_ = json.Unmarshal(raw, &arguments)
	_, proof, err := a.agentValidateOperation(context.WithValue(context.Background(), writingMCPContext{}, task), nil, agentIntentValidateInput{ToolName: tool, Task: intentBindingForTest(task), Arguments: arguments})
	if err != nil {
		t.Fatal(err)
	}
	return proof
}

func TestAgentGeoMCPBothEntriesBillingReplayAndEditing(t *testing.T) {
	for _, article := range []bool{true, false} {
		t.Run(map[bool]string{true: "article", false: "chat"}[article], func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			var calls atomic.Int32
			geoTestProvider(a, &calls, nil)
			session := agentTestSession(t, a, user, "review")
			if article {
				session = koiArticleSession(t, a, user, doc)
			}
			task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, session, doc, "生成 GEO 隐藏摘要", http.Header{agentGeoHeader: {"1"}}))
			ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
			wire := map[string]any{"policy": map[string]any{}}
			if err := a.prepareAgentConversationInput(ctx, &task, wire, ""); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(wire["systemPrompt"].(string), agentGeoInstructions) || !strings.Contains(strings.Join(wire["policy"].(map[string]any)["allowTools"].([]string), ","), "koinote.generate_wechat_geo_summary") {
				t.Fatal("missing Agent GEO policy")
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
			guarded := 0
			for _, tool := range tools.Tools {
				if tool.Name == "generate_wechat_geo_summary" || tool.Name == "update_wechat_geo_summary" {
					raw, _ := json.Marshal(tool.Meta)
					if strings.Contains(string(raw), "guarded") && strings.Contains(string(raw), "get_operation_results") {
						guarded++
					}
				}
			}
			if guarded != 2 {
				t.Fatal("GEO write tools lack intent guards")
			}
			read, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "get_wechat_geo_summary", Arguments: map[string]any{}})
			if err != nil || read.IsError {
				t.Fatal(read, err)
			}
			var initial agentGeoOutput
			raw, _ := json.Marshal(read.StructuredContent)
			_ = json.Unmarshal(raw, &initial)
			if initial.Path != agentDocumentPath(doc.DocID) || initial.Revision != doc.Revision || initial.Geo != nil {
				t.Fatal("invalid GEO read", string(raw))
			}
			in := agentGeoGenerateInput{Path: initial.Path, ExpectedRevision: initial.Revision, ProviderMode: "builtin"}
			if _, _, err = a.agentGenerateGeoSummary(ctx, nil, in); err == nil {
				t.Fatal("missing proof accepted")
			}
			in.Proof = geoTestProof(t, a, task, "generate_wechat_geo_summary", in)
			before, _ := a.loadCreditBalance(ctx, user.ID)
			var result agentGeoOutput
			for range 2 {
				out, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "generate_wechat_geo_summary", Arguments: in})
				if err != nil || out.IsError {
					t.Fatal(out, err)
				}
				raw, _ := json.Marshal(out.StructuredContent)
				_ = json.Unmarshal(raw, &result)
				if result.Status != "pending" || result.OperationStatus != "pending_approval" || result.Geo == nil || !result.Geo.Enabled || result.Stale {
					t.Fatal("invalid saved summary", string(raw))
				}
			}
			after, _ := a.loadCreditBalance(ctx, user.ID)
			if calls.Load() != 1 || before.Balance-after.Balance != creditsForTokens(1200) || after.Reserved != before.Reserved || result.Credits != creditsForTokens(1200) {
				t.Fatal("wrong GEO billing or replay", calls.Load(), before, after, result.Credits)
			}
			// Review mode keeps the summary untouched until the exact proposal is approved.
			if _, _, view, err := a.loadAgentGeo(ctx, a.db, task, in.Path, false); err != nil || view != nil {
				t.Fatal("review wrote before approval", view, err)
			}
			result = geoTestApprove(t, a, user, task, result)
			// The ordinary editor API sees the approved summary.
			w := requestWechatGeoSummaryGet(t, a, user.AuthUserID, user.SessionVersion, doc.DocID)
			if w.Code != 200 || !strings.Contains(w.Body.String(), result.Geo.Text[:12]) {
				t.Fatal("editor cannot read Agent summary", w.Code, w.Body.String())
			}
			text := "我把资料按主题归档，保留来源以便复查。"
			enabled := false
			update := agentGeoUpdateInput{Path: in.Path, ExpectedRevision: doc.Revision, ExpectedUpdatedAt: result.Geo.UpdatedAt.Format(time.RFC3339Nano), Text: &text, Enabled: &enabled}
			update.Proof = geoTestProof(t, a, task, "update_wechat_geo_summary", update)
			for range 2 {
				_, out, err := a.agentUpdateGeoSummary(ctx, nil, update)
				if err != nil || out.Status != "pending" || out.Geo == nil || out.Geo.Text != text || out.Geo.Enabled || out.Stale {
					t.Fatal("GEO edit/replay", out, err)
				}
			}
			_, updateOut, err := a.agentUpdateGeoSummary(ctx, nil, update)
			if err != nil {
				t.Fatal(err)
			}
			_ = geoTestApprove(t, a, user, task, updateOut)
			changed := "不应覆盖新版本"
			update.Text = &changed
			update.Proof = geoTestProof(t, a, task, "update_wechat_geo_summary", update)
			if _, _, err := a.agentUpdateGeoSummary(ctx, nil, update); err == nil {
				t.Fatal("stale summary edit accepted")
			}
			current, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
			if err != nil || current.Content != doc.Content || current.Title != doc.Title || current.Revision != doc.Revision {
				t.Fatal("GEO modified article")
			}
			if balance, _ := a.loadCreditBalance(ctx, user.ID); balance.Balance != after.Balance || calls.Load() != 1 {
				t.Fatal("GEO editing charged")
			}
		})
	}
}

func TestAgentGeoConcurrentWaitSourceChangesAndFailures(t *testing.T) {
	for _, change := range []string{"none", "article", "summary", "cancel", "provider"} {
		t.Run(change, func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "生成 GEO 隐藏摘要", http.Header{agentGeoHeader: {"1"}}))
			ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
			in := agentGeoGenerateInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ProviderMode: "builtin"}
			in.Proof = geoTestProof(t, a, task, "generate_wechat_geo_summary", in)
			started, release := make(chan struct{}), make(chan struct{})
			var calls atomic.Int32
			geoTestProvider(a, &calls, func() { close(started); <-release })
			if change == "provider" {
				a.agentLLMHTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
					calls.Add(1)
					close(started)
					<-release
					return jsonResponse(`{"choices":[{"message":{"content":"invalid json"},"finish_reason":"stop"}],"usage":{"total_tokens":20}}`), nil
				})}
			}
			before, _ := a.loadCreditBalance(ctx, user.ID)
			// A lost MCP response must leave one bounded attempt, not another bill.
			short, stop := context.WithCancel(ctx)
			done := make(chan error, 1)
			go func() { _, _, err := a.agentGenerateGeoSummary(short, nil, in); done <- err }()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("provider not reached")
			}
			stop()
			if err := <-done; !errors.Is(err, context.Canceled) {
				t.Fatal("MCP wait did not cancel", err)
			}
			switch change {
			case "article":
				_, err := a.db.Exec(ctx, `UPDATE documents SET content='new content',revision=revision+1 WHERE doc_id=$1`, doc.DocID)
				if err != nil {
					t.Fatal(err)
				}
			case "summary":
				id, _ := a.loadWechatGeoDocumentID(ctx, user.ID, doc.DocID)
				_, err := a.storeWechatGeoSummary(ctx, user.ID, id, doc.DocID, wechatGeoSummaryFingerprint(doc.Title, doc.Content), generatedWechatGeoSummary{Summary: "手动保存的新摘要", Topics: []string{"主题"}, Keywords: []string{"检索词"}}, agentLLMProvider{Mode: "byok", Model: "test"}, "", 0)
				if err != nil {
					t.Fatal(err)
				}
			case "cancel":
				if err := a.cancelAgentTask(ctx, user.ID, task.ID); err != nil {
					t.Fatal(err)
				}
			}
			close(release)
			var out agentGeoOutput
			var resultErr error
			until := time.Now().Add(5 * time.Second)
			for {
				out, resultErr = a.agentGeoGenerationResult(ctx, task, doc)
				if resultErr != nil || out.Status != "generating" {
					break
				}
				if time.Now().After(until) {
					t.Fatal("generation did not settle")
				}
				time.Sleep(20 * time.Millisecond)
			}
			after, _ := a.loadCreditBalance(ctx, user.ID)
			if calls.Load() != 1 {
				t.Fatal("duplicate model call")
			}
			if change == "none" {
				if resultErr != nil || before.Balance-after.Balance != creditsForTokens(1200) {
					t.Fatal("lost response lost save", resultErr, before, after)
				}
				if _, _, err := a.agentGenerateGeoSummary(ctx, nil, in); err != nil || calls.Load() != 1 {
					t.Fatal("retry duplicated generation", err)
				}
			} else if resultErr == nil || before.Balance != after.Balance || before.Reserved != after.Reserved {
				t.Fatal("failed/conflicted generation charged", change, resultErr, before, after)
			}
			if change == "summary" {
				_, _, view, err := a.loadAgentGeo(ctx, a.db, task, in.Path, false)
				if err != nil || view.Text != "手动保存的新摘要\n主题\n检索词" {
					t.Fatal("overwrote user summary", view, err)
				}
			}
		})
	}
}

func TestAgentGeoScopeReuseAndPublicationSnapshot(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	var calls atomic.Int32
	geoTestProvider(a, &calls, nil)
	session := koiArticleSession(t, a, user, doc)
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, session, doc, "生成 GEO 隐藏摘要并准备公众号草稿", http.Header{agentPublishingHeader: {"1"}, agentGeoHeader: {"1"}}))
	taskCtx := context.WithValue(ctx, writingMCPContext{}, task)
	in := agentGeoGenerateInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ProviderMode: "builtin"}
	in.Proof = geoTestProof(t, a, task, "generate_wechat_geo_summary", in)
	_, out, err := a.agentGenerateGeoSummary(taskCtx, nil, in)
	if err != nil {
		t.Fatal(err)
	}
	out = geoTestApprove(t, a, user, task, out)
	other, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Other", Content: "Read only reference"})
	if err != nil {
		t.Fatal(err)
	}
	outside := in
	outside.Path = agentDocumentPath(other.DocID)
	outside.ExpectedRevision = other.Revision
	outside.Proof = nil
	_, _, err = a.agentValidateOperation(taskCtx, nil, agentIntentValidateInput{ToolName: "generate_wechat_geo_summary", Task: intentBindingForTest(task), Arguments: map[string]any{"path": outside.Path, "expectedRevision": outside.ExpectedRevision, "providerMode": "builtin"}})
	if !errors.Is(err, errArticleWriteScope) {
		t.Fatal("outside write scope accepted")
	}
	_, stranger, foreign := writingTestApp(t)
	if _, _, err := a.agentGetGeoSummary(taskCtx, nil, agentGeoReadInput{Path: agentDocumentPath(foreign.DocID)}); err == nil {
		t.Fatal("cross-user GEO read accepted", stranger.ID)
	}
	// A new message can reuse the current summary without paying for generation.
	if err := a.finishWritingTask(ctx, task, "completed", "", nil, "GEO 已保存"); err != nil {
		t.Fatal(err)
	}
	next := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, session, doc, "准备公众号草稿并带上 GEO 摘要", http.Header{agentPublishingHeader: {"1"}, agentGeoHeader: {"1"}}))
	before, _ := a.loadCreditBalance(ctx, user.ID)
	in.Proof = geoTestProof(t, a, next, "generate_wechat_geo_summary", in)
	_, reused, err := a.agentGenerateGeoSummary(context.WithValue(ctx, writingMCPContext{}, next), nil, in)
	if err != nil || reused.Status != "reused" || reused.Credits != 0 || calls.Load() != 1 {
		t.Fatal("current summary not reused", reused, err)
	}
	if after, _ := a.loadCreditBalance(ctx, user.ID); before.Balance != after.Balance {
		t.Fatal("reuse charged")
	}
	target := publicationTestTarget(t, a, user, "wechat")
	_, preview, err := a.agentPreparePublication(context.WithValue(ctx, writingMCPContext{}, next), nil, agentPreparePublicationInput{Path: in.Path, Channel: "wechat", TargetID: target.TargetID, IncludeGeo: true})
	if err != nil {
		t.Fatal(err)
	}
	p := preview["publication"].(agentPublication)
	stored, err := scanAgentPublication(a.db.QueryRow(ctx, `SELECT `+agentPublicationColumns+` FROM agent_publications p WHERE p.id=$1`, p.ID))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Snapshot.GeoText != out.Geo.Text {
		t.Fatal("summary not frozen")
	}
	payload, err := a.publicationPayload(stored)
	if err != nil {
		t.Fatal(err)
	}
	var body struct{ HTML string }
	_ = json.Unmarshal(payload, &body)
	if !strings.Contains(body.HTML, buildWechatGeoSection(out.Geo.Text)) {
		t.Fatal("GEO missing from WeChat payload")
	}
	get := writingTestRequest(t, a, user, "GET", "/api/agent/publications/"+p.ID, nil)
	var detail struct{ GeoText string }
	_ = json.Unmarshal(get.Body.Bytes(), &detail)
	if get.Code != 200 || detail.GeoText != out.Geo.Text {
		t.Fatal("preview missing exact GEO text")
	}
	if err := a.finishWritingTask(ctx, next, "completed", "", nil, "请确认"); err != nil {
		t.Fatal(err)
	}
	flag := false
	if _, err := a.updateWechatGeoSummaryText(ctx, user.ID, doc.DocID, nil, &flag); err != nil {
		t.Fatal(err)
	}
	response := writingTestRequest(t, a, user, "POST", "/api/agent/publications/"+p.ID+"/confirm", map[string]string{"hash": p.Hash})
	if response.Code != 409 || !strings.Contains(response.Body.String(), "publication_changed") {
		t.Fatal("changed GEO was sent", response.Code, response.Body.String())
	}
	flag = true
	if _, err := a.updateWechatGeoSummaryText(ctx, user.ID, doc.DocID, nil, &flag); err != nil {
		t.Fatal(err)
	}
	var sends atomic.Int32
	a.wechatAPIHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/cgi-bin/stable_token":
			return jsonResponse(`{"access_token":"wechat-token","expires_in":7200}`), nil
		case "/cgi-bin/material/add_material":
			return jsonResponse(`{"media_id":"wechat-thumb"}`), nil
		case "/cgi-bin/draft/add":
			var body struct {
				Articles []struct {
					Content string `json:"content"`
				} `json:"articles"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || len(body.Articles) != 1 || !strings.Contains(body.Articles[0].Content, buildWechatGeoSection(out.Geo.Text)) {
				t.Error("WeChat handler dropped GEO summary")
			}
			sends.Add(1)
			return jsonResponse(`{"media_id":"geo-draft"}`), nil
		}
		return nil, errors.New("unexpected WeChat API")
	})}
	before, _ = a.loadCreditBalance(ctx, user.ID)
	for range 2 {
		if result := publicationTestAction(t, a, user, p, "confirm"); result.Status != "sent" {
			t.Fatal("GEO draft not sent", result)
		}
	}
	after, _ := a.loadCreditBalance(ctx, user.ID)
	if sends.Load() != 1 || before.Balance-after.Balance != wechatDraftSyncCredits {
		t.Fatal("GEO publication replay/billing", sends.Load(), before, after)
	}
}

func TestAgentGeoInsufficientCreditsAndExplicitRegeneration(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	var calls atomic.Int32
	geoTestProvider(a, &calls, nil)
	session := agentTestSession(t, a, user, "review")
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, session, doc, "生成 GEO 摘要", http.Header{agentGeoHeader: {"1"}}))
	in := agentGeoGenerateInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ProviderMode: "builtin"}
	in.Proof = geoTestProof(t, a, task, "generate_wechat_geo_summary", in)
	// Leave the text task's reservation intact, but no Credits for GEO generation.
	if _, err := a.db.Exec(ctx, `UPDATE credit_accounts SET balance=reserved WHERE user_id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	_, _, err := a.agentGenerateGeoSummary(context.WithValue(ctx, writingMCPContext{}, task), nil, in)
	if err == nil || !strings.Contains(err.Error(), "Credits 不足") || calls.Load() != 0 {
		t.Fatal("insufficient credit preflight", err, calls.Load())
	}
	grantCreditsForTest(t, a.db, user.ID, 20, "geo-test-topup")
	if _, _, err := a.agentGenerateGeoSummary(context.WithValue(ctx, writingMCPContext{}, task), nil, in); err == nil || calls.Load() != 0 {
		t.Fatal("failed attempt silently retried")
	}
	if err := a.finishWritingTask(ctx, task, "completed", "", nil, "请发送新消息重试"); err != nil {
		t.Fatal(err)
	}
	for _, regenerate := range []bool{false, true} {
		next := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, session, doc, "重新生成 GEO 摘要", http.Header{agentGeoHeader: {"1"}}))
		in.Regenerate = regenerate
		in.Proof = geoTestProof(t, a, next, "generate_wechat_geo_summary", in)
		before, _ := a.loadCreditBalance(ctx, user.ID)
		_, out, err := a.agentGenerateGeoSummary(context.WithValue(ctx, writingMCPContext{}, next), nil, in)
		after, _ := a.loadCreditBalance(ctx, user.ID)
		if err != nil || out.Status != "pending" || before.Balance-after.Balance != creditsForTokens(1200) {
			t.Fatal("new generation/explicit regeneration", err, out, before, after)
		}
		_ = geoTestApprove(t, a, user, next, out)
		if err := a.finishWritingTask(ctx, next, "completed", "", nil, "摘要已保存"); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 2 {
		t.Fatal("wrong regeneration count", calls.Load())
	}
}

func TestAgentGeoSlowPollingDoesNotRestartGeneration(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "生成 GEO 摘要", http.Header{agentGeoHeader: {"1"}}))
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	in := agentGeoGenerateInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ProviderMode: "builtin"}
	in.Proof = geoTestProof(t, a, task, "generate_wechat_geo_summary", in)
	var calls atomic.Int32
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	geoTestProvider(a, &calls, func() { <-release })
	_, out, err := a.agentGenerateGeoSummary(ctx, nil, in)
	if err != nil || out.Status != "generating" || out.OperationStatus != "proposed" || calls.Load() != 1 {
		t.Fatal("slow MCP polling contract", out, err)
	}
	close(release)
	_, out, err = a.agentGenerateGeoSummary(ctx, nil, in)
	if err != nil || out.Status != "pending" || calls.Load() != 1 {
		t.Fatal("poll started another generation", out, err)
	}
}

func geoTestApprove(t *testing.T, a *App, user model.User, task writingTask, out agentGeoOutput) agentGeoOutput {
	t.Helper()
	if len(out.Operations) != 1 {
		t.Fatal("missing GEO approval operation", out)
	}
	op, err := scanAgentOperation(a.db.QueryRow(context.Background(), `SELECT `+agentOperationColumns+` FROM agent_operations WHERE id=$1`, out.Operations[0]["id"]))
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		w := writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+op.ID+"/approve", map[string]string{"hash": op.Hash})
		if w.Code != 200 {
			t.Fatal("approve GEO", w.Code, w.Body.String())
		}
	}
	op, err = scanAgentOperation(a.db.QueryRow(context.Background(), `SELECT `+agentOperationColumns+` FROM agent_operations WHERE id=$1`, op.ID))
	if err != nil {
		t.Fatal(err)
	}
	applied, err := a.agentGeoOperationResult(context.Background(), task, op)
	if err != nil || applied.Status != "saved" || applied.OperationStatus != "applied" {
		t.Fatal("GEO approval not applied", applied, err)
	}
	return applied
}
