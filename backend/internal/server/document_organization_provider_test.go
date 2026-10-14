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

	"koinote/backend/internal/config"
)

func TestOrganizationProviderRejectionIsIsolated(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		for _, test := range []struct {
			name                        string
			status                      int
			truncatedFirst, byok, fatal bool
			rejectAll                   bool
		}{
			{name: "content-400", status: 400},
			{name: "request-limit-413", status: 413},
			{name: "content-422", status: 422},
			{name: "rate-limit-429", status: 429},
			{name: "unavailable-503", status: 503},
			{name: "all-config-400", status: 400, rejectAll: true},
			{name: "all-rate-limit-429", status: 429, rejectAll: true},
			{name: "retry-limit-400", status: 400, truncatedFirst: true},
			{name: "byok-retry-limit-400", status: 400, truncatedFirst: true, byok: true},
			{name: "credentials-401", status: 401, fatal: true},
			{name: "permissions-403", status: 403, fatal: true},
			{name: "endpoint-404", status: 404, fatal: true},
		} {
			t.Run(protocol+"/"+test.name, func(t *testing.T) {
				a, db, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-rejected"})
				ctx := context.Background()
				for i := 0; i < organizationBatchSize*2; i++ {
					if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: fmt.Sprintf("Article %d", i), Content: "Topic"}); err != nil {
						t.Fatal(err)
					}
				}
				data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
				if err != nil || len(prompts) != 3 {
					t.Fatalf("prepare: %v", err)
				}
				grantCreditsForTest(t, db, user.ID, 20, "organization-rejected")
				mode, reservationID := "builtin", ""
				if test.byok {
					mode = "byok"
				} else {
					reservation, err := a.reserveStandaloneCredits(ctx, user.ID, 10, organizationRunLimit)
					if err != nil {
						t.Fatal(err)
					}
					reservationID = reservation.ReservationID
				}
				data.ProviderMode = mode
				id := organizationTestReady(t, a, user.ID, data)
				if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running',reservation_id=$2 WHERE organization_id=$1`, id, reservationID); err != nil {
					t.Fatal(err)
				}
				var calls atomic.Int32
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					n := calls.Add(1)
					var body struct {
						Messages  []struct{ Content string }
						MaxTokens int `json:"max_tokens"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					var input struct{ Documents []organizationDocument }
					if len(body.Messages) == 0 {
						t.Error("missing messages")
						return
					}
					if err := json.Unmarshal([]byte(body.Messages[len(body.Messages)-1].Content), &input); err != nil || len(input.Documents) == 0 {
						t.Errorf("input: %v", err)
						return
					}
					middle := test.rejectAll || input.Documents[0].DocID == data.Items[organizationBatchSize].DocID
					truncated := middle && test.truncatedFirst && n == 2
					if middle && !truncated {
						wantLimit := organizationOutputTokens
						if test.truncatedFirst {
							wantLimit = organizationRetryOutputTokens
						}
						if body.MaxTokens != wantLimit {
							t.Errorf("rejected output limit: %d want %d", body.MaxTokens, wantLimit)
						}
						http.Error(w, "SENSITIVE_PROVIDER_BODY provider rejected this request", test.status)
						return
					}
					out := organizationOutput{Items: []organizationSuggestion{}}
					for _, doc := range input.Documents {
						out.Items = append(out.Items, organizationSuggestion{organizationChoice: organizationChoice{doc.DocID, "", []string{}, []string{"Topic"}}, Reason: "Topic"})
					}
					raw, _ := json.Marshal(out)
					stopReason, finishReason := "end_turn", "stop"
					if truncated {
						stopReason, finishReason = "max_tokens", "length"
					}
					if protocol == "anthropic" {
						w.Header().Set("Content-Type", "text/event-stream")
						for _, event := range []any{
							map[string]any{"type": "message_start", "message": map[string]any{"usage": map[string]int{"input_tokens": 1600}}},
							map[string]any{"type": "content_block_delta", "delta": map[string]string{"type": "text_delta", "text": string(raw)}},
							map[string]any{"type": "message_delta", "delta": map[string]string{"stop_reason": stopReason}, "usage": map[string]int{"output_tokens": 400}},
						} {
							encoded, _ := json.Marshal(event)
							fmt.Fprintf(w, "data: %s\n\n", encoded)
						}
					} else {
						json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(raw)}, "finish_reason": finishReason}}, "usage": map[string]int{"prompt_tokens": 1600, "completion_tokens": 400, "total_tokens": 2000}})
					}
				}))
				defer provider.Close()
				a.agentLLMHTTPClient = provider.Client()
				a.runOrganization(user.ID, id, data, prompts, agentLLMProvider{Mode: mode, Protocol: protocol, BaseURL: provider.URL, Model: "test"}, reservationID)
				wantCalls, wantCharged := int32(3), int64(2)
				if test.truncatedFirst || test.status == 429 || test.status >= 500 {
					wantCalls++
				}
				wantUnbilled := 1
				if test.rejectAll {
					wantCalls, wantCharged, wantUnbilled = 3, 0, 3
					if test.status == 429 || test.status >= 500 {
						wantCalls *= 2
					}
				}
				if test.byok {
					wantCharged = 0
				}
				if test.fatal {
					wantCalls, wantCharged = 2, 0
				}
				view, err := a.loadOrganization(ctx, user.ID, id)
				if err != nil || calls.Load() != wantCalls || view.CreditsCharged != wantCharged {
					t.Fatalf("calls=%d charged=%d err=%v", calls.Load(), view.CreditsCharged, err)
				}
				if test.fatal {
					if view.Status != "failed" || view.ErrorCode != "organization_generation_failed" {
						t.Fatalf("account failure ignored: %+v", view)
					}
				} else {
					if view.Status != "ready" || view.Data.Completed != len(data.Items) || view.Data.StopReason != "" || view.Data.UnbilledBatches != wantUnbilled {
						t.Fatalf("lost partial results: %+v", view)
					}
					for i, item := range view.Data.Items {
						fallback := test.rejectAll || (i >= organizationBatchSize && i < organizationBatchSize*2)
						wantStatus := 0
						if fallback {
							wantStatus = test.status
						}
						if item.FailureStatus != wantStatus {
							t.Fatalf("provider status lost or leaked to valid result: %+v", item)
						}
						if item.Suggested == nil || item.NeedsReview != fallback || item.NotAnalyzed || (fallback && (!slices.Equal(item.Suggested.Tags, item.Tags) || item.Suggested.FolderID != item.FolderID || len(item.Suggested.NewFolders) != 0)) {
							t.Fatalf("unexpected suggestion: %+v", item)
						}
					}
				}
				saved, _ := json.Marshal(view)
				if strings.Contains(string(saved), "SENSITIVE_PROVIDER_BODY") {
					t.Fatal("raw provider error leaked into the preview")
				}
				balance, err := a.loadCreditBalance(ctx, user.ID)
				if err != nil || balance.Reserved != 0 || balance.Balance != 20-wantCharged {
					t.Fatalf("billing: %+v %v", balance, err)
				}
			})
		}
	}
}
