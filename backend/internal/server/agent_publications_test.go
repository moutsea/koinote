package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

func publicationTestTarget(t *testing.T, a *App, user model.User, channel string) agentPublishingTarget {
	t.Helper()
	ctx := context.Background()
	switch channel {
	case "wechat":
		a.cfg.WechatCredentialEncryptionKey = "publication-wechat-key"
		id, _ := randomUUID()
		cipher, err := a.encryptWechatCredential(user.ID, "wechat-secret")
		if err != nil {
			t.Fatal(err)
		}
		label := "Writing account"
		if _, err = a.createWechatOfficialAccount(ctx, user.ID, id, wechatOfficialAccountInput{Label: &label, AppID: "wx" + strings.ReplaceAll(id, "-", ""), AppSecret: "wechat-secret"}, cipher); err != nil {
			t.Fatal(err)
		}
	case "x":
		a.cfg.XOAuth2ClientID, a.cfg.XOAuth2ClientSecret = "client-id", "client-secret"
		var profile xOAuth2ProfileResponse
		profile.Data.ID, profile.Data.Username = "123456789", "writing_test"
		if err := a.storeXOAuth2Credential(ctx, user.ID, xOAuth2TokenResponse{AccessToken: "x-token", RefreshToken: "refresh", ExpiresIn: 3600, Scope: xOAuth2Scopes}, profile); err != nil {
			t.Fatal(err)
		}
	case "custom":
		a.cfg.CustomMediaCredentialEncryptionKey = "publication-custom-key"
		w := writingTestRequest(t, a, user, "POST", "/api/media/custom-platforms", customMediaPlatformInput{Name: "Writing channel", EndpointURL: "https://publisher.example.com/articles", AuthToken: "custom-token", Enabled: true})
		if w.Code != 201 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	targets, err := a.publishingTargets(ctx, user.ID)
	if err != nil || len(targets) != 1 {
		t.Fatal("targets", targets, err)
	}
	return targets[0]
}

func publicationTestPrepare(t *testing.T, a *App, task writingTask, doc model.Document, target agentPublishingTarget) agentPublication {
	t.Helper()
	_, result, err := a.agentPreparePublication(context.WithValue(context.Background(), writingMCPContext{}, task), nil, agentPreparePublicationInput{Path: agentDocumentPath(doc.DocID), Channel: target.Channel, TargetID: target.TargetID})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(result["publication"])
	var p agentPublication
	if json.Unmarshal(raw, &p) != nil || p.ID == "" || p.Status != "pending" {
		t.Fatal("invalid preview", string(raw))
	}
	return p
}

func publicationTestAction(t *testing.T, a *App, user model.User, p agentPublication, action string) agentPublication {
	t.Helper()
	w := writingTestRequest(t, a, user, "POST", "/api/agent/publications/"+p.ID+"/"+action, map[string]string{"hash": p.Hash})
	var result struct{ Publication agentPublication }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	return result.Publication
}

func TestAgentPublicationConfirmationBillingAndReceipts(t *testing.T) {
	for _, channel := range []string{"wechat", "x", "custom"} {
		t.Run(channel, func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			ctx := context.Background()
			if channel == "wechat" {
				coverKey := "u/" + user.AuthUserID + "/" + strings.Repeat("b", 32) + ".jpg"
				mode, ratio, source := "article", "16:9", "/images/"+coverKey
				var err error
				doc, err = a.updateDocument(ctx, updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content, Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb, CoverMode: &mode, CoverRatio: &ratio, CoverImageSource: &source})
				if err != nil {
					t.Fatal(err)
				}
				coverData := testWechatCoverJPEG(t)
				a.wechatImageHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					if r.URL.Path != "/"+coverKey {
						return nil, errors.New("unexpected cover image path")
					}
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"image/jpeg"}}, Body: io.NopCloser(bytes.NewReader(coverData))}, nil
				})}
			}
			target := publicationTestTarget(t, a, user, channel)
			task := agentTestTask(t, a, user, agentTestSession(t, a, user, "full"), doc, "发送这篇文章", http.Header{agentPublishingHeader: {"1"}})
			before, _ := a.loadCreditBalance(ctx, user.ID)
			var sends atomic.Int32
			a.mediaHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				sends.Add(1)
				var payload struct {
					Article map[string]string
					Source  struct{ Revision int64 }
				}
				if json.NewDecoder(r.Body).Decode(&payload) != nil || payload.Article["title"] != doc.Title || payload.Article["markdown"] != doc.Content || payload.Source.Revision != doc.Revision || r.Header.Get("Authorization") != "Bearer custom-token" || r.URL.String() != "https://publisher.example.com/articles" {
					t.Error("custom destination or saved article changed")
				}
				return jsonResponse(`{"url":"https://publisher.example.com/articles/1"}`), nil
			})}
			a.xOAuth2HTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == xOAuth2ArticleDraftPath {
					return jsonResponse(`{"data":{"id":"1146654567674912769"}}`), nil
				}
				if r.URL.Path == "/2/articles/1146654567674912769/publish" {
					sends.Add(1)
					return jsonResponse(`{"data":{"post_id":"1346889436626259968"}}`), nil
				}
				return nil, errors.New("unexpected X API path")
			})}
			a.wechatAPIHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				switch r.URL.Path {
				case "/cgi-bin/stable_token":
					return jsonResponse(`{"access_token":"wechat-token","expires_in":7200}`), nil
				case "/cgi-bin/material/add_material":
					reader, err := r.MultipartReader()
					if err != nil {
						return nil, err
					}
					part, err := reader.NextPart()
					if err != nil {
						return nil, err
					}
					defer part.Close()
					configuration, _, err := image.DecodeConfig(part)
					if err != nil || configuration.Width != 940 || configuration.Height != 529 {
						t.Errorf("WeChat upload lost saved 16:9 cover ratio: %dx%d, %v", configuration.Width, configuration.Height, err)
					}
					return jsonResponse(`{"media_id":"wechat-thumb"}`), nil
				case "/cgi-bin/draft/add":
					sends.Add(1)
					return jsonResponse(`{"media_id":"wechat-draft"}`), nil
				}
				return nil, errors.New("unexpected WeChat API path")
			})}
			p := publicationTestPrepare(t, a, task, doc, target)
			if repeated := publicationTestPrepare(t, a, task, doc, target); repeated.ID != p.ID {
				t.Fatal("preparation was not idempotent")
			}
			after, _ := a.loadCreditBalance(ctx, user.ID)
			if sends.Load() != 0 || before.Balance != after.Balance || before.Reserved != after.Reserved {
				t.Fatal("preview sent or charged publication credits")
			}
			path := "/api/agent/publications/" + p.ID
			if w := writingTestRequest(t, a, user, "POST", path+"/confirm", map[string]string{"hash": p.Hash}); w.Code != 409 {
				t.Fatal("unfinished task allowed sending", w.Code)
			}
			if err := a.finishWritingTask(ctx, task, "completed", "", nil, "请确认发布卡片"); err != nil {
				t.Fatal(err)
			}
			before, _ = a.loadCreditBalance(ctx, user.ID)
			for range 2 {
				if sent := publicationTestAction(t, a, user, p, "confirm"); sent.Status != "sent" || (channel == "wechat" && sent.ResultID != "wechat-draft") {
					t.Fatal("missing durable receipt", sent)
				}
			}
			after, _ = a.loadCreditBalance(ctx, user.ID)
			if sends.Load() != 1 || before.Balance-after.Balance != target.Credits || after.Reserved != before.Reserved {
				t.Fatal("send charged incorrectly or repeated", sends.Load(), before, after)
			}
			// A new conversation asking for the same saved revision reuses the
			// receipt rather than publishing/charging a second time.
			next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送这篇文章", http.Header{agentPublishingHeader: {"1"}})
			duplicate := publicationTestPrepare(t, a, next, doc, target)
			if err := a.finishWritingTask(ctx, next, "completed", "", nil, "请确认"); err != nil {
				t.Fatal(err)
			}
			if publicationTestAction(t, a, user, duplicate, "confirm").Status != "sent" || sends.Load() != 1 {
				t.Fatal("cross-task duplicate send")
			}
			page := writingTestRequest(t, a, user, "GET", "/api/agent/sessions/"+task.SessionID, nil)
			if page.Code != 200 || !strings.Contains(page.Body.String(), `"status":"sent"`) || !strings.Contains(page.Body.String(), p.ID) {
				t.Fatal("receipt missing from history", page.Body.String())
			}
		})
	}
}

func TestAgentPublicationIsolationChangesAndCancellation(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	target := publicationTestTarget(t, a, user, "custom")
	legacy := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送")
	if agentPublishingEnabled(legacy) {
		t.Fatal("old client exposed publishing")
	}
	if _, _, err := a.agentPreparePublication(context.WithValue(ctx, writingMCPContext{}, legacy), nil, agentPreparePublicationInput{Path: agentDocumentPath(doc.DocID), Channel: target.Channel, TargetID: target.TargetID}); err == nil {
		t.Fatal("old client could prepare a publication")
	}
	s := koiArticleSession(t, a, user, doc)
	task := agentTestTask(t, a, user, s, doc, "发送", http.Header{agentPublishingHeader: {"1"}})
	other := insertAgentReviewTestUser(t, a.db)
	foreign, err := a.createDocument(ctx, createDocumentParams{User: other, Title: "Private", Content: "Private body"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = a.agentPreparePublication(context.WithValue(ctx, writingMCPContext{}, task), nil, agentPreparePublicationInput{Path: agentDocumentPath(foreign.DocID), Channel: target.Channel, TargetID: target.TargetID}); err == nil {
		t.Fatal("article sidebar sent another document")
	}
	p := publicationTestPrepare(t, a, task, doc, target)
	path := "/api/agent/publications/" + p.ID
	for _, action := range []string{"", "/confirm", "/reject"} {
		method := "POST"
		if action == "" {
			method = "GET"
		}
		if w := writingTestRequest(t, a, other, method, path+action, map[string]string{"hash": p.Hash}); w.Code == 200 {
			t.Fatal("cross-account publication access")
		}
	}
	if err = a.finishWritingTask(ctx, task, "completed", "", nil, "确认"); err != nil {
		t.Fatal(err)
	}
	for _, change := range []struct{ query, code string }{
		{`UPDATE agent_publications SET created_at=now()-interval '25 hours' WHERE id=$1`, "publication_expired"},
		{`UPDATE agent_publications SET created_at=now(),revision=revision+1 WHERE id=$1`, "publication_changed"},
		{`UPDATE agent_publications SET revision=revision-1,snapshot=jsonb_set(snapshot,'{targetStamp}','"changed"') WHERE id=$1`, "publication_changed"},
	} {
		if _, err = a.db.Exec(ctx, change.query, p.ID); err != nil {
			t.Fatal(err)
		}
		w := writingTestRequest(t, a, user, "POST", path+"/confirm", map[string]string{"hash": p.Hash})
		requireMediaStatus(t, w, 409, change.code)
	}
	if publicationTestAction(t, a, user, p, "reject").Status != "rejected" || publicationTestAction(t, a, user, p, "confirm").Status != "rejected" {
		t.Fatal("rejected preview sent")
	}
}

func TestAgentPublicationConcurrentSendAndAmbiguousResult(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	target := publicationTestTarget(t, a, user, "custom")
	task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送", http.Header{agentPublishingHeader: {"1"}})
	p := publicationTestPrepare(t, a, task, doc, target)
	if err := a.finishWritingTask(ctx, task, "completed", "", nil, "确认"); err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	a.mediaHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		close(started)
		<-release
		return nil, io.ErrUnexpectedEOF
	})}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- writingTestRequest(t, a, user, "POST", "/api/agent/publications/"+p.ID+"/confirm", map[string]string{"hash": p.Hash})
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("send did not start")
	}
	if publicationTestAction(t, a, user, p, "confirm").Status != "sending" {
		t.Fatal("duplicate confirmation lost sending state")
	}
	w := writingTestRequest(t, a, user, "DELETE", "/api/agent/sessions/"+task.SessionID, nil)
	requireMediaStatus(t, w, 409, "publication_sending")
	close(release)
	select {
	case w = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("send did not finish")
	}
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"uncertain"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if publicationTestAction(t, a, user, p, "confirm").Status != "uncertain" || calls.Load() != 1 {
		t.Fatal("ambiguous send was retried")
	}
	if w = writingTestRequest(t, a, user, "DELETE", "/api/agent/sessions/"+task.SessionID, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var count int
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM agent_publications WHERE task_id=$1`, task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("deleted conversation retained publication content", err)
	}
}

func TestAgentPublicationToolsAndImagePayload(t *testing.T) {
	a, user, doc := writingTestApp(t)
	task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送", http.Header{agentPublishingHeader: {"1"}})
	server := httptest.NewServer(a.Routes())
	defer server.Close()
	client, err := connectMCPClient(context.Background(), server.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	listed, err := client.ListTools(context.Background(), &mcp.ListToolsParams{})
	if err != nil {
		t.Fatal(err)
	}
	tools := map[string]bool{}
	for _, tool := range listed.Tools {
		tools[tool.Name] = true
	}
	if !tools["list_publishing_targets"] || !tools["prepare_publication"] || tools["confirm_publication"] {
		t.Fatal("publishing tool boundary is incorrect", tools)
	}
	p := agentPublication{Channel: "x", Snapshot: agentPublicationSnapshot{Title: "Title", Markdown: "Before\n\n![图](/images/u/alice/abcdef12.png \"图标题\")\n\n`![example](not-an-image)`", Cover: "/images/u/alice/abcdef12.png"}}
	raw, err := a.publicationPayload(p)
	if err != nil {
		t.Fatal(err)
	}
	var payload xPublishInput
	if json.Unmarshal(raw, &payload) != nil || len(payload.Images) != 1 || payload.Images[0].Source != "https://img.koinote.app/u/alice/abcdef12.png" || payload.CoverImageSource != payload.Images[0].Source {
		t.Fatal("X payload lost its image or cover", string(raw))
	}
	p.Snapshot.Markdown = "![reference][image]\n\n[image]: https://example.com/image.png"
	if _, err = a.publicationPayload(p); err == nil {
		t.Fatal("unsupported image syntax was silently lost")
	}
}

func TestAgentPublicationWechatCoverRatioPayload(t *testing.T) {
	for _, test := range []struct{ ratio, want string }{
		{"", wechatCoverRatioWide}, // Older publication snapshots have no ratio.
		{"1:1", "1:1"},
		{"9.40:5.29", "9.40:5.29"},
	} {
		t.Run(test.ratio, func(t *testing.T) {
			a := &App{}
			data, err := a.publicationPayload(agentPublication{Channel: "wechat", Snapshot: agentPublicationSnapshot{Title: "Title", Markdown: "Body", CoverRatio: test.ratio}})
			if err != nil {
				t.Fatal(err)
			}
			var payload struct{ CoverRatio string }
			if err := json.Unmarshal(data, &payload); err != nil || payload.CoverRatio != test.want {
				t.Fatal("publication ratio", payload.CoverRatio, test.want, err)
			}
		})
	}
}

func TestAgentPublicationXFailureBilling(t *testing.T) {
	for _, insufficient := range []bool{false, true} {
		t.Run(map[bool]string{false: "draft created but publish failed", true: "insufficient credits"}[insufficient], func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			ctx := context.Background()
			target := publicationTestTarget(t, a, user, "x")
			task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送", http.Header{agentPublishingHeader: {"1"}})
			p := publicationTestPrepare(t, a, task, doc, target)
			if err := a.finishWritingTask(ctx, task, "completed", "", nil, "确认"); err != nil {
				t.Fatal(err)
			}
			if insufficient {
				if _, err := a.db.Exec(ctx, `UPDATE credit_accounts SET balance=1 WHERE user_id=$1`, user.ID); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := a.loadCreditBalance(ctx, user.ID)
			var calls int
			a.xOAuth2HTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Path == xOAuth2ArticleDraftPath {
					return jsonResponse(`{"data":{"id":"1146654567674912769"}}`), nil
				}
				return xErrorResponse(502), nil
			})}
			result := publicationTestAction(t, a, user, p, "confirm")
			after, _ := a.loadCreditBalance(ctx, user.ID)
			if insufficient {
				if result.Status != "failed" || result.ErrorCode != "insufficient_credits" || calls != 0 || before.Balance != after.Balance {
					t.Fatal("insufficient balance reached provider", result, calls, before, after)
				}
			} else if result.Status != "uncertain" || result.ErrorCode != "x_article_draft_only" || calls != 2 || before.Balance-after.Balance != 20 {
				t.Fatal("created X draft lost its cost or uncertain state", result, calls, before, after)
			}
			if after.Reserved != 0 {
				t.Fatal("publication leaked a credit reservation", after)
			}
			publicationTestAction(t, a, user, p, "confirm")
			if (!insufficient && calls != 2) || (insufficient && calls != 0) {
				t.Fatal("failed publication replayed")
			}
		})
	}
}

func TestAgentPublicationDestinationCheckedAtPublisher(t *testing.T) {
	for _, channel := range []string{"wechat", "x", "custom"} {
		t.Run(channel, func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			ctx := context.Background()
			target := publicationTestTarget(t, a, user, channel)
			task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送", http.Header{agentPublishingHeader: {"1"}})
			p := publicationTestPrepare(t, a, task, doc, target)
			p.Snapshot = agentPublicationSnapshot{Title: doc.Title, Markdown: doc.Content, TargetStamp: target.Stamp}
			payload, err := a.publicationPayload(p)
			if err != nil {
				t.Fatal(err)
			}
			query := map[string]string{
				"wechat": `UPDATE wechat_official_accounts SET app_id='wx_changed',updated_at=now() WHERE user_id=$1`,
				"x":      `UPDATE x_oauth2_accounts SET x_user_id='999999999' WHERE user_id=$1`,
				"custom": `UPDATE custom_media_platforms SET endpoint_url='https://other.example.com/publish',updated_at=now() WHERE user_id=$1`,
			}[channel]
			if _, err = a.db.Exec(ctx, query, user.ID); err != nil {
				t.Fatal(err)
			}
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				t.Error("changed destination reached provider")
				return nil, errors.New("unexpected send")
			})}
			a.wechatAPIHTTPClient, a.xOAuth2HTTPClient, a.mediaHTTPClient = client, client, client
			r := httptest.NewRequest("POST", "/publication", bytes.NewReader(payload)).WithContext(context.WithValue(ctx, agentPublicationContext{}, p))
			r.AddCookie(sessionCookieFor(t, a, user.AuthUserID, user.SessionVersion))
			r.SetPathValue("docId", doc.DocID)
			r.SetPathValue("platformId", target.TargetID)
			w := httptest.NewRecorder()
			switch channel {
			case "wechat":
				a.wechatDraftCreate(w, r)
			case "x":
				a.xPublish(w, r)
			case "custom":
				a.customMediaPlatformPublish(w, r)
			}
			requireMediaStatus(t, w, 409, "publication_changed")
		})
	}
}

func TestAgentPublicationWechatSetupFailureCanBeCorrected(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	target := publicationTestTarget(t, a, user, "wechat")
	allowed, drafts := false, 0
	a.wechatAPIHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/cgi-bin/stable_token":
			if !allowed {
				return jsonResponse(`{"errcode":40164,"errmsg":"invalid ip"}`), nil
			}
			return jsonResponse(`{"access_token":"wechat-token","expires_in":7200}`), nil
		case "/cgi-bin/material/add_material":
			return jsonResponse(`{"media_id":"wechat-thumb"}`), nil
		case "/cgi-bin/draft/add":
			drafts++
			return jsonResponse(`{"media_id":"wechat-draft"}`), nil
		}
		return nil, errors.New("unexpected WeChat path")
	})}
	before, _ := a.loadCreditBalance(ctx, user.ID)
	for attempt := range 2 {
		task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "发送", http.Header{agentPublishingHeader: {"1"}})
		p := publicationTestPrepare(t, a, task, doc, target)
		if err := a.finishWritingTask(ctx, task, "completed", "", nil, "确认"); err != nil {
			t.Fatal(err)
		}
		result := publicationTestAction(t, a, user, p, "confirm")
		after, _ := a.loadCreditBalance(ctx, user.ID)
		if attempt == 0 {
			if result.Status != "failed" || result.ErrorCode != "wechat_ip_not_allowed" || after.Balance != before.Balance || after.Reserved != 0 || drafts != 0 {
				t.Fatal("setup error was charged or made impossible to correct", result, after)
			}
			allowed = true
		} else if result.Status != "sent" || drafts != 1 || before.Balance-after.Balance != 20 || after.Reserved != 0 {
			t.Fatal("corrected account could not send exactly once", result, after, drafts)
		}
	}
}
