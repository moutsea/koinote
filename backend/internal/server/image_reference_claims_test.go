package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestImageDeletionClaimsProtectDurableReferenceWriters(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "Reference retirement test")
	key := "u/" + user.AuthUserID + "/" + strings.Repeat("c", 32) + ".png"
	if _, err := a.recordImageObject(ctx, user.ID, key, 68, a.storageQuotaFor(user), imagePurposePersistent, nil); err != nil {
		t.Fatal(err)
	}
	// The fixtures are real persisted records; only their new references change.
	operationID, _ := randomUUID()
	publicationID, _ := randomUUID()
	setups := []struct {
		name, setup, write string
		args               []any
	}{
		{"history", `INSERT INTO document_versions(document_id,revision,title,theme,content,source) SELECT id,999,'History','minimal','','web' FROM documents WHERE doc_id=$1`, `UPDATE document_versions SET content=$2 WHERE document_id=(SELECT id FROM documents WHERE doc_id=$1) AND revision=999`, []any{doc.DocID, key}},
		{"task result", `UPDATE writing_agent_tasks SET result='' WHERE id=$1`, `UPDATE writing_agent_tasks SET result=$2 WHERE id=$1`, []any{task.ID, key}},
		{"document read", `INSERT INTO agent_document_reads(task_id,doc_id,snapshot) VALUES($1,'fixture','{}')`, `UPDATE agent_document_reads SET snapshot=jsonb_build_object('document',jsonb_build_object('coverImageSource',$2::text)) WHERE task_id=$1 AND doc_id='fixture'`, []any{task.ID, key}},
		{"operation", `INSERT INTO agent_operations(id,task_id,user_id,request_key,input_hash,input) VALUES($1,$2,$3,'claim-fixture','fixture','{}')`, `UPDATE agent_operations SET input=jsonb_build_object('content',$2::text) WHERE id=$1`, []any{operationID, key}},
		{"publication", `INSERT INTO agent_publications(id,task_id,user_id,doc_id,revision,channel,target_id,target_label,input_hash,snapshot,credits) VALUES($1,$2,$3,$4,1,'wechat','fixture','Fixture','fixture','{}',1)`, `UPDATE agent_publications SET snapshot=jsonb_build_object('cover',$2::text) WHERE id=$1`, []any{publicationID, key}},
	}
	for _, item := range setups {
		var args []any
		switch item.name {
		case "operation":
			args = []any{operationID, task.ID, user.ID}
		case "publication":
			args = []any{publicationID, task.ID, user.ID, doc.DocID}
		default:
			args = item.args[:1]
		}
		if _, err := a.db.Exec(ctx, item.setup, args...); err != nil {
			t.Fatalf("setup %s: %v", item.name, err)
		}
	}
	if err := a.enqueueImageDeletions(ctx, user.ID, []string{key}); err != nil {
		t.Fatal(err)
	}
	var candidate pendingImageDeletion
	if err := a.db.QueryRow(ctx, `SELECT id,object_key,user_id,attempts,upload_aborted_at FROM pending_image_deletions WHERE object_key=$1`, key).Scan(&candidate.id, &candidate.key, &candidate.userID, &candidate.attempts, &candidate.abortedAt); err != nil {
		t.Fatal(err)
	}
	claimed, err := a.claimImageDeletions(ctx, []pendingImageDeletion{candidate})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %v %v", claimed, err)
	}
	for _, item := range setups {
		t.Run(item.name, func(t *testing.T) {
			_, err := a.db.Exec(ctx, item.write, item.args...)
			if !isImageReferenceUnavailable(err) {
				t.Fatalf("retired image accepted: %v", err)
			}
			w := httptest.NewRecorder()
			agentError(w, err)
			if w.Code != 409 {
				t.Fatalf("agent error %d", w.Code)
			}
			if strings.Contains(mapMCPDocumentError(err).Error(), "internal server") {
				t.Fatal("MCP lost actionable error")
			}
		})
	}
	for _, input := range []map[string]any{
		{"title": "New body", "content": "![image](/images/" + key + ")"},
		{"title": "New cover", "coverImageSource": "/images/" + key},
	} {
		w := writingTestRequest(t, a, user, "POST", "/api/documents", input)
		var body struct {
			Code string `json:"code"`
		}
		json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != 409 || body.Code != "image_unavailable" {
			t.Fatalf("create reference: %d %s", w.Code, w.Body.String())
		}
	}
	w := writingTestRequest(t, a, user, "PUT", "/api/documents/"+doc.DocID, map[string]any{"title": doc.Title, "theme": doc.Theme, "content": doc.Content, "expectedRevision": doc.Revision, "coverImageSource": "/images/" + key})
	if w.Code != 409 {
		t.Fatalf("cover update: %d %s", w.Code, w.Body.String())
	}
}
