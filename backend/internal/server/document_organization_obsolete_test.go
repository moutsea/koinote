package server

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"koinote/backend/internal/config"
)

func TestOrganizationRetargetObsoleteDestinations(t *testing.T) {
	folders := []organizationFolder{
		{"month", "2026年9月", ""}, {"week", "第 2 周", "month"}, {"notes", "Notes", "week"},
		{"manual", "Work", ""}, {"bucket", "2026年8月", "manual"},
	}
	obsolete := map[string]bool{"month": true, "week": true, "bucket": true}
	for _, tc := range []struct {
		name       string
		in         organizationChoice
		folderID   string
		newFolders []string
		ok         bool
	}{
		{"topic created inside a month", organizationChoice{FolderID: "month", NewFolders: []string{"AI行业动态"}}, "", []string{"AI行业动态"}, true},
		{"kept in a week", organizationChoice{FolderID: "week", NewFolders: []string{}}, "", []string{}, false},
		{"manual child of a week survives as a topic", organizationChoice{FolderID: "notes", NewFolders: []string{"Go"}}, "", []string{"Notes", "Go"}, true},
		{"bucket under a manual folder", organizationChoice{FolderID: "bucket", NewFolders: []string{"SQL"}}, "manual", []string{"SQL"}, true},
		{"unrelated destination", organizationChoice{FolderID: "manual", NewFolders: []string{}}, "manual", []string{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := retargetOrganizationChoice(tc.in, folders, obsolete)
			if ok != tc.ok || (ok && (got.FolderID != tc.folderID || !slices.Equal(got.NewFolders, tc.newFolders))) {
				t.Fatalf("got %+v ok=%v", got, ok)
			}
		})
	}
	items := []organizationItem{{DocID: "kept", FolderID: "week", Tags: []string{"Old"}}, {DocID: "moved", FolderID: "week"}}
	suggestions := retargetOrganizationSuggestions([]organizationSuggestion{
		{organizationChoice: organizationChoice{DocID: "kept", FolderID: "week", NewFolders: []string{}, Tags: []string{"New"}}, Reason: "fits"},
		{organizationChoice: organizationChoice{DocID: "moved", FolderID: "month", NewFolders: []string{"AI行业动态"}, Tags: []string{}}, Reason: "AI"},
	}, items, folders, obsolete)
	if !suggestions[0].NeedsReview || suggestions[0].FolderID != "week" || !slices.Equal(suggestions[0].Tags, []string{"Old"}) {
		t.Fatalf("keeping a bucket must require manual review: %+v", suggestions[0])
	}
	if suggestions[1].NeedsReview || suggestions[1].FolderID != "" || !slices.Equal(suggestions[1].NewFolders, []string{"AI行业动态"}) {
		t.Fatalf("topic must move out of the bucket: %+v", suggestions[1])
	}
}

func TestOrganizationActivityLabels(t *testing.T) {
	for _, name := range []string{"最近 7 天", "8–30 天", "一年以上", "Last 7 days", "Over one year", "91〜365 日", "Plus d’un an"} {
		if !organizationObsoleteFolderName("activity", name) {
			t.Errorf("missing activity label %q", name)
		}
	}
	if organizationObsoleteFolderName("activity", "2026年8月") || organizationObsoleteFolderName("smart", "最近 7 天") || organizationObsoleteFolderName("", "2026年8月") {
		t.Error("label must match its own strategy and provenance")
	}
}

// The reported case: weekly buckets keep previously organized documents and
// the model nests a new topic inside a month bucket.
func TestOrganizationDiscardsAutomaticBuckets(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-obsolete"})
	ctx := context.Background()
	august := organizationTestFolder(t, db, user.ID, "2026年8月", "", "smart")
	week := organizationTestFolder(t, db, user.ID, "第 3 周", august, "smart")
	september := organizationTestFolder(t, db, user.ID, "2026年9月", "", "smart")
	recent := organizationTestFolder(t, db, user.ID, "最近 7 天", "", "activity")
	manual := organizationTestFolder(t, db, user.ID, "Research", "", "")
	place := func(docID, folder string) {
		t.Helper()
		if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2),organized_at=now() WHERE doc_id=$1`, docID, folder); err != nil {
			t.Fatal(err)
		}
	}
	create := func(title string) string {
		t.Helper()
		created, err := a.createDocument(ctx, createDocumentParams{User: user, Title: title, Content: title + " content"})
		if err != nil {
			t.Fatal(err)
		}
		return created.DocID
	}
	place(doc.DocID, week)
	industry := create("AI industry")
	place(industry, september)
	activity := create("Recent")
	place(activity, recent)
	unpicked := create("Unpicked")
	place(unpicked, manual)

	// Legacy clients without a selection still reassess bucket documents.
	legacy, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil || len(legacy.Items) != 3 || legacy.Skipped != 1 {
		t.Fatalf("legacy scope: items=%d skipped=%d err=%v", len(legacy.Items), legacy.Skipped, err)
	}
	picked := []string{doc.DocID, industry, activity}
	data, prompts, err := a.prepareOrganizationScope(ctx, user.ID, false, nil, picked)
	if err != nil || len(data.Items) != 3 || data.Skipped != 0 || len(prompts) != 1 || len(data.TimeFolders) != 4 {
		t.Fatalf("picked scope: items=%d skipped=%d prompts=%d time=%d err=%v", len(data.Items), data.Skipped, len(prompts), len(data.TimeFolders), err)
	}
	var input struct {
		Documents []organizationDocument
		Folders   []struct{ FolderID string }
	}
	if err := json.Unmarshal([]byte(prompts[0].User), &input); err != nil {
		t.Fatal(err)
	}
	if len(input.Folders) != 1 || input.Folders[0].FolderID != manual {
		t.Fatalf("buckets offered as destinations: %+v", input.Folders)
	}
	for _, d := range input.Documents {
		if d.Content == "" || d.DocID == unpicked {
			t.Fatalf("picked documents need content; others are not candidates: %+v", d)
		}
	}
	if response := organizationTestRequest(t, a, user, "POST", "/api/document-organizations/estimate", `{"includeOrganized":true,"docIds":["`+industry+`"]}`); response.Code != 200 {
		t.Fatalf("estimate: %d %s", response.Code, response.Body)
	} else {
		var estimate struct{ Count, Skipped int }
		if err := json.Unmarshal(response.Body.Bytes(), &estimate); err != nil || estimate.Count != 1 || estimate.Skipped != 0 {
			t.Fatalf("estimate body: %s", response.Body)
		}
	}

	obsolete := organizationObsoleteFolderIDs(data.TimeFolders)
	suggestions := retargetOrganizationSuggestions([]organizationSuggestion{
		{organizationChoice: organizationChoice{DocID: doc.DocID, FolderID: manual, NewFolders: []string{}, Tags: []string{}}},
		{organizationChoice: organizationChoice{DocID: industry, FolderID: september, NewFolders: []string{"AI行业动态"}, Tags: []string{}}},
		{organizationChoice: organizationChoice{DocID: activity, FolderID: "", NewFolders: []string{"Notes"}, Tags: []string{}}},
	}, data.Items, data.Folders, obsolete)
	choices := []organizationChoice{}
	for i := range data.Items {
		for _, s := range suggestions {
			if s.DocID == data.Items[i].DocID {
				choice := s.organizationChoice
				data.Items[i].Suggested = &choice
				choices = append(choices, choice)
			}
		}
	}
	id := organizationTestReady(t, a, user.ID, data)
	if err := a.applyOrganization(ctx, user.ID, id, choices, nil, false); err != nil {
		t.Fatal(err)
	}
	var remaining []string
	if err := db.QueryRow(ctx, `SELECT COALESCE(array_agg(name ORDER BY name),'{}') FROM folders WHERE user_id=$1`, user.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(remaining, []string{"AI行业动态", "Notes", "Research"}) {
		t.Fatalf("automatic buckets must be gone and topics created at root: %v", remaining)
	}
	if err := a.applyOrganization(ctx, user.ID, id, nil, nil, true); err != nil {
		t.Fatal(err)
	}
	var kinds []string
	if err := db.QueryRow(ctx, `SELECT array_agg(organizer_kind ORDER BY folder_id) FROM folders WHERE folder_id=ANY($1::text[])`, []string{august, week, september, recent}).Scan(&kinds); err != nil || len(kinds) != 4 {
		t.Fatalf("undo must restore every bucket: %v %v", kinds, err)
	}
	var activityKind string
	if err := db.QueryRow(ctx, `SELECT organizer_kind FROM folders WHERE folder_id=$1`, recent).Scan(&activityKind); err != nil || activityKind != "activity" {
		t.Fatalf("undo must restore the bucket's own strategy: %q %v", activityKind, err)
	}
}
