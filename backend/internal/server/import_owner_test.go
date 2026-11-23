package server

import (
	"context"
	"koinote/backend/internal/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestImportOwnerPinsAuthenticatedWrites(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{SessionSecret: "import-owner-test"}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	cookie := sessionCookieFor(t, a, user.AuthUserID, user.SessionVersion)
	request := func(path, body, owner string, signedIn bool) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if owner != "" {
			r.Header.Set("X-Koinote-Import-Owner", owner)
		}
		if signedIn {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, r)
		return w
	}
	for _, entry := range [][2]string{
		{"/api/documents", `{"title":"Must not be saved"}`},
		{"/api/folders", `{"name":"Must not be saved","parentFolderId":null}`},
		{"/api/storage/release-images", `{"keys":[]}`},
	} {
		w := request(entry[0], entry[1], "another-account", true)
		if w.Code != 409 || decodeErrorCode(t, w) != "import_account_changed" {
			t.Fatalf("%s: %d %s", entry[0], w.Code, w.Body.String())
		}
		if len(w.Result().Cookies()) != 0 {
			t.Fatal("a mismatched import must not clear a valid new account session")
		}
	}
	for _, table := range []string{"documents", "folders"} {
		var count int
		if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table+" WHERE user_id=$1", user.ID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s count=%d err=%v", table, count, err)
		}
	}
	w := request("/api/documents", `{}`, user.AuthUserID, false)
	if w.Code != 401 {
		t.Fatalf("owner hint granted authentication: %d", w.Code)
	}
	for _, owner := range []string{user.AuthUserID, ""} {
		w = request("/api/documents", `{"title":"Allowed"}`, owner, true)
		if w.Code != 200 {
			t.Fatalf("valid/legacy create: %d %s", w.Code, w.Body.String())
		}
	}
	w = request("/api/folders", `{"name":"Allowed","parentFolderId":null}`, user.AuthUserID, true)
	if w.Code != 200 {
		t.Fatalf("valid folder: %d %s", w.Code, w.Body.String())
	}
}
