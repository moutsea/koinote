package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"koinote/backend/internal/model"
)

func legacyPublicationForTest(t *testing.T, a *App, user model.User, doc model.Document, target agentPublishingTarget, status string) (writingTask, agentPublication) {
	t.Helper()
	ctx := context.Background()
	task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送这篇文章", http.Header{agentPublishingHeader: {"1"}})
	preview := publicationTestPrepare(t, a, task, doc, target)
	p, err := scanAgentPublication(a.db.QueryRow(ctx, `SELECT `+agentPublicationColumns+` FROM agent_publications p WHERE p.id=$1`, preview.ID))
	if err != nil {
		t.Fatal(err)
	}
	// Keep the previous release's exact JSON schema and field order independent
	// of new snapshot fields, so this exercises persisted cross-release receipts.
	snapshot := struct {
		Title       string `json:"title"`
		Markdown    string `json:"markdown"`
		Cover       string `json:"cover"`
		TargetStamp string `json:"targetStamp"`
		GeoText     string `json:"geoText,omitempty"`
	}{p.Snapshot.Title, p.Snapshot.Markdown, p.Snapshot.Cover, p.Snapshot.TargetStamp, p.Snapshot.GeoText}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	p.Hash = publicationDigest([]any{p.DocID, p.Revision, p.Channel, p.TargetID, snapshot})
	if _, err = a.db.Exec(ctx, `UPDATE agent_publications SET input_hash=$2,snapshot=$3,status=$4,result_id='legacy-draft' WHERE id=$1`, p.ID, p.Hash, raw, status); err != nil {
		t.Fatal(err)
	}
	p.Status, p.Snapshot.CoverRatio = status, ""
	if status != "pending" {
		if err = a.finishWritingTask(ctx, task, "completed", "", nil, "已处理发送请求"); err != nil {
			t.Fatal(err)
		}
	}
	return task, p
}

func countWechatDraftsForTest(a *App, calls *int) {
	a.wechatAPIHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/cgi-bin/stable_token":
			return jsonResponse(`{"access_token":"test-token","expires_in":7200}`), nil
		case "/cgi-bin/material/add_material":
			return jsonResponse(`{"media_id":"new-thumb"}`), nil
		case "/cgi-bin/draft/add":
			*calls++
			return jsonResponse(`{"media_id":"new-draft"}`), nil
		}
		return nil, errors.New("unexpected WeChat request")
	})}
}

func TestAgentPublicationLegacyReceiptCompatibility(t *testing.T) {
	for _, ratio := range []string{"1:1", "16:9", wechatCoverRatioWide} {
		for _, status := range []string{"sent", "sending", "uncertain"} {
			t.Run(ratio+"/"+status, func(t *testing.T) {
				a, user, doc := writingTestApp(t)
				ctx := context.Background()
				var err error
				doc, err = a.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content, Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb, CoverRatio: &ratio})
				if err != nil {
					t.Fatal(err)
				}
				target := publicationTestTarget(t, a, user, "wechat")
				_, legacy := legacyPublicationForTest(t, a, user, doc, target, status)
				next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送这篇文章", http.Header{agentPublishingHeader: {"1"}})
				current := publicationTestPrepare(t, a, next, doc, target)
				if err = a.finishWritingTask(ctx, next, "completed", "", nil, "请确认发布卡片"); err != nil {
					t.Fatal(err)
				}
				var sends int
				countWechatDraftsForTest(a, &sends)
				before, _ := a.loadCreditBalance(ctx, user.ID)
				for range 2 {
					response := writingTestRequest(t, a, user, "POST", "/api/agent/publications/"+current.ID+"/confirm", map[string]string{"hash": current.Hash})
					if status == "sent" {
						var result struct{ Publication agentPublication }
						if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Publication.Status != "sent" || result.Publication.ResultID != "legacy-draft" {
							t.Errorf("legacy sent receipt not reused: %d %s", response.Code, response.Body)
						}
					} else {
						requireMediaStatus(t, response, 409, "publication_uncertain")
					}
				}
				after, _ := a.loadCreditBalance(ctx, user.ID)
				if current.Hash != legacy.Hash || sends != 0 || before.Balance != after.Balance || before.Reserved != after.Reserved {
					t.Fatalf("legacy=%s ratio=%s hashChanged=%v: sends=%d, additional credits=%d", status, ratio, current.Hash != legacy.Hash, sends, before.Balance-after.Balance)
				}
			})
		}
	}
}

func TestAgentPublicationLegacyPendingPreviewRetry(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	ratio := "1:1"
	var err error
	doc, err = a.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content, Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb, CoverRatio: &ratio})
	if err != nil {
		t.Fatal(err)
	}
	target := publicationTestTarget(t, a, user, "wechat")
	task, legacy := legacyPublicationForTest(t, a, user, doc, target, "pending")
	repeated := publicationTestPrepare(t, a, task, doc, target)
	if repeated.ID != legacy.ID || repeated.Hash != legacy.Hash {
		t.Fatal("old pending preview was replaced")
	}
	var snapshot agentPublicationSnapshot
	if err = a.db.QueryRow(ctx, `SELECT snapshot FROM agent_publications WHERE id=$1`, repeated.ID).Scan(&snapshot); err != nil || snapshot.CoverRatio != "" {
		t.Fatal("old preview was silently changed", snapshot, err)
	}
}

func TestAgentPublicationNewReceiptDeduplicatesLegacyPendingPreview(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	ratio := "1:1"
	var err error
	doc, err = a.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content, Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb, CoverRatio: &ratio})
	if err != nil {
		t.Fatal(err)
	}
	target := publicationTestTarget(t, a, user, "wechat")
	oldTask, legacy := legacyPublicationForTest(t, a, user, doc, target, "pending")
	if err = a.finishWritingTask(ctx, oldTask, "completed", "", nil, "请确认"); err != nil {
		t.Fatal(err)
	}
	next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送这篇文章", http.Header{agentPublishingHeader: {"1"}})
	current := publicationTestPrepare(t, a, next, doc, target)
	if err = a.finishWritingTask(ctx, next, "completed", "", nil, "请确认"); err != nil {
		t.Fatal(err)
	}
	var sends int
	countWechatDraftsForTest(a, &sends)
	before, _ := a.loadCreditBalance(ctx, user.ID)
	publicationTestAction(t, a, user, current, "confirm")
	if result := publicationTestAction(t, a, user, legacy, "confirm"); result.ResultID != "new-draft" {
		t.Fatal("legacy card did not reuse new receipt", result)
	}
	after, _ := a.loadCreditBalance(ctx, user.ID)
	if sends != 1 || before.Balance-after.Balance != target.Credits || before.Reserved != after.Reserved {
		t.Fatal("cross-version confirmation repeated sending/charging", sends, before, after)
	}
}

func TestAgentPublicationLegacyReceiptAllowsChangedCoverRevision(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	target := publicationTestTarget(t, a, user, "wechat")
	_, legacy := legacyPublicationForTest(t, a, user, doc, target, "uncertain")
	ratio := "1:1"
	var err error
	doc, err = a.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content, Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb, CoverRatio: &ratio})
	if err != nil {
		t.Fatal(err)
	}
	next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送修改封面后的文章", http.Header{agentPublishingHeader: {"1"}})
	current := publicationTestPrepare(t, a, next, doc, target)
	if doc.Revision == legacy.Revision || current.Hash == legacy.Hash {
		t.Fatal("changed cover did not advance the publication identity")
	}
	if err = a.finishWritingTask(ctx, next, "completed", "", nil, "请确认"); err != nil {
		t.Fatal(err)
	}
	var sends int
	countWechatDraftsForTest(a, &sends)
	before, _ := a.loadCreditBalance(ctx, user.ID)
	if result := publicationTestAction(t, a, user, current, "confirm"); result.Status != "sent" || result.ResultID != "new-draft" {
		t.Fatal("new revision was blocked by a historical receipt", result)
	}
	after, _ := a.loadCreditBalance(ctx, user.ID)
	if sends != 1 || before.Balance-after.Balance != target.Credits || before.Reserved != after.Reserved {
		t.Fatal("new revision did not send/charge exactly once", sends, before, after)
	}
}
