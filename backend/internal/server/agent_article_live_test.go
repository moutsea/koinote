package server

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"koinote/backend/internal/model"
)

// Uses the opt-in real-model host runner; all documents and approvals belong
// to the isolated test database, never to a production user.
func checkArticlePolishLive(t *testing.T, a *App, user model.User, run func(agentSession, model.Document, string) writingTask) {
	t.Helper()
	ctx := context.Background()
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	scenarios := []string{"direct", "followup"}
	if os.Getenv("KOINOTE_AGENT_INTENT_CASE") == "article-body" {
		scenarios = []string{"body-only"}
	}
	for _, scenario := range scenarios {
		doc, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "出海人士必备，如何用 ima 知识库做海外自媒体", Content: "# 写作经验\n\n这篇文章有一个错别子。整理知识可以帮助我们提高写作写作效率。\n\n![资料截图](https://example.com/reference.png)"})
		if err != nil {
			t.Fatal(err)
		}
		w := writingTestRequest(t, a, user, "POST", "/api/documents/"+doc.DocID+"/koi-session", nil)
		var page struct{ Session agentSession }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil {
			t.Fatal("article session", w.Code)
		}
		message := "润色表达，检查错别字"
		if scenario == "body-only" {
			message = "只润色正文表达、检查错别字，原标题保持不变。"
		}
		if scenario == "followup" {
			previous := agentTestTask(t, a, user, page.Session, doc, message)
			// Reproduce the user's short assent to the earlier scope question.
			if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET status='completed',result=$2 WHERE id=$1`, previous.ID, "您只要求润色正文和检查错别字，但方案还修改了标题标点。是否也要修改标题，还是仅润色正文？"); err != nil {
				t.Fatal(err)
			}
			state, _ := json.Marshal(map[string]any{
				"goal":        map[string]any{"text": "对当前文章润色表达并检查错别字", "sources": []map[string]string{{"messageId": agentUserMessageID(previous.ID), "quote": message}}},
				"targets":     []map[string]any{{"resourceId": agentDocumentPath(doc.DocID), "sources": []map[string]string{{"messageId": agentUserMessageID(previous.ID), "quote": message}}}},
				"constraints": []any{}, "questions": []string{}, "suggestions": []any{},
			})
			if _, err := a.db.Exec(ctx, `UPDATE agent_sessions SET intent_state=$2 WHERE id=$1`, page.Session.ID, state); err != nil {
				t.Fatal(err)
			}
			message = "可以的，一起润色"
		}
		task := run(page.Session, doc, message)
		ops, err := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
		if err != nil || len(ops) != 1 || ops[0].Status != "pending" || ops[0].Input.Path != agentDocumentPath(doc.DocID) {
			t.Fatalf("article polish scenario=%s did not submit one reviewable revision: result=%s operations=%+v err=%v", scenario, task.Result, ops, err)
		}
		if scenario == "body-only" && ops[0].Input.Title != doc.Title {
			t.Fatal("body-only request changed the title")
		}
		unchanged, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
		if err != nil || unchanged.Revision != doc.Revision || unchanged.Content != doc.Content {
			t.Fatal("article changed before review", err)
		}
		if strings.Contains(ops[0].Input.Content, "错别子") || strings.Contains(ops[0].Input.Content, "写作写作") || !strings.Contains(ops[0].Input.Content, "https://example.com/reference.png") {
			t.Fatal("polish missed obvious errors or removed the image")
		}
		w = writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]string{"hash": ops[0].Hash})
		if w.Code != 200 {
			t.Fatal("approve article revision", w.Code, w.Body.String())
		}
		updated, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
		if err != nil || updated.Content != ops[0].Input.Content || updated.Title != ops[0].Input.Title {
			t.Fatal("approved article does not match the reviewed revision", err)
		}
		focus := doc
		focus.Title, focus.Content, focus.Revision = updated.Title, updated.Content, updated.Revision
		advice := run(page.Session, focus, "这一轮只给改进建议，不要修改文章，也不要创建提案。")
		adviceOps, err := a.loadAgentOperations(ctx, user.ID, []string{advice.ID})
		if err != nil || len(adviceOps) != 0 || strings.TrimSpace(advice.Result) == "" {
			t.Fatal("advice-only article turn submitted changes or returned no answer", err)
		}
		untouched, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
		if err != nil || untouched.Revision != updated.Revision || untouched.Content != updated.Content {
			t.Fatal("advice-only article turn changed the document", err)
		}
	}
}
