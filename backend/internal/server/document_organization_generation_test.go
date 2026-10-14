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

func TestOrganizationResponseEnvelope(t *testing.T) {
	items := []organizationItem{{DocID: "doc"}}
	valid := `{"items":[{"docId":"doc","folderId":"","newFolders":[],"tags":["Go"],"reason":"Topic"}]}`
	for _, raw := range []string{
		valid,
		"```json\n" + valid + "\n```",
		"Let me classify these documents.\n" + valid + "\nDone.",
		"Here is the result:\n```json\n" + valid + "\n```",
		"Results for documents [1]:\n```json\n" + valid + "\n```",
		"Results for [documents](https://example.test):\n" + valid + "\nSee [1].",
		"分类 [文档 [1]]：\n" + valid + "\n参考 [文档](https://example.test)。",
	} {
		got, err := decodeOrganizationOutput([]byte(raw), items, nil)
		if err != nil || len(got) != 1 || got[0].NeedsReview || !slices.Equal(got[0].Tags, []string{"Go"}) {
			t.Fatalf("wrapped JSON was not recovered: %+v %v", got, err)
		}
	}
	for _, raw := range []string{
		"Let me think about this.", valid + `{}`, valid + `{`, `[` + valid + `]`,
		"Results:\n[\n" + valid + "\n]", "[\n" + valid, valid + "\n]",
		valid + "\n[]", "[1]\n" + valid, valid + "\nnull",
		valid[:len(valid)-1], `{"items":[]}`, strings.Replace(valid, `"docId":"doc"`, `"docId":"invented"`, 1),
		`{"items":null}`, `{"items":[]} then ` + valid,
		"Results [1]:\n```json\n" + valid + "\n```\nResults [2]:\n```json\n" + valid + "\n```",
	} {
		if _, err := decodeOrganizationOutput([]byte(raw), items, nil); err == nil {
			t.Fatalf("accepted ambiguous, partial or misidentified output: %s", raw)
		}
	}
}

// Exercise the production Anthropic streaming path as well as OpenAI, with
// enough documents to prove that both earlier and later batches are retained.
func TestOrganizationMalformedBatchRecovery(t *testing.T) {
	for _, protocol := range []string{"anthropic", "openai"} {
		for _, scenario := range []string{"wrapped", "retry", "fallback", "all-invalid", "missing-items", "byok-invalid", "empty", "truncated", "truncated-retry", "truncated-empty-retry", "transient-retry", "transient-then-format"} {
			t.Run(protocol+"/"+scenario, func(t *testing.T) {
				a, db, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-format"})
				ctx := context.Background()
				for i := 0; i < organizationBatchSize*2; i++ {
					if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: fmt.Sprintf("Article %d", i), Content: "Topic"}); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := db.Exec(ctx, `UPDATE documents SET tags=ARRAY['Original'] WHERE user_id=$1`, user.ID); err != nil {
					t.Fatal(err)
				}
				data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
				if err != nil || len(prompts) != 3 {
					t.Fatalf("prepare batches: %v", err)
				}
				mode, reservationID := "builtin", ""
				grantCreditsForTest(t, db, user.ID, 20, "organization-format")
				if scenario == "byok-invalid" {
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
				attempts := map[string]int{}
				requests := map[string]string{}
				var calls atomic.Int32
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					var body struct {
						Messages  []struct{ Content string }
						MaxTokens int `json:"max_tokens"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					inputJSON := body.Messages[len(body.Messages)-1].Content
					var input struct{ Documents []organizationDocument }
					if err := json.Unmarshal([]byte(inputJSON), &input); err != nil || len(input.Documents) == 0 {
						t.Errorf("input: %v", err)
						return
					}
					key := input.Documents[0].DocID
					attempts[key]++
					wantLimit := organizationOutputTokens
					if strings.HasPrefix(scenario, "truncated") && attempts[key] == 2 {
						wantLimit = organizationRetryOutputTokens
					}
					if body.MaxTokens != wantLimit {
						t.Errorf("output allowance: got %d want %d", body.MaxTokens, wantLimit)
					}
					if prior, found := requests[key]; found && prior != inputJSON {
						t.Error("retry changed the prompt or included previous model output")
					}
					requests[key] = inputJSON
					middle := key == data.Items[organizationBatchSize].DocID
					if middle && strings.HasPrefix(scenario, "transient-") && attempts[key] == 1 {
						http.Error(w, "temporarily unavailable", http.StatusServiceUnavailable)
						return
					}
					out := organizationOutput{Items: []organizationSuggestion{}}
					for _, doc := range input.Documents {
						out.Items = append(out.Items, organizationSuggestion{organizationChoice: organizationChoice{doc.DocID, "", []string{}, []string{"Topic"}}, Reason: "Topic"})
					}
					raw, _ := json.Marshal(out)
					content := string(raw)
					stopReason, finishReason := "end_turn", "stop"
					switch {
					case scenario == "wrapped":
						content = "Let me classify these documents [1].\n```json\n" + content + "\n```\nSee [documents](https://example.test)."
					case scenario == "empty":
						content = ""
					case scenario == "missing-items":
						content = `{"items":[]}`
					case scenario == "truncated" || (strings.HasPrefix(scenario, "truncated-") && middle && attempts[key] == 1):
						stopReason, finishReason = "max_tokens", "length"
						if scenario == "truncated-empty-retry" {
							content = ""
						}
					case scenario == "all-invalid" || scenario == "byok-invalid" || (middle && (scenario == "fallback" || scenario == "transient-then-format" || attempts[key] == 1)):
						content = "Let me think about the folders first."
					}
					if protocol == "anthropic" {
						w.Header().Set("Content-Type", "text/event-stream")
						for _, event := range []any{
							map[string]any{"type": "message_start", "message": map[string]any{"usage": map[string]int{"input_tokens": 1600}}},
							map[string]any{"type": "content_block_delta", "delta": map[string]string{"type": "text_delta", "text": content}},
							map[string]any{"type": "message_delta", "delta": map[string]string{"stop_reason": stopReason}, "usage": map[string]int{"output_tokens": 400}},
						} {
							encoded, _ := json.Marshal(event)
							fmt.Fprintf(w, "data: %s\n\n", encoded)
						}
					} else {
						json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}, "finish_reason": finishReason}}, "usage": map[string]int{"prompt_tokens": 1600, "completion_tokens": 400, "total_tokens": 2000}})
					}
				}))
				defer provider.Close()
				a.agentLLMHTTPClient = provider.Client()
				a.runOrganization(user.ID, id, data, prompts, agentLLMProvider{Mode: mode, Protocol: protocol, BaseURL: provider.URL, APIKey: "test", Model: "test"}, reservationID)
				allInvalid := scenario == "all-invalid" || scenario == "missing-items" || scenario == "byok-invalid" || scenario == "empty" || scenario == "truncated"
				wantCalls, wantCharged, wantUnbilled := 3, int64(3), 0
				if scenario == "retry" || scenario == "transient-retry" || strings.HasPrefix(scenario, "truncated-") {
					wantCalls = 4
				} else if scenario == "fallback" || scenario == "transient-then-format" {
					wantCalls, wantCharged, wantUnbilled = 4, 2, 1
				} else if allInvalid {
					wantCalls, wantCharged, wantUnbilled = 6, 0, 3
				}
				view, err := a.loadOrganization(ctx, user.ID, id)
				if err != nil || view.Status != "ready" || view.Data.Completed != len(data.Items) || view.CreditsCharged != wantCharged || view.Data.UnbilledBatches != wantUnbilled || int(calls.Load()) != wantCalls {
					t.Fatalf("batch outcome: calls=%d status=%s completed=%d charged=%d unbilled=%d err=%v", calls.Load(), view.Status, view.Data.Completed, view.CreditsCharged, view.Data.UnbilledBatches, err)
				}
				for i, item := range view.Data.Items {
					wantFallback := allInvalid || ((scenario == "fallback" || scenario == "transient-then-format") && i >= organizationBatchSize && i < organizationBatchSize*2)
					if item.FailureStatus != 0 {
						t.Fatalf("stale HTTP failure status: %+v", item)
					}
					if item.Suggested == nil || item.NeedsReview != wantFallback || (wantFallback && (!slices.Equal(item.Suggested.Tags, item.Tags) || item.Suggested.FolderID != item.FolderID || len(item.Suggested.NewFolders) != 0)) {
						t.Fatalf("fallback changed original classification: %+v", item)
					}
				}
				balance, err := a.loadCreditBalance(ctx, user.ID)
				if err != nil || balance.Reserved != 0 || balance.Balance != 20-wantCharged {
					t.Fatalf("billing: %+v %v", balance, err)
				}
				if wantCharged > 0 {
					var tokens, billable int
					knownTokens := wantCalls * 2000
					if strings.HasPrefix(scenario, "truncated-") || strings.HasPrefix(scenario, "transient-") {
						knownTokens -= 2000
					} // Provider error omits usage.
					if err := db.QueryRow(ctx, `SELECT (metadata->>'providerTokens')::int,(metadata->>'billableTokens')::int FROM credit_transactions WHERE user_id=$1 AND kind='agent_usage'`, user.ID).Scan(&tokens, &billable); err != nil || tokens != knownTokens || billable != int(wantCharged)*2000 {
						t.Fatalf("failed attempt was billed: %d/%d %v", tokens, billable, err)
					}
				}
				var modified int
				if err := db.QueryRow(ctx, `SELECT count(*) FROM documents WHERE user_id=$1 AND (tags<>ARRAY['Original'] OR organized_at IS NOT NULL OR folder_id IS NOT NULL)`, user.ID).Scan(&modified); err != nil || modified != 0 {
					t.Fatalf("generation changed documents: %d %v", modified, err)
				}
			})
		}
	}
}

func TestOrganizationPurgePreventsFormatRetry(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		for _, scenario := range []string{"format", "transient", "empty", "format-then-transient", "format-then-empty"} {
			t.Run(protocol+"/"+scenario, func(t *testing.T) {
				a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-format-purge"})
				ctx := context.Background()
				data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
				if err != nil {
					t.Fatal(err)
				}
				grantCreditsForTest(t, db, user.ID, 20, "organization-format-purge")
				reservation, err := a.reserveStandaloneCredits(ctx, user.ID, 10, organizationRunLimit)
				if err != nil {
					t.Fatal(err)
				}
				id := organizationTestReady(t, a, user.ID, data)
				if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running',reservation_id=$2 WHERE organization_id=$1`, id, reservation.ReservationID); err != nil {
					t.Fatal(err)
				}
				var calls atomic.Int32
				deleteAt := int32(1)
				if strings.HasPrefix(scenario, "format-then-") {
					deleteAt = 2
				}
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					call := calls.Add(1)
					if call == deleteAt {
						if _, err := a.trashDocument(ctx, user, doc.DocID, 0); err != nil {
							t.Error(err)
						}
						if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, doc.DocID, doc.Title, true, false); err != nil {
							t.Error(err)
						}
					}
					content := "Let me think."
					if call >= deleteAt {
						if strings.HasSuffix(scenario, "transient") {
							w.WriteHeader(http.StatusServiceUnavailable)
							_, _ = w.Write([]byte(`{"error":{"message":"temporarily unavailable"}}`))
							return
						}
						if strings.HasSuffix(scenario, "empty") {
							content = ""
						}
					}
					if protocol == "anthropic" {
						// Empty replies share the same two-attempt organization budget.
						json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]string{"type": "text", "text": content}}, "stop_reason": "end_turn", "usage": map[string]int{"input_tokens": 1600, "output_tokens": 400}})
					} else {
						json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}, "usage": map[string]int{"prompt_tokens": 1600, "completion_tokens": 400, "total_tokens": 2000}})
					}
				}))
				defer provider.Close()
				a.agentLLMHTTPClient = provider.Client()
				a.runOrganization(user.ID, id, data, prompts, agentLLMProvider{Mode: "builtin", Protocol: protocol, BaseURL: provider.URL, APIKey: "test", Model: "test"}, reservation.ReservationID)
				view, err := a.loadOrganization(ctx, user.ID, id)
				if err != nil || view.Status != "failed" || view.ErrorCode != "organization_document_deleted" || len(view.Data.Items) != 0 || calls.Load() != deleteAt {
					t.Fatalf("deleted data retried or restored: calls=%d want=%d view=%+v err=%v", calls.Load(), deleteAt, view, err)
				}
				balance, err := a.loadCreditBalance(ctx, user.ID)
				if err != nil || balance.Reserved != 0 || balance.Balance != 20 {
					t.Fatalf("cancelled run was billed: %+v %v", balance, err)
				}
			})
		}
	}
}
