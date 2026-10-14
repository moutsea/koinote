package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func organizationTestRequest(t *testing.T, a *App, user model.User, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(sessionCookieFor(t, a, user.AuthUserID, user.SessionVersion))
	w := httptest.NewRecorder()
	a.Routes().ServeHTTP(w, r)
	return w
}
func organizationTestReady(t *testing.T, a *App, userID int, data organizationData) string {
	t.Helper()
	id, e := randomUUID()
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(data)
	_, e = a.db.Exec(context.Background(), `INSERT INTO document_organizations(organization_id,user_id,status,data) VALUES($1,$2,'ready',$3::jsonb)`, id, userID, string(raw))
	if e != nil {
		t.Fatal(e)
	}
	return id
}
func TestOrganizationValidation(t *testing.T) {
	folders := []organizationFolder{{"folder", "Research", ""}}
	items := []organizationItem{{DocID: "a"}, {DocID: "b"}}
	valid := `{"items":[{"docId":"b","folderId":"folder","newFolders":[],"tags":["#Go","go"],"reason":"Topic"},{"docId":"a","folderId":"","newFolders":["Notes"],"tags":[],"reason":"Topic"}]}`
	got, e := decodeOrganizationOutput([]byte(valid), items, folders)
	if e != nil || len(got[0].Tags) != 1 {
		t.Fatalf("decode: %+v %v", got, e)
	}
	for _, bad := range []string{valid + `{}`, strings.Replace(valid, `"docId":"b"`, `"docId":"a"`, 1)} {
		if _, e := decodeOrganizationOutput([]byte(bad), items, folders); e == nil {
			t.Fatal("accepted invalid output", bad)
		}
	}
	for _, bad := range []string{strings.Replace(valid, `"folderId":"folder"`, `"folderId":"someone-else"`, 1), strings.Replace(valid, `["Notes"]`, `["../secret"]`, 1), strings.Replace(valid, `["Notes"]`, `[""]`, 1)} {
		got, err := decodeOrganizationOutput([]byte(bad), items, folders)
		if err != nil || len(got) != 2 || got[0].NeedsReview == got[1].NeedsReview {
			t.Fatalf("invalid item was not isolated: %+v %v", got, err)
		}
	}
}
func TestOrganizationApplyUndoAndSkip(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-test"})
	ctx := context.Background()
	if _, e := db.Exec(ctx, `UPDATE documents SET cover_image_source='https://example.com/cover.png',tags=ARRAY['Original'] WHERE doc_id=$1`, doc.DocID); e != nil {
		t.Fatal(e)
	}
	data, _, e := a.prepareOrganization(ctx, user.ID, false, nil)
	if e != nil {
		t.Fatal(e)
	}
	choice := organizationChoice{doc.DocID, "", []string{"Research", "Go"}, []string{"Go", "Databases"}}
	data.Items[0].Suggested = &choice
	id := organizationTestReady(t, a, user.ID, data)
	if e := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, false); e != nil {
		t.Fatal(e)
	}
	if e := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, false); e != nil {
		t.Fatal("idempotent apply", e)
	}
	changed := choice
	changed.Tags = []string{"Changed retry"}
	if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{changed}, false); err != errOrganizationConflict {
		t.Fatalf("changed retry accepted: %v", err)
	}
	var content, cover, folder string
	var revision int64
	var tags []string
	var organized *time.Time
	e = db.QueryRow(ctx, `SELECT content,cover_image_source,revision,tags,organized_at,f.name FROM documents d JOIN folders f ON f.id=d.folder_id WHERE doc_id=$1`, doc.DocID).Scan(&content, &cover, &revision, &tags, &organized, &folder)
	if e != nil || content != doc.Content || revision != doc.Revision || cover != "https://example.com/cover.png" || folder != "Go" || len(tags) != 2 || organized == nil {
		t.Fatalf("unexpected mutation content=%s cover=%s rev=%d tags=%v folder=%s err=%v", content, cover, revision, tags, folder, e)
	}
	if _, e = db.Exec(ctx, `UPDATE documents SET content='Edited after organization',revision=revision+1 WHERE doc_id=$1`, doc.DocID); e != nil {
		t.Fatal(e)
	}
	skipped, _, e := a.prepareOrganization(ctx, user.ID, false, nil)
	if e != nil || len(skipped.Items) != 0 || skipped.Skipped != 1 {
		t.Fatalf("skip: %+v %v", skipped, e)
	}
	included, _, e := a.prepareOrganization(ctx, user.ID, true, nil)
	if e != nil || len(included.Items) != 1 {
		t.Fatalf("include: %+v %v", included, e)
	}
	if e := a.applyOrganization(ctx, user.ID, id, nil, true); e != nil {
		t.Fatal(e)
	}
	if e := a.applyOrganization(ctx, user.ID, id, nil, true); e != nil {
		t.Fatal("idempotent undo", e)
	}
	var folderID *int
	e = db.QueryRow(ctx, `SELECT content,tags,organized_at,folder_id FROM documents WHERE doc_id=$1`, doc.DocID).Scan(&content, &tags, &organized, &folderID)
	if e != nil || content != "Edited after organization" || folderID != nil || organized != nil || len(tags) != 1 || tags[0] != "Original" {
		t.Fatalf("undo content=%s tags=%v organized=%v folder=%v err=%v", content, tags, organized, folderID, e)
	}
	var count int
	db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE user_id=$1`, user.ID).Scan(&count)
	if count != 0 {
		t.Fatal("unused created folders remain", count)
	}
}
func TestOrganizationConflictAtomicAndOwnership(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-test"})
	ctx := context.Background()
	second, e := a.createDocument(ctx, createDocumentParams{User: user, Title: "Second", Content: "Second body"})
	if e != nil {
		t.Fatal(e)
	}
	data, _, e := a.prepareOrganization(ctx, user.ID, false, nil)
	if e != nil {
		t.Fatal(e)
	}
	choices := []organizationChoice{}
	for i, item := range data.Items {
		choice := organizationChoice{item.DocID, "", []string{"Should not exist"}, []string{"Tag"}}
		data.Items[i].Suggested = &choice
		choices = append(choices, choice)
	}
	id := organizationTestReady(t, a, user.ID, data)
	if _, e = db.Exec(ctx, `UPDATE documents SET revision=revision+1 WHERE doc_id=$1`, second.DocID); e != nil {
		t.Fatal(e)
	}
	if e = a.applyOrganization(ctx, user.ID, id, choices, false); e != errOrganizationConflict {
		t.Fatalf("expected conflict: %v", e)
	}
	var count int
	db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE user_id=$1`, user.ID).Scan(&count)
	if count != 0 {
		t.Fatal("partial folder creation", count)
	}
	db.QueryRow(ctx, `SELECT count(*) FROM documents WHERE user_id=$1 AND organized_at IS NOT NULL`, user.ID).Scan(&count)
	if count != 0 {
		t.Fatal("partial metadata write", count)
	}
	if _, e = a.loadOrganization(ctx, user.ID+99999, id); e == nil {
		t.Fatal("cross account preview leak")
	}
	data, _, e = a.prepareOrganization(ctx, user.ID, false, nil)
	if e != nil {
		t.Fatal(e)
	}
	for i := range data.Items {
		data.Items[i].Suggested = &choices[i]
	}
	id = organizationTestReady(t, a, user.ID, data)
	// Excluding an item does not mark it organized.
	choice := organizationChoice{doc.DocID, "", []string{}, []string{"Confirmed"}}
	if e = a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, false); e != nil {
		t.Fatal(e)
	}
	pending, _, e := a.prepareOrganization(ctx, user.ID, false, nil)
	if e != nil || len(pending.Items) != 1 || pending.Items[0].DocID != second.DocID {
		t.Fatalf("excluded: %+v %v", pending, e)
	}
	db.Exec(ctx, `UPDATE documents SET tags=ARRAY['Later manual change'] WHERE doc_id=$1`, doc.DocID)
	if e = a.applyOrganization(ctx, user.ID, id, nil, true); e != nil {
		t.Fatalf("undo could not skip later change: %v", e)
	}
	view, e := a.loadOrganization(ctx, user.ID, id)
	if e != nil || view.Status != "undone" || !slices.ContainsFunc(view.Data.Items, func(item organizationItem) bool { return item.DocID == doc.DocID && item.UndoSkipped }) {
		t.Fatalf("missing skipped outcome: %+v %v", view, e)
	}
	var tags []string
	if e = db.QueryRow(ctx, `SELECT tags FROM documents WHERE doc_id=$1`, doc.DocID).Scan(&tags); e != nil || !slices.Equal(tags, []string{"Later manual change"}) {
		t.Fatalf("undo overwrote later tags: %v %v", tags, e)
	}
}
func TestOrganizationGenerationHTTP(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			Messages []struct{ Role, Content string }
		}
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Error(e)
			w.WriteHeader(500)
			return
		}
		var input struct {
			Documents            []organizationDocument
			ProposedDestinations []json.RawMessage
		}
		if e := json.Unmarshal([]byte(body.Messages[len(body.Messages)-1].Content), &input); e != nil {
			t.Error(e)
			w.WriteHeader(500)
			return
		}
		if calls.Load() == 2 && len(input.ProposedDestinations) != 1 {
			t.Error("later batch did not reuse earlier proposed destination")
		}
		out := organizationOutput{Items: []organizationSuggestion{}}
		for _, doc := range input.Documents {
			out.Items = append(out.Items, organizationSuggestion{organizationChoice: organizationChoice{doc.DocID, "", []string{"Writing"}, []string{"Editing"}}, Reason: "Writing topic"})
		}
		raw, _ := json.Marshal(out)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": string(raw)}}}, "usage": map[string]any{"prompt_tokens": 800, "completion_tokens": 200, "total_tokens": 1000}})
	}))
	defer provider.Close()
	a, db, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-http", AgentLLMProtocol: "openai", AgentLLMBaseURL: provider.URL, AgentLLMAPIKey: "key", AgentLLMModel: "test"})
	a.agentLLMHTTPClient = provider.Client()
	grantCreditsForTest(t, db, user.ID, 100, "organization")
	for i := 0; i < organizationBatchSize; i++ {
		if _, err := a.createDocument(context.Background(), createDocumentParams{User: user, Title: fmt.Sprintf("Extra %d", i), Content: "Writing sample"}); err != nil {
			t.Fatal(err)
		}
	}

	id, _ := randomUUID()
	payload := `{"requestId":"` + id + `","includeOrganized":false,"providerMode":"builtin","maxReservedCredits":100}`
	response := organizationTestRequest(t, a, user, "POST", "/api/document-organizations", payload)
	if response.Code != 202 {
		t.Fatalf("create: %d %s", response.Code, response.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	var view organizationView
	for time.Now().Before(deadline) {
		view, _ = a.loadOrganization(context.Background(), user.ID, id)
		if view.Status != "running" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if view.Status != "ready" || len(view.Data.Items) != organizationBatchSize+1 || view.Data.Completed != organizationBatchSize+1 || view.Data.Items[organizationBatchSize].Suggested == nil || view.CreditsCharged != 1 {
		t.Fatalf("generated: %+v", view)
	}
	retry := organizationTestRequest(t, a, user, "POST", "/api/document-organizations", payload)
	if retry.Code != 200 {
		t.Fatalf("retry: %d %s", retry.Code, retry.Body.String())
	}
	if calls.Load() != 2 {
		t.Fatal("retry recharged or batch missing", calls.Load())
	}
	balance, e := a.loadCreditBalance(context.Background(), user.ID)
	if e != nil || balance.Balance != 99 || balance.Reserved != 0 {
		t.Fatalf("billing: %+v %v", balance, e)
	}
}

func TestOrganizationEstimatePermissionAndExpiry(t *testing.T) {
	a, db, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-gates"})
	response := organizationTestRequest(t, a, user, "POST", "/api/document-organizations/estimate", `{"includeOrganized":false}`)
	if response.Code != 200 {
		t.Fatalf("estimate %d %s", response.Code, response.Body.String())
	}
	id, _ := randomUUID()
	response = organizationTestRequest(t, a, user, "POST", "/api/document-organizations", `{"requestId":"`+id+`","providerMode":"builtin","maxReservedCredits":0}`)
	if response.Code != 409 || !strings.Contains(response.Body.String(), "organization_estimate_changed") {
		t.Fatalf("budget %d %s", response.Code, response.Body.String())
	}
	var count int
	if err := db.QueryRow(context.Background(), `SELECT count(*) FROM document_organizations WHERE user_id=$1`, user.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("budget created job: %d %v", count, err)
	}
	data, _, err := a.prepareOrganization(context.Background(), user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	id = organizationTestReady(t, a, user.ID, data)
	if _, err = db.Exec(context.Background(), `UPDATE document_organizations SET status='running',created_at=now()-interval '20 minutes' WHERE organization_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	response = organizationTestRequest(t, a, user, "GET", "/api/document-organizations/"+id, "")
	if response.Code != 200 || !strings.Contains(response.Body.String(), "organization_timeout") {
		t.Fatalf("expiry: %d %s", response.Code, response.Body.String())
	}
	if _, err = db.Exec(context.Background(), `UPDATE users SET membership_tier='free' WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	response = organizationTestRequest(t, a, user, "POST", "/api/document-organizations/estimate", `{}`)
	if response.Code != 403 {
		t.Fatalf("free generation %d", response.Code)
	}
	for _, path := range []string{"/api/document-organizations", "/api/document-organizations/estimate", "/api/document-organizations/" + id + "/apply", "/api/document-organizations/" + id + "/undo"} {
		if !desktopRequestAllowed(httptest.NewRequest("POST", path, nil)) {
			t.Fatal("desktop denied", path)
		}
	}
	if desktopRequestAllowed(httptest.NewRequest("DELETE", "/api/document-organizations/"+id, nil)) {
		t.Fatal("unexpected desktop method allowed")
	}
	if desktopRequestAllowed(httptest.NewRequest("GET", "/api/document-organizations/"+id+"/apply", nil)) {
		t.Fatal("GET mutation allowed")
	}
}
func TestOrganizationFailureReleasesCredits(t *testing.T) {
	a, db, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-failure"})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": `{"items":[]}`}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}})
	}))
	defer provider.Close()
	a.agentLLMHTTPClient = provider.Client()
	grantCreditsForTest(t, db, user.ID, 20, "organization-failure")
	data, prompts, err := a.prepareOrganization(context.Background(), user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := organizationTestReady(t, a, user.ID, data)
	if _, err = db.Exec(context.Background(), `UPDATE document_organizations SET status='running' WHERE organization_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	reservation, err := a.reserveStandaloneCredits(context.Background(), user.ID, 10, organizationRunLimit)
	if err != nil {
		t.Fatal(err)
	}
	a.runOrganization(user.ID, id, data, prompts, agentLLMProvider{Mode: "builtin", Protocol: "openai", BaseURL: provider.URL, APIKey: "test", Model: "test"}, reservation.ReservationID)
	view, err := a.loadOrganization(context.Background(), user.ID, id)
	if err != nil || view.Status != "failed" {
		t.Fatalf("failed output %+v %v", view, err)
	}
	balance, err := a.loadCreditBalance(context.Background(), user.ID)
	if err != nil || balance.Reserved != 0 || balance.Balance != 20 {
		t.Fatalf("failed billing %+v %v", balance, err)
	}
}

func TestOrganizationMoveRoundTripConflict(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-roundtrip"})
	ctx := context.Background()
	folderID, _ := randomUUID()
	if _, err := db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'Existing')`, folderID, user.ID); err != nil {
		t.Fatal(err)
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	choice := organizationChoice{doc.DocID, "", []string{}, []string{"Topic"}}
	data.Items[0].Suggested = &choice
	id := organizationTestReady(t, a, user.ID, data)
	if _, err = db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2) WHERE doc_id=$1`, doc.DocID, folderID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `UPDATE documents SET folder_id=NULL WHERE doc_id=$1`, doc.DocID); err != nil {
		t.Fatal(err)
	}
	if err = a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, false); err != errOrganizationConflict {
		t.Fatalf("round-trip move was not detected: %v", err)
	}
}
