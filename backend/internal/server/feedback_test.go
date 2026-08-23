package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/config"
	"koinote/backend/internal/migrations"
)

func TestNormalizeFeedbackInput(t *testing.T) {
	normalized, err := normalizeFeedbackInput(feedbackCreateInput{
		Category: " bug ",
		Message:  "  something broke  ",
		PagePath: " /editor/doc-1 ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Category != "bug" || normalized.Message != "something broke" || normalized.PagePath != "/editor/doc-1" {
		t.Fatalf("unexpected normalized feedback: %+v", normalized)
	}
	redacted, err := normalizeFeedbackInput(feedbackCreateInput{
		Category: "experience",
		Message:  "shared page feedback",
		PagePath: "/share/SECRET_TOKEN_abc123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if redacted.PagePath != "/share/:token" {
		t.Fatalf("share token was not redacted: %q", redacted.PagePath)
	}

	tests := []struct {
		name  string
		input feedbackCreateInput
		want  error
	}{
		{"invalid category", feedbackCreateInput{Category: "other", Message: "message"}, errFeedbackCategoryInvalid},
		{"empty message", feedbackCreateInput{Category: "experience", Message: "  "}, errFeedbackMessageRequired},
		{"NUL message", feedbackCreateInput{Category: "bug", Message: "before\x00after"}, errFeedbackMessageInvalid},
		{"zero width message", feedbackCreateInput{Category: "bug", Message: "\u200b"}, errFeedbackMessageInvalid},
		{"long message", feedbackCreateInput{Category: "bug", Message: strings.Repeat("字", feedbackMessageMax+1)}, errFeedbackMessageTooLong},
		{"absolute URL", feedbackCreateInput{Category: "bug", Message: "message", PagePath: "https://example.com"}, errFeedbackPageInvalid},
		{"NUL page", feedbackCreateInput{Category: "bug", Message: "message", PagePath: "/editor/\x00"}, errFeedbackPageInvalid},
		{"long page", feedbackCreateInput{Category: "bug", Message: "message", PagePath: "/" + strings.Repeat("a", feedbackPagePathMax)}, errFeedbackPageInvalid},
	}
	if _, err := normalizeFeedbackInput(feedbackCreateInput{
		Category: "bug",
		Message:  "line one\nline two\tcontext",
	}); err != nil {
		t.Fatalf("normal multiline feedback rejected: %v", err)
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := normalizeFeedbackInput(test.input)
			if !errors.Is(err, test.want) {
				t.Fatalf("error=%v want=%v", err, test.want)
			}
		})
	}
	if got := utf8RuneCount(truncateRunes(strings.Repeat("你", 600), feedbackUserAgentMax)); got != feedbackUserAgentMax {
		t.Fatalf("truncated rune count=%d", got)
	}
	if got := truncateRunes("value", 0); got != "" {
		t.Fatalf("zero-length truncation=%q", got)
	}
}

func TestParseFeedbackListParams(t *testing.T) {
	tests := []struct {
		path       string
		wantBefore int64
		wantLimit  int
		wantError  bool
	}{
		{"/api/admin/feedback", 0, feedbackListDefault, false},
		{"/api/admin/feedback?before=42&limit=25", 42, 25, false},
		{"/api/admin/feedback?before=0", 0, 0, true},
		{"/api/admin/feedback?before=nope", 0, 0, true},
		{"/api/admin/feedback?limit=0", 0, 0, true},
		{"/api/admin/feedback?limit=101", 0, 0, true},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			before, limit, err := parseFeedbackListParams(request)
			if (err != nil) != test.wantError {
				t.Fatalf("error=%v wantError=%v", err, test.wantError)
			}
			if before != test.wantBefore || limit != test.wantLimit {
				t.Fatalf("before=%d limit=%d", before, limit)
			}
		})
	}
}

func TestFeedbackInvalidMessageResponse(t *testing.T) {
	response := httptest.NewRecorder()
	feedbackInputError(response, errFeedbackMessageInvalid)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "feedback_message_invalid" {
		t.Fatalf("code=%q", body.Code)
	}
}

func utf8RuneCount(value string) int {
	return len([]rune(value))
}

func TestFeedbackRequiresAuthentication(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "feedback-secret"})
	request := httptest.NewRequest(http.MethodPost, "/api/feedback", strings.NewReader(`{"category":"bug","message":"broken"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestFeedbackBodyLimitCoversMaximumUnicodeMessage(t *testing.T) {
	payload := mustFeedbackJSON(t, feedbackCreateInput{
		Category: "experience",
		Message:  strings.Repeat("😀", feedbackMessageMax),
		PagePath: "/editor/document",
	})
	if len(payload) > feedbackBodyMax {
		t.Fatalf("valid maximum feedback payload uses %d bytes; body limit is %d", len(payload), feedbackBodyMax)
	}
}

func TestFeedbackRequestClient(t *testing.T) {
	web := httptest.NewRequest(http.MethodPost, "/api/feedback", nil)
	if got := feedbackRequestClient(web); got != "web" {
		t.Fatalf("web client=%q", got)
	}
	desktop := httptest.NewRequest(http.MethodPost, "/api/feedback", nil)
	desktop.Header.Set("Authorization", "Bearer "+desktopAccessTokenPrefix+"test")
	if got := feedbackRequestClient(desktop); got != "desktop" {
		t.Fatalf("desktop client=%q", got)
	}
}

func TestFeedbackEndToEnd(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set; CI runs the feedback integration test")
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
	adminAuthID := "feedback-admin-" + suffix
	userAuthID := "feedback-user-" + suffix
	var adminID, userID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, nickname, is_verified, is_admin)
		VALUES ($1, $2, 'Feedback Admin', true, true) RETURNING id
	`, adminAuthID, adminAuthID+"@example.com").Scan(&adminID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, nickname, is_verified, is_admin)
		VALUES ($1, $2, 'Feedback User', true, false) RETURNING id
	`, userAuthID, userAuthID+"@example.com").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM user_feedback WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []int{adminID, userID})
	})

	app := New(config.Config{SessionSecret: "feedback-secret"}, pool)
	handler := app.Routes()
	request := func(authUserID, method, path string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		token, _ := app.signSession(authUserID, 1)
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
		req.Header.Set("User-Agent", "Koinote Feedback Test")
		if len(body) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		return recorder
	}

	invalidPayloads := [][]byte{
		[]byte(`{"category":"other","message":"broken"}`),
		[]byte(`{"category":"bug","message":"  "}`),
		mustFeedbackJSON(t, feedbackCreateInput{Category: "bug", Message: strings.Repeat("x", feedbackMessageMax+1)}),
	}
	for len(invalidPayloads) < feedbackSubmitAttempts {
		invalidPayloads = append(invalidPayloads, []byte(`{"category":"bug","message":"  "}`))
	}
	for _, payload := range invalidPayloads {
		response := request(userAuthID, http.MethodPost, "/api/feedback", payload)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid feedback status=%d body=%s", response.Code, response.Body.String())
		}
	}

	created := request(userAuthID, http.MethodPost, "/api/feedback", []byte(`{"category":"experience","message":"Please improve the export flow.","pagePath":"/share/SECRET_TOKEN_abc123"}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var createdBody struct {
		Feedback struct {
			ID       int64  `json:"id"`
			PagePath string `json:"pagePath"`
		} `json:"feedback"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil {
		t.Fatal(err)
	}
	if createdBody.Feedback.PagePath != "/share/:token" {
		t.Fatalf("create response leaked share token: %s", created.Body.String())
	}
	var storedPagePath string
	if err := pool.QueryRow(ctx, `SELECT page_path FROM user_feedback WHERE id = $1`, createdBody.Feedback.ID).Scan(&storedPagePath); err != nil {
		t.Fatal(err)
	}
	if storedPagePath != "/share/:token" {
		t.Fatalf("stored page path leaked share token: %q", storedPagePath)
	}
	forbidden := request(userAuthID, http.MethodGet, "/api/admin/feedback", nil)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("non-admin list status=%d body=%s", forbidden.Code, forbidden.Body.String())
	}
	listed := request(adminAuthID, http.MethodGet, "/api/admin/feedback", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("admin list status=%d body=%s", listed.Code, listed.Body.String())
	}
	var body struct {
		Feedback   []adminFeedbackItem `json:"feedback"`
		NextCursor *int64              `json:"nextCursor"`
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Feedback) == 0 {
		t.Fatal("admin feedback list is empty")
	}
	var item adminFeedbackItem
	found := false
	for _, candidate := range body.Feedback {
		if candidate.ID == createdBody.Feedback.ID {
			item = candidate
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("created feedback %d missing from admin list", createdBody.Feedback.ID)
	}
	if item.UserID == nil || *item.UserID != userID || item.UserName == nil || *item.UserName != "Feedback User" ||
		item.Category != "experience" || item.Message != "Please improve the export flow." ||
		item.PagePath != "/share/:token" || item.Client != "web" || item.UserAgent != "Koinote Feedback Test" {
		t.Fatalf("unexpected feedback: %+v", item)
	}

	for _, message := range []string{"Pagination feedback one", "Pagination feedback two"} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO user_feedback (user_id, category, message, page_path, client, user_agent)
			VALUES ($1, 'bug', $2, '/admin', 'web', 'Koinote Feedback Test')
		`, userID, message); err != nil {
			t.Fatal(err)
		}
	}
	firstPage := request(adminAuthID, http.MethodGet, "/api/admin/feedback?limit=2", nil)
	if firstPage.Code != http.StatusOK {
		t.Fatalf("first page status=%d body=%s", firstPage.Code, firstPage.Body.String())
	}
	var firstPageBody struct {
		Feedback   []adminFeedbackItem `json:"feedback"`
		NextCursor *int64              `json:"nextCursor"`
	}
	if err := json.Unmarshal(firstPage.Body.Bytes(), &firstPageBody); err != nil {
		t.Fatal(err)
	}
	if len(firstPageBody.Feedback) != 2 || firstPageBody.NextCursor == nil {
		t.Fatalf("unexpected first page: %+v", firstPageBody)
	}
	secondPage := request(adminAuthID, http.MethodGet, "/api/admin/feedback?limit=2&before="+strconv.FormatInt(*firstPageBody.NextCursor, 10), nil)
	if secondPage.Code != http.StatusOK {
		t.Fatalf("second page status=%d body=%s", secondPage.Code, secondPage.Body.String())
	}
	var secondPageBody struct {
		Feedback []adminFeedbackItem `json:"feedback"`
	}
	if err := json.Unmarshal(secondPage.Body.Bytes(), &secondPageBody); err != nil {
		t.Fatal(err)
	}
	for _, first := range firstPageBody.Feedback {
		for _, second := range secondPageBody.Feedback {
			if first.ID == second.ID {
				t.Fatalf("feedback %d appeared on both cursor pages", first.ID)
			}
		}
	}
}

func mustFeedbackJSON(t *testing.T, input feedbackCreateInput) []byte {
	t.Helper()
	payload, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}
