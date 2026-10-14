package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func organizationWriteTestResponse(t *testing.T, w http.ResponseWriter, r *http.Request, valid bool) {
	t.Helper()
	var body struct{ Messages []struct{ Content string } }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Messages) == 0 {
		t.Errorf("request: %v", err)
		return
	}
	var input struct{ Documents []organizationDocument }
	if err := json.Unmarshal([]byte(body.Messages[len(body.Messages)-1].Content), &input); err != nil {
		t.Error(err)
		return
	}
	content := "Let me think first."
	if valid {
		out := organizationOutput{Items: []organizationSuggestion{}}
		for _, doc := range input.Documents {
			out.Items = append(out.Items, organizationSuggestion{organizationChoice: organizationChoice{doc.DocID, "", []string{}, []string{"Topic"}}, Reason: "Topic"})
		}
		raw, _ := json.Marshal(out)
		content = string(raw)
	}
	json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 1600, "completion_tokens": 400, "total_tokens": 2000}})
}

func TestOrganizationFreeBatchLimit(t *testing.T) {
	for _, scenario := range []string{"all-invalid", "valid-first", "transient-then-format", "format-then-transient"} {
		t.Run(scenario, func(t *testing.T) {
			a, db, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-limit"})
			ctx := context.Background()
			for i := 0; i < organizationBatchSize*4; i++ {
				if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: fmt.Sprintf("Article %d", i), Content: "Topic"}); err != nil {
					t.Fatal(err)
				}
			}
			data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			grantCreditsForTest(t, db, user.ID, 100, "organization-limit")
			reservation, err := a.reserveStandaloneCredits(ctx, user.ID, 50, organizationRunLimit)
			if err != nil {
				t.Fatal(err)
			}
			id := organizationTestReady(t, a, user.ID, data)
			if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running',reservation_id=$2 WHERE organization_id=$1`, id, reservation.ReservationID); err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := calls.Add(1)
				if (scenario == "transient-then-format" && n%2 == 1) || (scenario == "format-then-transient" && n%2 == 0) {
					http.Error(w, "temporary failure", http.StatusServiceUnavailable)
					return
				}
				organizationWriteTestResponse(t, w, r, scenario == "valid-first" && n == 1)
			}))
			defer provider.Close()
			a.agentLLMHTTPClient = provider.Client()
			a.runOrganization(user.ID, id, data, prompts, agentLLMProvider{Mode: "builtin", Protocol: "openai", BaseURL: provider.URL, Model: "test"}, reservation.ReservationID)
			wantCalls, wantCompleted, wantCharged := int32(6), organizationBatchSize*3, int64(0)
			if scenario == "valid-first" {
				wantCalls++
				wantCompleted += organizationBatchSize
				wantCharged = 1
			}
			view, err := a.loadOrganization(ctx, user.ID, id)
			if err != nil || view.Status != "ready" || view.Data.StopReason != "failure_limit" || view.Data.Completed != wantCompleted || calls.Load() != wantCalls || view.CreditsCharged != wantCharged || view.Data.UnbilledBatches != 3 {
				t.Fatalf("unbounded calls or lost partial result: calls=%d view=%+v err=%v", calls.Load(), view, err)
			}
			for i, item := range view.Data.Items {
				wantFallback := scenario != "valid-first" || i >= organizationBatchSize
				if item.Suggested == nil || item.NeedsReview != wantFallback || item.NotAnalyzed != (i >= wantCompleted) || (wantFallback && (!slices.Equal(item.Suggested.Tags, item.Tags) || item.Suggested.FolderID != item.FolderID)) {
					t.Fatalf("invalid fallback: %+v", item)
				}
			}
			balance, err := a.loadCreditBalance(ctx, user.ID)
			if err != nil || balance.Reserved != 0 || balance.Balance != 100-wantCharged {
				t.Fatalf("billing: %+v %v", balance, err)
			}
			if wantCharged > 0 {
				choices := []organizationChoice{}
				for _, item := range view.Data.Items {
					if !item.NeedsReview {
						choices = append(choices, *item.Suggested)
					}
				}
				if err := a.applyOrganization(ctx, user.ID, id, choices, nil, false); err != nil {
					t.Fatal(err)
				}
				remaining, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
				if err != nil || len(remaining.Items) != len(data.Items)-organizationBatchSize {
					t.Fatalf("remaining items: %d %v", len(remaining.Items), err)
				}
			}
		})
	}
}

func TestOrganizationTimeoutPreservesPartialPreview(t *testing.T) {
	for _, scenario := range []string{"deadline", "already-expired", "purge-at-deadline", "provider-timeout"} {
		t.Run(scenario, func(t *testing.T) {
			a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-timeout"})
			ctx := context.Background()
			for i := 0; i < organizationBatchSize; i++ {
				if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: fmt.Sprintf("Article %d", i), Content: "Topic"}); err != nil {
					t.Fatal(err)
				}
			}
			data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			grantCreditsForTest(t, db, user.ID, 100, "organization-timeout")
			reservation, err := a.reserveStandaloneCredits(ctx, user.ID, 50, organizationRunLimit)
			if err != nil {
				t.Fatal(err)
			}
			id := organizationTestReady(t, a, user.ID, data)
			if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running',reservation_id=$2 WHERE organization_id=$1`, id, reservation.ReservationID); err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					organizationWriteTestResponse(t, w, r, true)
					return
				}
				io.Copy(io.Discard, r.Body)
				if scenario == "purge-at-deadline" {
					if _, err := a.trashDocument(ctx, user, doc.DocID, 0); err != nil {
						t.Error(err)
					}
					if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, doc.DocID, doc.Title, true, false); err != nil {
						t.Error(err)
					}
				}
				<-r.Context().Done()
			}))
			defer provider.Close()
			a.agentLLMHTTPClient = provider.Client()
			limit := 3 * time.Second
			if scenario == "already-expired" {
				limit = -time.Second
			}
			if scenario == "provider-timeout" {
				a.agentLLMHTTPClient.Timeout = 200 * time.Millisecond
			}
			runCtx, cancel := context.WithTimeout(ctx, limit)
			defer cancel()
			a.runOrganizationWithContext(runCtx, user.ID, id, data, prompts, agentLLMProvider{Mode: "builtin", Protocol: "openai", BaseURL: provider.URL, Model: "test"}, reservation.ReservationID)
			view, err := a.loadOrganization(ctx, user.ID, id)
			if err != nil {
				t.Fatal(err)
			}
			wantCharged, wantCompleted, wantCalls := int64(1), organizationBatchSize, int32(2)
			if scenario == "already-expired" {
				wantCharged, wantCompleted, wantCalls = 0, 0, 0
			}
			if scenario == "purge-at-deadline" {
				wantCharged = 0
				if view.Status != "failed" || view.ErrorCode != "organization_document_deleted" || len(view.Data.Items) != len(data.Items)-1 || slices.ContainsFunc(view.Data.Items, func(item organizationItem) bool { return item.DocID == doc.DocID }) || view.Data.StopReason != "" {
					t.Fatalf("deleted data restored: %+v", view)
				}
			} else {
				if view.Status != "ready" || view.Data.StopReason != "timeout" || view.Data.Completed != wantCompleted || view.CreditsCharged != wantCharged {
					t.Fatalf("lost partial preview: %+v", view)
				}
				for i, item := range view.Data.Items {
					if item.Suggested == nil || item.NeedsReview != (i >= wantCompleted) || item.NotAnalyzed != (i >= wantCompleted) {
						t.Fatalf("lost partial item: %+v", item)
					}
				}
			}
			if calls.Load() != wantCalls {
				t.Fatalf("unexpected retries: %d", calls.Load())
			}
			balance, err := a.loadCreditBalance(ctx, user.ID)
			if err != nil || balance.Reserved != 0 || balance.Balance != 100-wantCharged {
				t.Fatalf("billing: %+v %v", balance, err)
			}
		})
	}
}

func TestOrganizationEstimateIncludesLargerRetry(t *testing.T) {
	a, _, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-estimate-retry"})
	data, prompts, err := a.prepareOrganization(context.Background(), user.ID, false, nil)
	if err != nil || len(prompts) != 1 {
		t.Fatalf("prepare: %v", err)
	}
	prompt := prompts[0]
	if prompt.MaxOutputTokens != organizationOutputTokens {
		t.Fatal("first attempt output changed")
	}
	prompt.MaxOutputTokens = organizationRetryOutputTokens
	if data.ReservedCredits < creditsForTokens(agentReviewPromptTokenUpperBound(prompt)) {
		t.Fatal("quote does not cover accepted retry")
	}
}

func TestOrganizationFailureLimits(t *testing.T) {
	for _, test := range []struct {
		name                      string
		valid                     []bool
		wantStop                  string
		wantUnbilled, wantCharged int
		formatFailures            bool
	}{
		{"short-run", []bool{false, true, false, true, false, true}, "", 3, 3, false},
		{"scattered-rejections", []bool{false, true, true, false, true, true, false, true}, "", 3, 5, false},
		{"alternating-success-first", []bool{true, false, true, false, true, false, true, false}, "failure_ratio", 3, 3, false},
		{"alternating-failure-first", []bool{false, true, false, true, false, true, false, true}, "failure_ratio", 3, 3, false},
		{"alternating-format-errors", []bool{true, false, true, false, true, false, true, false}, "failure_ratio", 3, 3, true},
		{"success-resets-streak", []bool{false, false, true, false, false, false, true}, "failure_limit", 5, 1, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			a, db, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-failure-streak"})
			ctx := context.Background()
			for i := 1; i < len(test.valid)*organizationBatchSize; i++ {
				if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: fmt.Sprintf("Article %d", i), Content: "Topic"}); err != nil {
					t.Fatal(err)
				}
			}
			data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
			if err != nil || len(prompts) != len(test.valid) {
				t.Fatalf("prepare: %v", err)
			}
			grantCreditsForTest(t, db, user.ID, 100, "organization-failure-streak")
			reservation, err := a.reserveStandaloneCredits(ctx, user.ID, 50, organizationRunLimit)
			if err != nil {
				t.Fatal(err)
			}
			id := organizationTestReady(t, a, user.ID, data)
			if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running',reservation_id=$2 WHERE organization_id=$1`, id, reservation.ReservationID); err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := int(calls.Add(1))
				batchIndex := 0
				for batchIndex < len(test.valid) {
					attempts := 1
					if test.formatFailures && !test.valid[batchIndex] {
						attempts = 2
					}
					if n <= attempts {
						break
					}
					n -= attempts
					batchIndex++
				}
				if batchIndex >= len(test.valid) {
					t.Error("unexpected retry of rejected content")
					http.Error(w, "unexpected retry", 400)
					return
				}
				if !test.valid[batchIndex] {
					if test.formatFailures {
						organizationWriteTestResponse(t, w, r, false)
					} else {
						http.Error(w, "content rejected", 400)
					}
					return
				}
				organizationWriteTestResponse(t, w, r, true)
			}))
			defer provider.Close()
			a.agentLLMHTTPClient = provider.Client()
			a.runOrganization(user.ID, id, data, prompts, agentLLMProvider{Mode: "builtin", Protocol: "openai", BaseURL: provider.URL, Model: "test"}, reservation.ReservationID)
			wantCompleted := (test.wantUnbilled + test.wantCharged) * organizationBatchSize
			wantCalls := test.wantUnbilled + test.wantCharged
			if test.formatFailures {
				wantCalls += test.wantUnbilled
			}
			view, err := a.loadOrganization(ctx, user.ID, id)
			if err != nil || view.Status != "ready" || view.Data.StopReason != test.wantStop || view.Data.Completed != wantCompleted || int(calls.Load()) != wantCalls || view.CreditsCharged != int64(test.wantCharged) || view.Data.UnbilledBatches != test.wantUnbilled {
				t.Fatalf("invalid streak: calls=%d view=%+v err=%v", calls.Load(), view, err)
			}
			for i, item := range view.Data.Items {
				wantStatus := 0
				if i < view.Data.Completed && !test.valid[i/organizationBatchSize] && !test.formatFailures {
					wantStatus = 400
				}
				if item.FailureStatus != wantStatus {
					t.Fatalf("unexpected failure status: %+v", item)
				}
				if item.Suggested == nil || item.NotAnalyzed != (i >= view.Data.Completed) || item.NeedsReview != (i >= view.Data.Completed || !test.valid[i/organizationBatchSize]) {
					t.Fatalf("invalid retained suggestion: %+v", item)
				}
			}
			balance, err := a.loadCreditBalance(ctx, user.ID)
			if err != nil || balance.Reserved != 0 || balance.Balance != 100-int64(test.wantCharged) {
				t.Fatalf("billing: %+v %v", balance, err)
			}
		})
	}
}
