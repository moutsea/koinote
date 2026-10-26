package server

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"koinote/backend/internal/config"
)

func TestManagedLLMRequiresExplicitCreditConfirmation(t *testing.T) {
	for _, storedMode := range []string{"byok", "builtin"} {
		t.Run(storedMode, func(t *testing.T) {
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				writeOpenAIAgentReviewResponse(t, w, r, "Ordinary title", "The first paragraph is too long.", 2800, 1200)
			}))
			defer provider.Close()
			app, pool, user, doc := newAgentReviewCreateTest(t, config.Config{
				SessionSecret: "managed-confirmation", AgentLLMProtocol: "openai", AgentLLMBaseURL: provider.URL,
				AgentLLMAPIKey: "platform-key", AgentLLMModel: "platform-model",
			})
			app.agentLLMHTTPClient = provider.Client()
			ctx := context.Background()
			if _, err := pool.Exec(ctx, `UPDATE users SET agent_provider_mode=$2 WHERE id=$1`, user.ID, storedMode); err != nil {
				t.Fatal(err)
			}
			grantCreditsForTest(t, pool, user.ID, 100, "managed-confirmation")
			// Both an old BYOK preference and the migrated builtin row must reject the
			// actual old client's payload, before creating jobs or credit reservations.
			for _, body := range []string{`{}`, `{"tasks":["title"]}`} {
				response := requestAgentReviewCreate(t, app, user, doc.DocID, body)
				if response.Code != 409 || !strings.Contains(response.Body.String(), "agent_provider_confirmation_required") {
					t.Fatalf("legacy review: %d %s", response.Code, response.Body.String())
				}
			}
			cookie := sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion)
			response := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/documents/"+doc.DocID+"/wechat-geo-summary/generate", `{"title":"Old client","content":"Synthetic article"}`)
			if response.Code != 409 || !strings.Contains(response.Body.String(), "agent_provider_confirmation_required") {
				t.Fatalf("legacy GEO: %d %s", response.Code, response.Body.String())
			}
			tokenHash := sha256.Sum256([]byte(user.AuthUserID))
			var tokenID int64
			if err := pool.QueryRow(ctx, `INSERT INTO mcp_tokens(token_id,user_id,name,token_hash,token_hint,scope) VALUES($1,$2,'confirmation',$3,'test','write') RETURNING id`, user.AuthUserID, user.ID, tokenHash[:]).Scan(&tokenID); err != nil {
				t.Fatal(err)
			}
			mcpCtx := context.WithValue(ctx, mcpPrincipalContextKey{}, mcpPrincipal{User: user, Scope: "write", TokenID: tokenID})
			for _, mode := range []string{"", "byok"} {
				_, _, err := app.mcpGenerateWechatGeoSummary(mcpCtx, nil, mcpWechatGeoSummaryGenerateInput{DocID: doc.DocID, ProviderMode: mode})
				if err == nil || !strings.Contains(err.Error(), "platform credits") {
					t.Fatalf("legacy MCP GEO: %v", err)
				}
			}
			var jobs, reservations int
			if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM agent_reviews WHERE user_id=$1),(SELECT count(*) FROM credit_reservations WHERE user_id=$1)`, user.ID).Scan(&jobs, &reservations); err != nil {
				t.Fatal(err)
			}
			balance, err := app.loadCreditBalance(ctx, user.ID)
			if err != nil || jobs != 0 || reservations != 0 || calls.Load() != 0 || balance.Available != 100 {
				t.Fatalf("legacy request had side effects: jobs=%d reservations=%d calls=%d balance=%+v err=%v", jobs, reservations, calls.Load(), balance, err)
			}
			// The updated client explicitly opts into the credit-backed provider.
			response = requestAgentReviewCreate(t, app, user, doc.DocID, `{"providerMode":"builtin","tasks":["title"]}`)
			if response.Code != 202 {
				t.Fatalf("confirmed review: %d %s", response.Code, response.Body.String())
			}
			initial := decodeAgentReviewResponse(t, response)
			completed := waitForAgentReviewStatus(t, app, user.ID, initial.ReviewID, "ready")
			if completed.CreditsCharged != 2 || calls.Load() != 1 {
				t.Fatalf("confirmed billing: charged=%d calls=%d", completed.CreditsCharged, calls.Load())
			}
		})
	}
}
