package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/config"
	"koinote/backend/internal/migrations"
)

type staticAnnouncementTranslator struct {
	input announcementTranslationInput
}

func (s *staticAnnouncementTranslator) Translate(_ context.Context, input announcementTranslationInput) (map[string]announcementTranslation, error) {
	s.input = input
	result := make(map[string]announcementTranslation)
	for _, locale := range input.Targets {
		result[locale] = announcementTranslation{
			Title:      "title-" + locale,
			Summary:    "summary-" + locale,
			Highlights: []string{"first-" + locale, "second-" + locale},
		}
	}
	return result, nil
}

func TestAnnouncementsEndToEnd(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set; CI runs the announcement integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := migrations.Apply(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}

	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	adminAuthID := "announcement-admin-" + suffix
	userAuthID := "announcement-user-" + suffix
	lateUserAuthID := "announcement-late-user-" + suffix
	var adminID, userID, lateUserID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified, is_admin)
		VALUES ($1, $2, true, true) RETURNING id
	`, adminAuthID, adminAuthID+"@example.com").Scan(&adminID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified, is_admin)
		VALUES ($1, $2, true, false) RETURNING id
	`, userAuthID, userAuthID+"@example.com").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	version := "test-" + suffix
	defer func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM announcements WHERE created_by = $1 OR version = $2`, adminID, version)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []int{adminID, userID, lateUserID})
	}()

	translator := &staticAnnouncementTranslator{}
	app := New(config.Config{SessionSecret: "secret"}, pool)
	app.announcementTranslator = translator
	handler := app.Routes()
	request := func(authUserID, method, path string, body []byte) *httptest.ResponseRecorder {
		token, _ := app.signSession(authUserID, 1)
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
		if len(body) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	payload := []byte(`{"sourceLocale":"zh","translation":{"title":"重要提醒","summary":"这里是摘要","highlights":["第一项","第二项"]}}`)
	forbidden := request(userAuthID, http.MethodPost, "/api/admin/announcements", payload)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("normal user publish status=%d body=%s", forbidden.Code, forbidden.Body.String())
	}
	published := request(adminAuthID, http.MethodPost, "/api/admin/announcements", payload)
	if published.Code != http.StatusCreated {
		t.Fatalf("admin publish status=%d body=%s", published.Code, published.Body.String())
	}
	if translator.input.SourceLocale != "zh" || len(translator.input.Targets) != 3 {
		t.Fatalf("translator input=%+v", translator.input)
	}

	unread := request(userAuthID, http.MethodGet, "/api/announcements/unread?locale=fr", nil)
	if unread.Code != http.StatusOK {
		t.Fatalf("unread status=%d body=%s", unread.Code, unread.Body.String())
	}
	var unreadBody struct {
		Announcements []announcementView `json:"announcements"`
	}
	if err := json.Unmarshal(unread.Body.Bytes(), &unreadBody); err != nil {
		t.Fatal(err)
	}
	if len(unreadBody.Announcements) != 1 || unreadBody.Announcements[0].Translation.Title != "title-fr" {
		t.Fatalf("unexpected unread announcements: %+v", unreadBody.Announcements)
	}
	announcementID := unreadBody.Announcements[0].ID
	marked := request(userAuthID, http.MethodPost, fmt.Sprintf("/api/announcements/%d/read", announcementID), nil)
	if marked.Code != http.StatusOK {
		t.Fatalf("mark read status=%d body=%s", marked.Code, marked.Body.String())
	}
	afterRead := request(userAuthID, http.MethodGet, "/api/announcements/unread?locale=fr", nil)
	if !strings.Contains(afterRead.Body.String(), `"announcements":[]`) {
		t.Fatalf("read announcement should disappear: %s", afterRead.Body.String())
	}
	forbiddenWithdraw := request(userAuthID, http.MethodDelete, fmt.Sprintf("/api/admin/announcements/%d", announcementID), nil)
	if forbiddenWithdraw.Code != http.StatusForbidden {
		t.Fatalf("normal user withdraw status=%d body=%s", forbiddenWithdraw.Code, forbiddenWithdraw.Body.String())
	}
	withdrawn := request(adminAuthID, http.MethodDelete, fmt.Sprintf("/api/admin/announcements/%d", announcementID), nil)
	if withdrawn.Code != http.StatusOK {
		t.Fatalf("admin withdraw status=%d body=%s", withdrawn.Code, withdrawn.Body.String())
	}
	if _, err := pool.Exec(ctx, `DELETE FROM announcement_reads WHERE user_id = $1 AND announcement_id = $2`, userID, announcementID); err != nil {
		t.Fatal(err)
	}
	afterWithdraw := request(userAuthID, http.MethodGet, "/api/announcements/unread?locale=fr", nil)
	if !strings.Contains(afterWithdraw.Body.String(), `"announcements":[]`) {
		t.Fatalf("withdrawn announcement should remain hidden: %s", afterWithdraw.Body.String())
	}
	markWithdrawn := request(userAuthID, http.MethodPost, fmt.Sprintf("/api/announcements/%d/read", announcementID), nil)
	if markWithdrawn.Code != http.StatusNotFound {
		t.Fatalf("withdrawn announcement must not be markable: status=%d body=%s", markWithdrawn.Code, markWithdrawn.Body.String())
	}

	bundledPath := filepath.Join(t.TempDir(), "release.json")
	bundled := bundledReleaseAnnouncement{
		Version:      version,
		Translations: map[string]announcementTranslation{},
	}
	for _, locale := range announcementLocales {
		bundled.Translations[locale] = announcementTranslation{
			Title: "release-" + locale, Summary: "summary-" + locale, Highlights: []string{"highlight-" + locale},
		}
	}
	encoded, _ := json.Marshal(bundled)
	if err := os.WriteFile(bundledPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	app.cfg.ReleaseAnnouncementPath = bundledPath
	startImport := time.Now().UTC().Add(-time.Second)
	results := make(chan error, 2)
	for range 2 {
		go func() { results <- app.SyncBundledReleaseAnnouncement(ctx) }()
	}
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	var releaseCount int
	var releaseID int64
	var releasePublishedAt time.Time
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*), min(id), min(published_at)
		FROM announcements WHERE version = $1
	`, version).Scan(&releaseCount, &releaseID, &releasePublishedAt); err != nil {
		t.Fatal(err)
	}
	if releaseCount != 1 {
		t.Fatalf("concurrent release sync must be idempotent, count=%d", releaseCount)
	}
	if releasePublishedAt.Before(startImport) {
		t.Fatalf("release should publish at import time, got %s", releasePublishedAt)
	}
	existingUserUnread := request(userAuthID, http.MethodGet, "/api/announcements/unread?locale=ja", nil)
	if existingUserUnread.Code != http.StatusOK {
		t.Fatalf("existing user release unread status=%d body=%s", existingUserUnread.Code, existingUserUnread.Body.String())
	}
	var releaseUnreadBody struct {
		Announcements []announcementView `json:"announcements"`
	}
	if err := json.Unmarshal(existingUserUnread.Body.Bytes(), &releaseUnreadBody); err != nil {
		t.Fatal(err)
	}
	if len(releaseUnreadBody.Announcements) != 1 ||
		releaseUnreadBody.Announcements[0].ID != releaseID ||
		releaseUnreadBody.Announcements[0].Translation.Title != "release-ja" {
		t.Fatalf("existing users should receive the localized release: %+v", releaseUnreadBody.Announcements)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified, is_admin, created_at)
		VALUES ($1, $2, true, false, $3) RETURNING id
	`, lateUserAuthID, lateUserAuthID+"@example.com", releasePublishedAt.Add(time.Second)).Scan(&lateUserID); err != nil {
		t.Fatal(err)
	}
	lateUnread := request(lateUserAuthID, http.MethodGet, "/api/announcements/unread?locale=zh", nil)
	if lateUnread.Code != http.StatusOK || !strings.Contains(lateUnread.Body.String(), `"announcements":[]`) {
		t.Fatalf("new users must not receive historical announcements: status=%d body=%s", lateUnread.Code, lateUnread.Body.String())
	}
	lateMark := request(lateUserAuthID, http.MethodPost, fmt.Sprintf("/api/announcements/%d/read", releaseID), nil)
	if lateMark.Code != http.StatusNotFound {
		t.Fatalf("historical announcement must not be markable: status=%d body=%s", lateMark.Code, lateMark.Body.String())
	}

	adminList := request(adminAuthID, http.MethodGet, "/api/admin/announcements", nil)
	if adminList.Code != http.StatusOK || !strings.Contains(adminList.Body.String(), version) || !strings.Contains(adminList.Body.String(), `"withdrawnAt":`) {
		t.Fatalf("admin list status=%d body=%s", adminList.Code, adminList.Body.String())
	}
}
