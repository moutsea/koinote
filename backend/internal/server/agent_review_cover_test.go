package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func TestAgentReviewHTTPPreservesDocumentCover(t *testing.T) {
	for _, mode := range []string{"default", "article", "ai"} {
		for _, action := range []string{"single-body", "single-title", "all"} {
			t.Run(mode+"/"+action, func(t *testing.T) {
				app, pool, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "review-cover-test"})
				ctx := context.Background()
				var suggestions []lockedAgentSuggestion
				wantTitle, wantContent := doc.Title, doc.Content
				if action != "single-body" {
					wantTitle = "A clearer title"
					suggestions = append(suggestions, lockedAgentSuggestion{Target: "title", Before: doc.Title, After: wantTitle})
				}
				if action != "single-title" {
					wantContent = "A concise paragraph."
					suggestions = append(suggestions, lockedAgentSuggestion{Target: "body", Before: doc.Content, After: wantContent})
				}
				reviewID, ids := insertReadyAgentReviewForTest(t, pool, user.ID, doc, suggestions)
				// The cover is set after the review was created. Applying the review
				// must preserve the current cover, not the review's original state.
				ratio, source, prompt := "3:2", "https://example.test/article-cover.png", ""
				if mode == "ai" {
					prompt = "A quiet lake in ink wash"
				}
				doc, err := app.updateDocument(ctx, updateDocumentParams{
					User: user, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme, Content: doc.Content,
					ExpectedRevision: doc.Revision, Source: documentSourceWeb,
					CoverMode: &mode, CoverRatio: &ratio, CoverImageSource: &source, CoverPrompt: &prompt,
				})
				if err != nil {
					t.Fatal(err)
				}
				routes := app.Routes()
				request := func(method, path string, body any) model.Document {
					t.Helper()
					encoded, err := json.Marshal(body)
					if err != nil {
						t.Fatal(err)
					}
					req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
					req.Header.Set("Content-Type", "application/json")
					req.AddCookie(sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion))
					response := httptest.NewRecorder()
					routes.ServeHTTP(response, req)
					if response.Code != http.StatusOK {
						t.Fatalf("%s %s: HTTP %d: %s", method, path, response.Code, response.Body.String())
					}
					var result struct {
						Document model.Document `json:"document"`
					}
					if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
						t.Fatal(err)
					}
					return result.Document
				}
				assertCover := func(document model.Document) {
					t.Helper()
					if document.CoverMode != mode || document.CoverRatio != ratio || document.CoverImageSource != source || document.CoverPrompt != prompt {
						t.Fatalf("cover lost: mode=%q ratio=%q source=%q prompt=%q; want %q %q %q %q",
							document.CoverMode, document.CoverRatio, document.CoverImageSource, document.CoverPrompt, mode, ratio, source, prompt)
					}
				}
				path := "/api/agent/reviews/" + reviewID + "/apply-all"
				if action != "all" {
					path = "/api/agent/reviews/" + reviewID + "/suggestions/" + ids[0] + "/apply"
				}
				input := map[string]any{"expectedRevision": doc.Revision}
				applied := request(http.MethodPost, path, input)
				assertCover(applied)
				if applied.Title != wantTitle || applied.Content != wantContent || applied.Revision != doc.Revision+1 {
					t.Fatalf("review was not applied: %+v", applied)
				}
				assertCover(request(http.MethodPost, path, input)) // Lost-response retry.

				// A normal editor save sends the cover values from the response back
				// to the server. They must remain intact after reopening the document.
				saved := request(http.MethodPut, "/api/documents/"+doc.DocID, map[string]any{
					"title": applied.Title, "theme": applied.Theme, "content": applied.Content + "\n\nAn additional edit.",
					"expectedRevision": applied.Revision, "coverMode": applied.CoverMode, "coverRatio": applied.CoverRatio,
					"coverImageSource": applied.CoverImageSource, "coverPrompt": applied.CoverPrompt,
				})
				assertCover(saved)
				assertCover(request(http.MethodGet, "/api/documents/"+doc.DocID, nil))

				// Retrying an already-applied suggestion must return the latest cover
				// even if the user has replaced it since the first application.
				source = "https://example.test/replacement-cover.png"
				if _, err := app.updateDocument(ctx, updateDocumentParams{
					User: user, DocID: saved.DocID, Title: saved.Title, Theme: saved.Theme, Content: saved.Content,
					ExpectedRevision: saved.Revision, Source: documentSourceWeb, CoverImageSource: &source,
				}); err != nil {
					t.Fatal(err)
				}
				assertCover(request(http.MethodPost, path, input))
			})
		}
	}
}
