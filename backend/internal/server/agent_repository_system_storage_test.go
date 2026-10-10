package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestAgentRepositorySystemSlots(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "system-catalog-slots"}, pool)
	ctx := context.Background()
	for _, test := range []struct {
		name    string
		admin   bool
		bonus   int64
		allowed bool
	}{
		{"ordinary member", false, 0, false},
		{"ordinary member with storage grant", false, 200000000, false},
		{"administrator without system grant", true, 0, false},
		{"system-funded administrator", true, 200000000, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			user := seedMCPUser(t, pool, app, membershipTierLifetime)
			if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=$2 WHERE id=$1`, user.ID, test.admin); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_storage_quotas(user_id,bonus_bytes) VALUES($1,$2)`, user.ID, test.bonus); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO agent_workspaces(user_id,name) SELECT $1,'Existing '||n FROM generate_series(1,100) n`, user.ID); err != nil {
				t.Fatal(err)
			}
			_, err := app.createAgentWorkspace(ctx, user.ID, "Catalog repository", "", "en")
			if !test.allowed {
				if !errors.Is(err, errAgentWorkspaceLimit) {
					t.Fatalf("expected repository limit, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = pool.Exec(ctx, `INSERT INTO agent_workspaces(user_id,name) SELECT $1,'More '||n FROM generate_series(102,199) n`, user.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = app.createAgentWorkspace(ctx, user.ID, "Last system slot", "", "en"); err != nil {
				t.Fatal(err)
			}
			if _, err = app.createAgentWorkspace(ctx, user.ID, "Over system limit", "", "en"); !errors.Is(err, errAgentWorkspaceLimit) {
				t.Fatalf("system slots must remain bounded: %v", err)
			}
			if _, err = pool.Exec(ctx, `UPDATE users SET is_admin=false WHERE id=$1`, user.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = app.createAgentWorkspace(ctx, user.ID, "Former admin", "", "en"); !errors.Is(err, errAgentWorkspaceLimit) {
				t.Fatalf("removed admin must not retain extra slots: %v", err)
			}
		})
	}
}

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
