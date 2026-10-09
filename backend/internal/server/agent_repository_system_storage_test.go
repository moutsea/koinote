package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestAgentRepositorySystemStorage(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "system-catalog-storage"}, pool)
	ctx := context.Background()
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, user.ID); err != nil {
		t.Fatal(err)
	}
	cookie := mcpSessionCookie(app, user.AuthUserID)
	const endpoint = "/api/admin/agent-repositories/storage"
	body := fmt.Sprintf(`{"ownerEmail":%q,"minimumBonusBytes":200000000}`, user.Email)
	call := func(payload string) *httptest.ResponseRecorder {
		return callLLMChannelAPI(t, app, cookie, http.MethodPut, endpoint, payload)
	}
	if response := doRequest(app, http.MethodPut, endpoint); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous grant: %d", response.Code)
	}
	if response := call(body); response.Code != http.StatusForbidden {
		t.Fatalf("member granted system storage: %d", response.Code)
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	if response := call(`{"ownerEmail":"someone-else@example.com","minimumBonusBytes":200000000}`); response.Code != http.StatusConflict {
		t.Fatalf("wrong owner: %d", response.Code)
	}
	for _, invalid := range []string{
		`{}`, `{"minimumBonusBytes":null}`, `{"minimumBonusBytes":-1}`,
		`{"minimumBonusBytes":1.5}`, `{"minimumBonusBytes":200,"unexpected":true}`, body + `{}`,
		fmt.Sprintf(`{"ownerEmail":%q,"minimumBonusBytes":9223372036854775807}`, user.Email),
	} {
		if response := call(invalid); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid grant accepted: %d", response.Code)
		}
	}
	// Existing personal reservations are neither increased nor silently released.
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_storage_quotas(user_id,bonus_bytes,allocated_bytes) VALUES($1,1234,8192)`, user.ID); err != nil {
		t.Fatal(err)
	}
	for _, amount := range []int64{200000000, 200000000, 1000} {
		response := call(fmt.Sprintf(`{"ownerEmail":%q,"minimumBonusBytes":%d}`, user.Email, amount))
		if response.Code != http.StatusOK {
			t.Fatalf("grant: %d %s", response.Code, response.Body.String())
		}
		var result struct{ Storage agentWorkspaceStorageView }
		decodeJSONResponse(t, response, &result)
		v := result.Storage
		if v.BonusBytes != 200000000 || v.QuotaBytes != agentWorkspaceDefaultQuotaBytes+200000000+8192 || v.AllocatedBytes != 8192 || v.PersonalUsedBytes != 8192 || v.AvailableBytes != lifetimeStorageQuotaBytes-8192 {
			t.Fatalf("grant changed personal billing or repeated: %+v", v)
		}
	}
	created := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/mcp/tokens", `{"name":"No system grants","scope":"agent_write"}`)
	var token struct{ Secret string }
	decodeJSONResponse(t, created, &token)
	if token.Secret == "" {
		t.Fatal("missing real repository token")
	}
	request := httptest.NewRequest(http.MethodPut, endpoint, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token.Secret)
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized && response.Code != http.StatusForbidden {
		t.Fatalf("administrator's repository token granted system storage: %d", response.Code)
	}
	// The same administrator may use a desktop session; the token itself does
	// not confer administrator privileges to ordinary desktop users.
	desktop, err := app.issueDesktopTokenPair(ctx, pool, user.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPut, endpoint, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+desktop.AccessToken)
	response = httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("admin desktop grant: %d %s", response.Code, response.Body.String())
	}
	if _, err = pool.Exec(ctx, `UPDATE users SET is_admin=false WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPut, endpoint, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+desktop.AccessToken)
	response = httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("nonadmin desktop grant: %d", response.Code)
	}
}
