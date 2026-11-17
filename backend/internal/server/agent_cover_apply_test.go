package server

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

func setCoverProofForTest(t *testing.T, a *App, task writingTask, in agentSetCoverInput) *agentIntentProof {
	t.Helper()
	raw, _ := json.Marshal(in)
	var arguments map[string]any
	_ = json.Unmarshal(raw, &arguments)
	_, proof, err := a.agentValidateOperation(context.WithValue(context.Background(), writingMCPContext{}, task), nil, agentIntentValidateInput{ToolName: "set_document_cover", Task: intentBindingForTest(task), Arguments: arguments})
	if err != nil || proof == nil {
		t.Fatal("cover validation", err)
	}
	return proof
}

func generateCoverForApplyTest(t *testing.T, article bool, ratios ...string) (*App, model.User, model.Document, writingTask, agentArtifact, *atomic.Int32) {
	t.Helper()
	a, user, doc, task, input := coverTestTask(t, article)
	if len(ratios) > 0 {
		input.Ratio = ratios[0]
		input.Proof = coverTestProof(t, a, task, input)
	}
	calls := &atomic.Int32{}
	a.wechatCoverHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return coverProviderResponse(testWechatCoverJPEG(t)), nil
	})}
	_, output, err := a.generateAgentCover(context.WithValue(context.Background(), writingMCPContext{}, task), input)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.finishWritingTask(context.Background(), task, "completed", "", json.RawMessage(`{"totalTokens":0}`), "封面已生成，可以将这张图片设为文章封面。"); err != nil {
		t.Fatal(err)
	}
	return a, user, doc, task, output.Artifact, calls
}

func TestAgentCoverFollowupApplyAndUndo(t *testing.T) {
	for _, test := range []struct{ mode, ratio string }{
		{"article", "16:9"},
		{"review", "1:1"},
		{"assist", "1:2.9"},
		{"full", wechatCoverRatioWide},
		{"delete-session", "16:9"},
	} {
		mode := test.mode
		t.Run(mode, func(t *testing.T) {
			a, user, doc, previous, artifact, calls := generateCoverForApplyTest(t, mode == "article", test.ratio)
			ctx := context.Background()
			session, err := a.loadAgentSession(ctx, a.db, previous.SessionID, user.ID)
			if err != nil {
				t.Fatal(err)
			}
			permission := mode
			if mode == "delete-session" {
				permission = "full"
			}
			if mode != "article" {
				if _, err = a.db.Exec(ctx, `UPDATE agent_sessions SET permission=$2 WHERE id=$1`, session.ID, permission); err != nil {
					t.Fatal(err)
				}
				session.Permission = permission
			}
			oldKey := "u/" + user.AuthUserID + "/" + strings.Repeat("a", 32) + ".jpg"
			oldSource, oldMode, oldRatio, oldPrompt := "/images/"+oldKey, "ai", "1:1", "Original cover"
			doc, err = a.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content, Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb, CoverMode: &oldMode, CoverRatio: &oldRatio, CoverImageSource: &oldSource, CoverPrompt: &oldPrompt})
			if err != nil {
				t.Fatal(err)
			}
			task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, session, doc, "帮我设置", http.Header{agentCoversHeader: {"1"}, agentCoverApplyHeader: {"1"}}))
			// Keep the pool at one connection: Worker quota callbacks must not deadlock.
			poolConfig := a.db.Config()
			poolConfig.MaxConns, poolConfig.MinConns = 1, 0
			limited, err := pgxpool.NewWithConfig(ctx, poolConfig)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(limited.Close)
			a.db = limited
			wire := map[string]any{"policy": map[string]any{}}
			if err = a.prepareAgentConversationInput(ctx, &task, wire, ""); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(wire["systemPrompt"].(string), artifact.ID) || !strings.Contains(wire["systemPrompt"].(string), agentCoverApplyInstructions) || !strings.Contains(strings.Join(wire["policy"].(map[string]any)["allowTools"].([]string), ","), "koinote.set_document_cover") {
				t.Fatal("follow-up lost generated image/capability")
			}
			history, _, err := a.agentConversationHistory(ctx, task, "", 6)
			if err != nil || len(history) != 1 || len(history[0]["artifacts"].([]agentArtifact)) != 1 {
				t.Fatal("history lost image", history, err)
			}
			mcpContext := context.WithValue(ctx, writingMCPContext{}, task)
			if _, _, err = a.agentReadDocument(mcpContext, nil, agentReadInput{}); err != nil {
				t.Fatal(err)
			}
			input := agentSetCoverInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ArtifactID: artifact.ID}
			input.Proof = setCoverProofForTest(t, a, task, input)
			newKey := "u/" + user.AuthUserID + "/" + strings.Repeat("b", 32) + ".jpg"
			expectedData, err := a.loadAgentCoverArtifact(ctx, a.db, task, artifact.ID)
			if err != nil {
				t.Fatal(err)
			}
			generated, _, err := image.DecodeConfig(bytes.NewReader(expectedData))
			if err != nil {
				t.Fatal(err)
			}
			var uploads atomic.Int32
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				uploads.Add(1)
				data, _ := io.ReadAll(r.Body)
				if r.URL.Path != "/api/images" || r.Header.Get("X-Koinote-Internal-Token") != a.cfg.InternalToken || r.Header.Get("X-Auth-User-Id") != user.AuthUserID || !bytes.Equal(data, expectedData) {
					t.Error("image transfer contract")
				}
				if _, err := a.recordImageObject(r.Context(), user.ID, newKey, int64(len(data)), a.storageQuotaFor(user), imagePurposePersistent, nil); err != nil {
					t.Error(err)
					w.WriteHeader(500)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"image": map[string]any{"key": newKey}})
			}))
			defer worker.Close()
			a.cfg.WorkerURL, a.cfg.InternalToken = worker.URL, "test-cover-transfer-token"
			balance, _ := a.loadCreditBalance(ctx, user.ID)
			srv := httptest.NewServer(a.Routes())
			defer srv.Close()
			client, err := connectMCPClient(ctx, srv.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			for range 2 {
				input.Proof = setCoverProofForTest(t, a, task, input)
				result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "set_document_cover", Arguments: input})
				if err != nil || result.IsError {
					t.Fatal(result, err)
				}
			}
			ops, err := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
			if err != nil || len(ops) != 1 || ops[0].Input.Kind != "cover" || uploads.Load() != 1 {
				t.Fatal("cover retry", ops, uploads.Load(), err)
			}
			if permission != "full" {
				unchanged, _ := a.loadAgentSnapshot(ctx, a.db, user.ID, doc.DocID)
				if ops[0].Status != "pending" || unchanged.Document.CoverImageSource != oldSource {
					t.Fatal("bypassed approval")
				}
				// Saving text while the cover preview is open must not invalidate
				// that cover-only review or replace the newly saved text.
				doc, err = a.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content + "\n\nSaved during cover review.", Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb})
				if err != nil {
					t.Fatal(err)
				}
				w := writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]any{"hash": ops[0].Hash})
				if w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
			}
			applied, err := a.loadAgentSnapshot(ctx, a.db, user.ID, doc.DocID)
			if err != nil || applied.Document.Title != doc.Title || applied.Document.Content != doc.Content || applied.Document.Theme != doc.Theme || applied.Document.CoverMode != "article" || applied.Document.CoverImageSource != "/images/"+newKey {
				t.Fatal("incorrect cover application", applied, err)
			}
			width, height, valid := parseWechatCoverRatio(applied.Document.CoverRatio)
			if !valid || width*generated.Height != height*generated.Width {
				t.Fatalf("generated image %dx%d lost its ratio: %s", generated.Width, generated.Height, applied.Document.CoverRatio)
			}
			_, thumbWidth, thumbHeight, err := prepareWechatThumb(expectedData, applied.Document.CoverRatio)
			if err != nil || thumbWidth != generated.Width || thumbHeight != generated.Height {
				t.Fatalf("publishing changed generated dimensions %dx%d to %dx%d: %v", generated.Width, generated.Height, thumbWidth, thumbHeight, err)
			}
			if source := a.publicationImageSource(applied.Document.CoverImageSource); !strings.HasPrefix(source, "https://") || !strings.HasSuffix(source, newKey) {
				t.Fatal("publishing cannot use cover", source)
			}
			input.Proof = setCoverProofForTest(t, a, task, input)
			if _, _, err := a.agentSetDocumentCover(mcpContext, nil, input); err != nil || uploads.Load() != 1 {
				t.Fatal("guarded replay after approval", err, uploads.Load())
			}
			refs, err := a.referencedImageKeys(ctx, []int64{int64(user.ID), int64(user.ID)}, []string{oldKey, newKey})
			if err != nil || len(refs) != 2 {
				t.Fatal("GC lost undo/cover reference", refs, err)
			}
			if mode == "delete-session" {
				w := writingTestRequest(t, a, user, "DELETE", "/api/agent/sessions/"+session.ID, nil)
				if w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
				kept, err := a.loadAgentSnapshot(ctx, a.db, user.ID, doc.DocID)
				refs, refErr := a.referencedImageKeys(ctx, []int64{int64(user.ID)}, []string{newKey})
				if err != nil || refErr != nil || kept.Document.CoverImageSource != "/images/"+newKey || len(refs) != 1 {
					t.Fatal("session deletion broke article cover", kept, err, refErr)
				}
				return
			}
			latestContent := applied.Document.Content + "\n\nSaved before cover undo."
			if _, err := a.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: latestContent, Theme: doc.Theme, ExpectedRevision: applied.Document.Revision, Source: documentSourceWeb}); err != nil {
				t.Fatal(err)
			}
			w := writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+ops[0].ID+"/undo", map[string]any{"hash": ops[0].Hash})
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			restored, _ := a.loadAgentSnapshot(ctx, a.db, user.ID, doc.DocID)
			if restored.Document.CoverImageSource != oldSource || restored.Document.CoverMode != oldMode || restored.Document.CoverRatio != oldRatio || restored.Document.CoverPrompt != oldPrompt || restored.Document.Title != doc.Title || restored.Document.Content != latestContent {
				t.Fatal("undo did not restore cover only", restored)
			}
			after, _ := a.loadCreditBalance(ctx, user.ID)
			if calls.Load() != 1 || balance.Balance != after.Balance || balance.Reserved != after.Reserved {
				t.Fatal("apply/undo charged image credits", balance, after, calls.Load())
			}
		})
	}
}

func TestAgentCoverApplyRejectsWrongSessionAndStaleRevision(t *testing.T) {
	a, user, doc, previous, artifact, _ := generateCoverForApplyTest(t, true)
	ctx := context.Background()
	session, _ := a.loadAgentSession(ctx, a.db, previous.SessionID, user.ID)
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, session, doc, "帮我设置", http.Header{agentCoversHeader: {"1"}, agentCoverApplyHeader: {"1"}}))
	mcpContext := context.WithValue(ctx, writingMCPContext{}, task)
	in := agentSetCoverInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ArtifactID: artifact.ID}
	if _, _, err := a.agentSetDocumentCover(mcpContext, nil, in); err == nil {
		t.Fatal("missing proof accepted")
	}
	if _, _, err := a.agentReadDocument(mcpContext, nil, agentReadInput{}); err != nil {
		t.Fatal(err)
	}
	in.Proof = setCoverProofForTest(t, a, task, in)
	otherSession := agentTestSession(t, a, user, "review")
	other := task
	other.SessionID = otherSession.ID
	if _, err := a.loadAgentCoverArtifact(ctx, a.db, other, artifact.ID); err == nil {
		t.Fatal("cross-session artifact")
	}
	outside, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Other", Content: "Private"})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.validateAgentSetCover(ctx, a.db, task, session, agentSetCoverInput{Path: agentDocumentPath(outside.DocID), ExpectedRevision: outside.Revision, ArtifactID: artifact.ID}); err == nil {
		t.Fatal("article scope expanded")
	}
	_, err = a.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content + " user edit", Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.agentSetDocumentCover(mcpContext, nil, in); err == nil {
		t.Fatal("stale revision accepted")
	}
	ops, _ := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
	if len(ops) != 0 {
		t.Fatal("invalid cover created operation")
	}
}

func TestAgentCoverApplyTransferFailures(t *testing.T) {
	for _, scenario := range []string{"quota", "cancelled", "cover-changed"} {
		t.Run(scenario, func(t *testing.T) {
			a, user, doc, previous, artifact, calls := generateCoverForApplyTest(t, false)
			ctx := context.Background()
			session, _ := a.loadAgentSession(ctx, a.db, previous.SessionID, user.ID)
			task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, session, doc, "将它设为文章封面", http.Header{agentCoversHeader: {"1"}, agentCoverApplyHeader: {"1"}}))
			mcpContext := context.WithValue(ctx, writingMCPContext{}, task)
			if _, _, err := a.agentReadDocument(mcpContext, nil, agentReadInput{}); err != nil {
				t.Fatal(err)
			}
			input := agentSetCoverInput{Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, ArtifactID: artifact.ID}
			input.Proof = setCoverProofForTest(t, a, task, input)
			balance, _ := a.loadCreditBalance(ctx, user.ID)
			key := "u/" + user.AuthUserID + "/" + strings.Repeat("c", 32) + ".jpg"
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if scenario == "quota" {
					w.WriteHeader(http.StatusRequestEntityTooLarge)
					return
				}
				if scenario == "cancelled" {
					if err := a.cancelAgentTask(r.Context(), user.ID, task.ID); err != nil {
						t.Error(err)
					}
				} else {
					source := "https://example.test/new-user-cover.jpg"
					if _, err := a.updateDocument(r.Context(), updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content, Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb, CoverImageSource: &source}); err != nil {
						t.Error(err)
					}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"image": map[string]any{"key": key}})
			}))
			defer worker.Close()
			a.cfg.WorkerURL, a.cfg.InternalToken = worker.URL, "test-cover-transfer"
			_, _, err := a.agentSetDocumentCover(mcpContext, nil, input)
			if err == nil {
				t.Fatal("failed/cancelled transfer created proposal")
			}
			if scenario == "quota" && !strings.Contains(err.Error(), "空间不足") {
				t.Fatal("lost actionable quota error", err)
			}
			ops, _ := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
			after, _ := a.loadCreditBalance(ctx, user.ID)
			if len(ops) != 0 || calls.Load() != 1 || after.Balance != balance.Balance {
				t.Fatal("failure changed article or charged again", ops, after, balance)
			}
			if scenario != "quota" {
				var queued bool
				if err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pending_image_deletions WHERE object_key=$1)`, key).Scan(&queued); err != nil || !queued {
					t.Fatal("unattached image not queued for cleanup", queued, err)
				}
			}
		})
	}
}

func TestAgentCoverApplyCapability(t *testing.T) {
	_, _, _, task, _ := coverTestTask(t, true)
	if agentCoverApplyEnabled(task) || strings.Contains(agentCoverPrompt(task), agentCoverApplyInstructions) {
		t.Fatal("old client exposed cover application")
	}
	task.Skill = json.RawMessage(`{"coverApplyEnabled":true}`)
	if !agentCoverApplyEnabled(task) || !strings.Contains(agentCoverPrompt(task), agentCoverApplyInstructions) {
		t.Fatal("capable client lost cover application")
	}
}

// Export the actual host envelope for a separately opted-in semantic replay.
// Passing this test proves history transport only, not model understanding.
func TestAgentCoverConversationContext(t *testing.T) {
	a, user, doc, first, artifact, _ := generateCoverForApplyTest(t, true)
	ctx := context.Background()
	original := "根据文章内容帮我生成一张公众号封面图"
	reply := "封面已经生成好了，可以在本次对话里预览、下载。扣了 20 Credits，这笔是单独计算在文字模型花费之外的。\n\n按公众号封面的比例出的横图，我发给它的是创意方向，画面由模型自己画，也刻意没让它写文字，所以标题你放上去比较自由。\n\n几个说明：\n\n一张任务里只出这一张。想换个方向，比如改成实拍感、改成只有一只机器和对话气泡、或者换成 16:9，发条新消息我再生成。\n封面图不放进文章正文，也不改动文章内容。\n上一轮我列的四个选题和推荐的第 2 个还等你回复。定了选题，我可以把标题和这张封面搭起来看合不合适。"
	source := map[string]string{"messageId": agentUserMessageID(first.ID), "quote": original}
	state := map[string]any{"goal": map[string]any{"text": original, "sources": []any{source}}, "targets": []any{map[string]any{"resourceId": agentDocumentPath(doc.DocID), "sources": []any{source}}}, "constraints": []any{}, "questions": []any{}, "suggestions": []any{}}
	stateJSON, _ := json.Marshal(state)
	intentJSON, _ := json.Marshal(map[string]any{"outcome": "operations_reported", "modelOutput": reply})
	if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET message=$2,result='koinote.generate_cover: generated_not_applied',intent_result=$3 WHERE id=$1`, first.ID, original, intentJSON); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(ctx, `UPDATE agent_sessions SET intent_state=$2 WHERE id=$1`, first.SessionID, stateJSON); err != nil {
		t.Fatal(err)
	}
	session, err := a.loadAgentSession(ctx, a.db, first.SessionID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	next := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, session, doc, "帮我设置", http.Header{agentCoversHeader: {"1"}, agentCoverApplyHeader: {"1"}}))
	fixed := map[string]any{"policy": map[string]any{}}
	if err := a.prepareAgentIntentInput(ctx, &next, fixed, ""); err != nil {
		t.Fatal(err)
	}
	history := fixed["initialMessages"].([]map[string]any)
	if len(history) != 3 || history[0]["content"] != original || !strings.Contains(history[1]["content"].(string), reply) || history[2]["content"] != "帮我设置" {
		t.Fatal("exact conversation was lost")
	}
	if !strings.Contains(fixed["systemPrompt"].(string), agentConversationContinuityInstructions) {
		t.Fatal("shared continuation contract missing")
	}
	raw, _ := json.Marshal(fixed)
	var baseline map[string]any
	_ = json.Unmarshal(raw, &baseline)
	prompt := strings.Replace(fixed["systemPrompt"].(string), agentCoverPrompt(next), agentCoverInstructions, 1)
	prompt = strings.Replace(prompt, "结合完整会话历史理解简短追问和指代，继续用户已明确的目标；助手的建议不代表用户已授权执行。", "", 1)
	prompt = strings.Replace(prompt, "\n\n"+agentConversationContinuityInstructions, "", 1)
	prompt, _, _ = strings.Cut(prompt, agentReceiptMarker)
	baseline["systemPrompt"] = prompt
	tools := []string{}
	for _, name := range fixed["policy"].(map[string]any)["allowTools"].([]string) {
		if name != "koinote.set_document_cover" {
			tools = append(tools, name)
		}
	}
	baseline["policy"].(map[string]any)["allowTools"] = tools
	contextRaw, _ := json.Marshal(baseline)
	var contextOnly map[string]any
	_ = json.Unmarshal(contextRaw, &contextOnly)
	contextOnly["systemPrompt"] = prompt + "\n\n" + agentConversationContinuityInstructions
	exportAgentContract(t, "cover-context", map[string]any{"baseline": baseline, "contextOnly": contextOnly, "fixed": fixed, "document": doc, "artifact": artifact})
}
