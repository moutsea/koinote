package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"koinote/backend/internal/model"
)

func TestArticleKoiIsBoundToOneDocument(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	other, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "参考文档", Content: "只读参考正文"})
	if err != nil {
		t.Fatal(err)
	}
	open := func(id string) agentSession {
		w := writingTestRequest(t, a, user, "POST", "/api/documents/"+id+"/koi-session", nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var page struct{ Session agentSession }
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page.Session
	}
	s := open(doc.DocID)
	if s.WriteDocumentID != doc.DocID || s.Permission != "review" || open(doc.DocID).ID != s.ID || open(other.DocID).ID == s.ID {
		t.Fatal("document session identity changed")
	}
	w := writingTestRequest(t, a, user, "GET", "/api/agent/sessions", nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), s.ID) {
		t.Fatal("editor session leaked into general Koi history", w.Code)
	}
	w = writingTestRequest(t, a, user, "PUT", "/api/agent/sessions/"+s.ID, map[string]any{"permission": "full", "revision": s.Revision})
	if w.Code != 409 {
		t.Fatal("scope permission widened", w.Code)
	}
	key, _ := randomUUID()
	w = writingTestRequest(t, a, user, "POST", "/api/agent/sessions/"+s.ID+"/tasks", map[string]any{"requestId": key, "message": "改写参考文章", "context": map[string]string{"path": agentDocumentPath(other.DocID)}})
	if w.Code != 400 {
		t.Fatal("client changed bound article", w.Code)
	}
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, s, model.Document{}, "参考其他文章的语气，润色当前文章"))
	if task.Source.DocID != doc.DocID {
		t.Fatal("task lost original article")
	}
	wire := map[string]any{"policy": map[string]any{}}
	if err = a.prepareAgentConversationInput(ctx, &task, wire, ""); err != nil {
		t.Fatal(err)
	}
	tools := strings.Join(wire["policy"].(map[string]any)["allowTools"].([]string), ",")
	if strings.Contains(tools, "propose_operations") || strings.Contains(tools, "sandbox_compute") || !strings.Contains(tools, "propose_document_change") || !strings.Contains(wire["systemPrompt"].(string), agentDocumentPath(doc.DocID)) {
		t.Fatal("unscoped wire contract", tools)
	}
	mcpCtx := context.WithValue(ctx, writingMCPContext{}, task)
	for _, article := range []model.Document{doc, other} {
		if _, _, err = a.agentReadDocument(mcpCtx, nil, agentReadInput{Path: agentDocumentPath(article.DocID)}); err != nil {
			t.Fatal("read denied", err)
		}
	}
	allowed := agentOperationInput{Key: "revise", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "润色后的当前文章", Explanation: "调整开头"}
	for _, forbidden := range []agentOperationInput{
		{Key: "foreign", Kind: "update", Path: agentDocumentPath(other.DocID), ExpectedRevision: other.Revision, Content: "越权"},
		{Key: "delete", Kind: "trash", Path: allowed.Path}, {Key: "move", Kind: "move", Path: allowed.Path},
		{Key: "new", Kind: "create"}, {Key: "folder", Kind: "folder"}, {Key: "remove-folder", Kind: "delete_folder"},
	} {
		inputs := []agentOperationInput{allowed, forbidden}
		args := map[string]any{"operations": inputs}
		if _, proof, e := a.agentValidateOperation(mcpCtx, nil, agentIntentValidateInput{ToolName: "propose_operations", Task: intentBindingForTest(task), Arguments: args}); !errors.Is(e, errArticleWriteScope) || proof != nil {
			t.Fatal("issued out-of-scope proof", forbidden.Kind, e)
		}
		if _, e := a.proposeAgentOperations(ctx, task, inputs); !errors.Is(e, errArticleWriteScope) {
			t.Fatal("out-of-scope execution", forbidden.Kind, e)
		}
	}
	if _, _, err = a.agentSaveArtifact(mcpCtx, nil, agentArtifactInput{Name: "outside.txt", Content: "file"}); !errors.Is(err, errArticleWriteScope) {
		t.Fatal("unexpected artifact write", err)
	}
	var count int
	if err = a.db.QueryRow(ctx, "SELECT count(*) FROM agent_operations WHERE task_id=$1", task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("partial batch", count, err)
	}
	args := writingProposalInput{DocID: doc.DocID, ExpectedRevision: doc.Revision, Title: allowed.Title, Content: allowed.Content, Explanation: allowed.Explanation}
	raw := map[string]any{"docId": args.DocID, "expectedRevision": args.ExpectedRevision, "title": args.Title, "content": args.Content, "explanation": args.Explanation}
	_, proof, err := a.agentValidateOperation(mcpCtx, nil, agentIntentValidateInput{ToolName: "propose_document_change", Task: intentBindingForTest(task), Arguments: raw})
	if err != nil || proof == nil || proof.Token == "" {
		t.Fatal("bound article proof denied", err, proof)
	}
	args.Proof = proof
	foreign := args
	foreign.DocID = other.DocID
	if _, _, err = a.writingProposeDocument(mcpCtx, nil, foreign); !errors.Is(err, errArticleWriteScope) {
		t.Fatal("article tool reused proof on another document", err)
	}
	if _, _, err = a.writingProposeDocument(mcpCtx, nil, args); err != nil {
		t.Fatal(err)
	}
	ops, err := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
	if err != nil || len(ops) != 1 || ops[0].Status != "pending" {
		t.Fatal("expected pending current article change", err, ops)
	}
	op := ops[0]
	approve := func(action string) int {
		return writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+op.ID+"/"+action, map[string]string{"hash": op.Hash}).Code
	}
	// Even a persisted, malformed proposal cannot redirect approval to a
	// reference document. Both action endpoints use the same execution guard.
	if _, err = a.db.Exec(ctx, "UPDATE agent_operations SET before_state=jsonb_set(before_state,'{document,docId}',to_jsonb($2::text)) WHERE id=$1", op.ID, other.DocID); err != nil {
		t.Fatal(err)
	}
	if code := approve("approve"); code != 400 {
		t.Fatal("foreign snapshot approved", code)
	}
	if _, err = a.db.Exec(ctx, "UPDATE agent_operations SET before_state=jsonb_set(before_state,'{document,docId}',to_jsonb($2::text)) WHERE id=$1", op.ID, doc.DocID); err != nil {
		t.Fatal(err)
	}
	if code := approve("approve"); code != 200 {
		t.Fatal(code)
	}
	fresh, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if err != nil || fresh.Content != allowed.Content {
		t.Fatal("approved rewrite missing", err)
	}
	if code := approve("undo"); code != 200 {
		t.Fatal(code)
	}
	fresh, err = a.loadAgentReviewDocument(ctx, user.ID, other.DocID)
	if err != nil || fresh.Content != other.Content || fresh.Revision != other.Revision {
		t.Fatal("reference was changed", err)
	}
	fresh, err = a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if err != nil || fresh.Content != doc.Content {
		t.Fatal("original article not restored", err)
	}
}

func TestArticleKoiRetiresOldGeneration(t *testing.T) {
	a, user, doc := writingTestApp(t)
	for _, suffix := range []string{"", "/estimate"} {
		w := writingTestRequest(t, a, user, "POST", "/api/documents/"+doc.DocID+"/agent-reviews"+suffix, map[string]any{})
		if w.Code != 410 || !strings.Contains(w.Body.String(), "agent_review_retired") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestArticleKoiApproveAndUndoAcrossMetadataSaves(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	w := writingTestRequest(t, a, user, "POST", "/api/documents/"+doc.DocID+"/koi-session", nil)
	var page struct{ Session agentSession }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil {
		t.Fatal("opening article session", w.Code)
	}
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, user, page.Session, doc, "请修正错别字并润色"))
	wire := map[string]any{}
	if err := a.prepareAgentConversationInput(ctx, &task, wire, ""); err != nil {
		t.Fatal(err)
	}
	condition := wire["taskContext"].(map[string]any)["finishAfterApplied"].(map[string]string)
	if condition["tool"] != "koinote.propose_document_change" || condition["resourceId"] != agentDocumentPath(doc.DocID) {
		t.Fatal("unbound completion condition", condition)
	}
	agentTestRead(t, a, task, doc)
	edit := agentOperationInput{Key: "final-revision", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "修订后的完整正文。", Explanation: "修正错别字和表达。"}
	inputs := []agentOperationInput{edit}
	proof, err := agentProofForTest(a, ctx, task, "propose_document_change", inputs)
	if err != nil {
		t.Fatal(err)
	}
	auth := agentIntentAuthorization{ToolName: "propose_document_change", Proof: proof}
	ops, err := a.proposeAgentOperations(ctx, task, inputs, auth)
	if err != nil || len(ops) != 1 || ops[0].Status != "pending" {
		t.Fatal("expected single pending proposal", err)
	}
	op := ops[0]
	action := func(name string) int {
		return writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+op.ID+"/"+name, map[string]string{"hash": op.Hash}).Code
	}
	save := func(body, theme string) {
		t.Helper()
		if _, e := a.db.Exec(ctx, `UPDATE documents SET content=$3,theme=$4,revision=revision+1 WHERE user_id=$1 AND doc_id=$2`, user.ID, doc.DocID, body, theme); e != nil {
			t.Fatal(e)
		}
	}
	check := func(body, theme string) {
		t.Helper()
		fresh, e := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
		if e != nil || fresh.Content != body || fresh.Theme != theme {
			t.Fatal("article text or theme did not match", e)
		}
	}
	save("用户另外写的正文", "ink")
	if action("approve") != 409 {
		t.Fatal("approval overwrote a new edit")
	}
	check("用户另外写的正文", "ink")
	save(doc.Content, "ink")
	if action("approve") != 200 {
		t.Fatal("metadata-only change blocked approval")
	}
	check(edit.Content, "ink")
	replayed, err := a.proposeAgentOperations(ctx, task, inputs, auth)
	if err != nil || len(replayed) != 1 || replayed[0].ID != op.ID || replayed[0].Status != "applied" {
		t.Fatal("metadata-only save changed the signed snapshot or repeated the write", err)
	}

	save("用户后续的编辑", "paper")
	if action("undo") != 409 {
		t.Fatal("undo overwrote a new edit")
	}
	check("用户后续的编辑", "paper")
	save(edit.Content, "paper")
	if action("undo") != 200 {
		t.Fatal("metadata-only change blocked undo")
	}
	check(doc.Content, "paper")
}
