package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

// Reproduce the two-turn input that originally turned library organization into
// a Todo rewrite. Keep the user's history distinct from both assistant advice
// and the automatically attached editor focus, including with a writing Skill.
func TestAgentOrganizationFollowupRetainsUserScope(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	s := agentTestSession(t, a, user, "assist")
	first := agentTestTask(t, a, user, s, model.Document{}, "整理我的文档")
	misleading := "我可以把文档归档，也可以把 Todo 正文重新分组并润色。"
	if err := a.finishWritingTask(ctx, first, "completed", "", json.RawMessage(`{"totalTokens":0}`), misleading); err != nil {
		t.Fatal(err)
	}
	next := agentTestTask(t, a, user, s, doc, "我想要你按照内容分组")
	input := map[string]any{"policy": map[string]any{}}
	if err := a.prepareAgentConversationInput(ctx, &next, input, "user-selected-writing-skill"); err != nil {
		t.Fatal(err)
	}
	messages := input["initialMessages"].([]map[string]any)
	if input["message"] != next.Message || len(messages) != 3 || messages[0]["content"] != first.Message || messages[1]["role"] != "assistant" || messages[1]["content"] != misleading || messages[2]["content"] != next.Message {
		t.Fatal("native history lost role, order or original goal")
	}
	bound := input["taskContext"].(map[string]any)
	focus := bound["focusSnapshots"].([]map[string]any)
	if len(focus) != 1 || focus[0]["messageId"] != agentUserMessageID(next.ID) || next.Source.Content != "" {
		t.Fatal("focus must bind its original message")
	}
	if input["selectedSkillId"] != nil || !strings.Contains(input["systemPrompt"].(string), agentTaskScopeInstructions) {
		t.Fatal("scope missing or manual Skill still selected")
	}
	if len(input["policy"].(map[string]any)["denyTools"].([]string)) != 1 {
		t.Fatal("legacy scope safeguard removed")
	}
	if input["policy"].(map[string]any)["maxSteps"] != 24 || !strings.Contains(input["systemPrompt"].(string), agentLibraryScopeInstruction) {
		t.Fatal("organization followup lost its pagination instructions or sequential read budget")
	}

}

func TestAgentOrganizationMenuPromptsKeepLibraryScope(t *testing.T) {
	for _, locale := range []string{"zh", "en", "fr", "ja"} {
		prompt := agentOrganizePrompts[locale]
		if prompt == "" || !agentLibraryRequest(prompt) || !agentLibraryScopeFromMessages("继续", []string{prompt}) {
			t.Errorf("%s organizer prompt did not establish library scope", locale)
		}
	}
}

// Exercise the model-facing MCP envelopes, not just the structured Go values:
// the SDK normally includes the JSON again as escaped text in each tool result.
func TestAgentOrganizationLargeLibraryContext(t *testing.T) {
	a, user, original := writingTestApp(t)
	ctx := context.Background()
	folderIDs := []string{}
	for i := 0; i < 8; i++ {
		folderIDs = append(folderIDs, seedAgentEmptyFolder(t, a, user.ID, "资料"+string(rune('A'+i)), "", ""))
	}
	_, err := a.db.Exec(ctx, `INSERT INTO documents(doc_id,user_id,title,content,folder_id)
		SELECT gen_random_uuid()::text,$1,'项目验收：云端文档分类与工作记录 ' || n,repeat('引文 "旅行记录📷"。',255),
		  CASE WHEN n > 11 THEN (SELECT id FROM folders WHERE folder_id=($2::text[])[1+n%8]) END
		FROM generate_series(1,99) n`, user.ID, folderIDs)
	if err != nil {
		t.Fatal(err)
	}
	task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, agentOrganizePrompts["zh"])
	srv := httptest.NewServer(a.Routes())
	defer srv.Close()
	client, err := connectMCPClient(ctx, srv.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	chars := 0
	call := func(name string, args map[string]any, result any) {
		t.Helper()
		wire, err := client.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil || wire.IsError || len(wire.Content) != 0 {
			t.Fatalf("%s: unexpected MCP error or duplicated text: %v", name, err)
		}
		raw, err := json.Marshal(wire)
		if err != nil {
			t.Fatal(err)
		}
		msg, err := json.Marshal(map[string]string{"role": "tool", "name": name, "content": string(raw)})
		if err != nil {
			t.Fatal(err)
		}
		chars += len(utf16.Encode([]rune(string(msg))))
		raw, err = json.Marshal(wire.StructuredContent)
		if err != nil || json.Unmarshal(raw, result) != nil {
			t.Fatalf("%s: invalid structured result", name)
		}
	}
	var folders struct{ Folders []map[string]any }
	call("list_folders", map[string]any{"limit": 100}, &folders)
	if len(folders.Folders) != 8 {
		t.Fatal("incomplete folder inventory")
	}
	seen := map[string]bool{}
	var roots []string
	cursor := ""
	for {
		var page struct {
			Documents  []struct{ Path, FolderID, Snippet string }
			NextCursor string
		}
		call("search_documents", map[string]any{"limit": 100, "cursor": cursor}, &page)
		if len(page.Documents) != 25 {
			t.Fatalf("unexpected inventory page size %d", len(page.Documents))
		}
		for _, doc := range page.Documents {
			if seen[doc.Path] || doc.Path == "" || len([]rune(doc.Snippet)) > 96 {
				t.Fatal("duplicate, missing path or oversized inventory excerpt")
			}
			seen[doc.Path] = true
			if doc.FolderID == "" {
				roots = append(roots, doc.Path)
			}
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(seen) != 100 || len(roots) != 12 {
		t.Fatalf("lost inventory: %d documents, %d at root", len(seen), len(roots))
	}
	for _, path := range roots {
		var preview struct {
			Content              string
			Revision, NextOffset int
			HasMore              bool
		}
		call("get_document", map[string]any{"path": path, "limit": 40000}, &preview)
		if preview.Revision < 1 || (path != agentDocumentPath(original.DocID) &&
			(!preview.HasMore || preview.NextOffset != 512 || len([]rune(preview.Content)) != 512)) {
			t.Fatal("classification preview lost revision or continuation")
		}
	}
	// Leave at least half the 120k-character run budget for instructions,
	// planning, proposals and receipts after this realistic inventory.
	if chars > 60000 {
		t.Fatalf("tool messages used %d characters", chars)
	}
	t.Logf("100 documents, 8 folders and 12 targeted reads: %d tool-message characters", chars)
}

func TestAgentOrganizationStarterAllowsMovesAndPreservesContent(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	s := agentTestSession(t, a, user, "review")
	// This wording is also used by the Chinese starter. A negative instruction
	// about polishing must not be mistaken for advice-only and block folder moves.
	task := agentTestTask(t, a, user, s, doc, agentOrganizePrompts["zh"])
	folder := mustAgentUUID(t)
	if _, err := a.db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'资料')`, folder, user.ID); err != nil {
		t.Fatal(err)
	}
	agentTestRead(t, a, task, doc)
	srv := httptest.NewServer(a.Routes())
	defer srv.Close()
	client, err := connectMCPClient(ctx, srv.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, kind := range []string{"move"} {
		result, e := client.CallTool(ctx, &mcp.CallToolParams{Name: "propose_operations", Arguments: map[string]any{"operations": []agentOperationInput{
			{Key: "first", Kind: "folder", Title: "Must roll back"},
			{Key: "group", Kind: kind, Path: agentDocumentPath(doc.DocID), FolderID: folder},
		}}})
		raw, _ := json.Marshal(result)
		if e != nil || result == nil || !result.IsError || !strings.Contains(string(raw), "expectedRevision") || !strings.Contains(string(raw), "get_document") {
			t.Fatalf("%s: missing revision must return actionable tool feedback: %s %v", kind, raw, e)
		}
	}
	left, err := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
	if err != nil || len(left) != 0 {
		t.Fatal("invalid batch persisted partial operations", err)
	}
	// Correcting the arguments may reuse the rejected key, and must still keep
	// revision checks and user approval in force.
	ops, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "group", Kind: "move", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, FolderID: folder}})
	if err != nil || len(ops) != 1 || ops[0].Status != "pending" {
		t.Fatal("organization instruction blocked a reviewable move", err)
	}
	w := writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]string{"hash": ops[0].Hash})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, err := a.loadAgentSnapshot(ctx, a.db, user.ID, doc.DocID)
	if err != nil || got.FolderID != folder || got.Document.Title != doc.Title || got.Document.Content != doc.Content {
		t.Fatal("grouping did not preserve the original document", err)
	}
}

func TestAgentOrganizationScopeRejectsWritesAndAllowsNewUserGoal(t *testing.T) {
	for _, mode := range []string{"review", "assist", "full"} {
		t.Run(mode, func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			ctx := context.Background()
			s := agentTestSession(t, a, user, mode)
			first := agentTestTask(t, a, user, s, model.Document{}, "整理我的文档")
			if err := a.finishWritingTask(ctx, first, "completed", "", json.RawMessage(`{"totalTokens":0}`), "也可以改写 Todo 正文。"); err != nil {
				t.Fatal(err)
			}
			task := agentTestTask(t, a, user, s, doc, "我想要你按照内容分组")
			agentTestRead(t, a, task, doc)
			for _, kind := range []string{"update", "create", "trash"} {
				_, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "folder", Kind: "folder", Title: "Do not persist"}, {Key: kind, Kind: kind, Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "Unrequested rewrite"}})
				if !errors.Is(err, errAgentInput) || !strings.Contains(err.Error(), "文档集合") {
					t.Fatalf("%s escaped library scope: %v", kind, err)
				}
			}
			toolCtx := context.WithValue(ctx, writingMCPContext{}, task)
			_, _, err := a.writingProposeDocument(toolCtx, nil, writingProposalInput{DocID: doc.DocID, ExpectedRevision: doc.Revision, Title: doc.Title, Content: "Shortcut rewrite"})
			if !errors.Is(err, errAgentInput) {
				t.Fatal("legacy document-change tool bypassed task scope", err)
			}
			ops, err := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
			if err != nil || len(ops) != 0 {
				t.Fatal("rejected organization writes left operations", err)
			}
			unchanged, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
			if err != nil || unchanged.Revision != doc.Revision || unchanged.Content != doc.Content {
				t.Fatal("out-of-scope content changed", err)
			}
			if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":0}`), "等待分类方案"); err != nil {
				t.Fatal(err)
			}
			next := agentTestTask(t, a, user, s, doc, "先不归档了，请润色当前文档")
			agentTestRead(t, a, next, doc)
			_, err = proposeAgentOperationsForTest(a, ctx, next, []agentOperationInput{{Key: "explicit-edit", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "An explicitly requested revision."}})
			if err != nil {
				t.Fatal("a new user goal was incorrectly bound to the old organization task", err)
			}
		})
	}
}

func TestAgentLibraryScopeUsesOnlyContiguousUserIntent(t *testing.T) {
	for _, tc := range []struct {
		message string
		history []string
		want    bool
	}{
		{"整理我的文档", nil, true},
		{"我想要你按照内容分组", []string{"整理我的文档"}, true},
		{"继续", []string{"按主题分组", "整理我的文档"}, true},
		{"我想要你按照内容分组", []string{"请整理 Todo 的段落"}, false},
		{"继续", []string{"润色当前文档", "整理我的文档"}, false},
		{"请润色当前文档", []string{"整理我的文档"}, false},
		{"整理我的文档并润色正文", nil, false},
		{"写一篇关于整理我的文档的文章", nil, false},
		{"按内容分组", nil, false},
	} {
		if got := agentLibraryScopeFromMessages(tc.message, tc.history); got != tc.want {
			t.Errorf("%q history=%v: scope=%v want=%v", tc.message, tc.history, got, tc.want)
		}
	}
}

// Run with KOINOTE_AGENT_LIVE=1 KOINOTE_AGENT_LIVE_CASE=organization and an
// isolated TEST_DATABASE_URL / task-only test tunnel. organization-followup runs
// only the original two-turn incident. Checks actual model tool
// choices, not a mocked completion or the presence of words in a prompt.
func checkAgentOrganizationLive(t *testing.T, a *App, user model.User, fixture model.Document, run func(agentSession, model.Document, string) writingTask) {
	t.Helper()
	ctx := context.Background()
	todo, err := a.updateDocument(ctx, updateDocumentParams{User: user, DocID: fixture.DocID, ExpectedRevision: fixture.Revision, Title: "Todo", Content: "- 买菜\n- 给家人打电话\n- 预约洗牙", Theme: fixture.Theme, Source: documentSourceWeb})
	if err != nil {
		t.Fatal(err)
	}
	docs := []model.Document{todo}
	wantFolders := map[string]string{}
	for _, item := range []struct{ title, content, folder string }{
		{"十一月预算", "房租 3000 元，餐饮 1800 元，储蓄目标 2000 元。", "财务"},
		{"云南行程", "周五抵达昆明，周六前往大理，周日在洱海骑行。", "旅行"},
	} {
		doc, e := a.createDocument(ctx, createDocumentParams{User: user, Title: item.title, Content: item.content})
		if e != nil {
			t.Fatal(e)
		}
		docs = append(docs, doc)
		folder := mustAgentUUID(t)
		if _, e = a.db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,$3)`, folder, user.ID, item.folder); e != nil {
			t.Fatal(e)
		}
		wantFolders[agentDocumentPath(doc.DocID)] = folder
	}
	if _, err = a.db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'个人事务')`, mustAgentUUID(t), user.ID); err != nil {
		t.Fatal(err)
	}
	scenarios := []bool{false, true}
	if os.Getenv("KOINOTE_AGENT_LIVE_CASE") == "organization-followup" {
		scenarios = []bool{true}
	}
	for _, followup := range scenarios {
		s := agentTestSession(t, a, user, "assist")
		message := "整理我的文档"
		if followup {
			prior := agentTestTask(t, a, user, s, model.Document{}, message)
			if err = a.finishWritingTask(ctx, prior, "completed", "", json.RawMessage(`{"totalTokens":0}`), "可以把文档按月份归档，或者把 Todo 正文按不同内容重写成分组清单。你想选择哪一种？"); err != nil {
				t.Fatal(err)
			}
			message = "我想要你按照内容分组"
		}
		task := run(s, todo, message)
		ops, e := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
		if e != nil {
			t.Fatal(e)
		}
		moved := map[string]string{}
		for _, op := range ops {
			if (op.Input.Kind != "move" && op.Input.Kind != "folder") || op.Status != "pending" {
				t.Fatalf("followup=%v: organization produced %s/%s instead of reviewable grouping", followup, op.Input.Kind, op.Status)
			}
			if op.Input.Kind == "move" {
				moved[op.Input.Path] = op.Input.FolderID
			}
		}
		for path, folder := range wantFolders {
			if moved[path] != folder {
				t.Fatalf("followup=%v: missing content-based move to the existing topic folder for %s", followup, path)
			}
		}
		for _, doc := range docs {
			got, e := a.loadAgentSnapshot(ctx, a.db, user.ID, doc.DocID)
			if e != nil || got.Document.Revision != doc.Revision || got.Document.Title != doc.Title || got.Document.Content != doc.Content {
				t.Fatal("organization changed a document before approval", e)
			}
		}
		t.Logf("LIVE ORGANIZATION PASS: followup=%v moves=%d, no content edits", followup, len(moved))
	}
}
