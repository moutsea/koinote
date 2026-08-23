package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"koinote/backend/internal/httpx"
)

const (
	feedbackBodyMax        = 32 << 10
	feedbackMessageMax     = 4000
	feedbackPagePathMax    = 512
	feedbackUserAgentMax   = 512
	feedbackListDefault    = 50
	feedbackListMax        = 100
	feedbackSubmitAttempts = 10
	feedbackSubmitWindow   = time.Hour
)

type feedbackCreateInput struct {
	Category string `json:"category"`
	Message  string `json:"message"`
	PagePath string `json:"pagePath"`
}

type adminFeedbackItem struct {
	ID        int64     `json:"id"`
	UserID    *int      `json:"userId"`
	UserName  *string   `json:"userName"`
	UserEmail *string   `json:"userEmail"`
	Category  string    `json:"category"`
	Message   string    `json:"message"`
	PagePath  string    `json:"pagePath"`
	Client    string    `json:"client"`
	UserAgent string    `json:"userAgent"`
	CreatedAt time.Time `json:"createdAt"`
}

var (
	errFeedbackCategoryInvalid = errors.New("invalid feedback category")
	errFeedbackMessageRequired = errors.New("feedback message is required")
	errFeedbackMessageInvalid  = errors.New("feedback message contains invalid characters")
	errFeedbackMessageTooLong  = errors.New("feedback message is too long")
	errFeedbackPageInvalid     = errors.New("feedback page path is invalid")
)

func normalizeFeedbackInput(input feedbackCreateInput) (feedbackCreateInput, error) {
	input.Category = strings.TrimSpace(input.Category)
	input.Message = strings.TrimSpace(input.Message)
	input.PagePath = sanitizeFeedbackPagePath(strings.TrimSpace(input.PagePath))
	if input.Category != "bug" && input.Category != "experience" {
		return feedbackCreateInput{}, errFeedbackCategoryInvalid
	}
	if input.Message == "" {
		return feedbackCreateInput{}, errFeedbackMessageRequired
	}
	if feedbackMessageHasForbiddenRune(input.Message) {
		return feedbackCreateInput{}, errFeedbackMessageInvalid
	}
	if utf8.RuneCountInString(input.Message) > feedbackMessageMax {
		return feedbackCreateInput{}, errFeedbackMessageTooLong
	}
	if utf8.RuneCountInString(input.PagePath) > feedbackPagePathMax ||
		(input.PagePath != "" && !strings.HasPrefix(input.PagePath, "/")) ||
		feedbackPagePathHasForbiddenRune(input.PagePath) {
		return feedbackCreateInput{}, errFeedbackPageInvalid
	}
	return input, nil
}

func feedbackMessageHasForbiddenRune(message string) bool {
	for _, character := range message {
		if unicode.IsControl(character) && character != '\n' && character != '\r' && character != '\t' {
			return true
		}
		switch character {
		case '\u200b', '\u2060', '\ufeff':
			return true
		}
	}
	return false
}

func feedbackPagePathHasForbiddenRune(pagePath string) bool {
	for _, character := range pagePath {
		if unicode.IsControl(character) {
			return true
		}
		switch character {
		case '\u200b', '\u2060', '\ufeff':
			return true
		}
	}
	return false
}

func sanitizeFeedbackPagePath(pagePath string) string {
	if strings.HasPrefix(pagePath, "/share/") {
		return "/share/:token"
	}
	return pagePath
}

func feedbackInputError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errFeedbackCategoryInvalid):
		httpx.ErrorCode(w, http.StatusBadRequest, "feedback_category_invalid", "Invalid feedback category")
	case errors.Is(err, errFeedbackMessageRequired):
		httpx.ErrorCode(w, http.StatusBadRequest, "feedback_message_required", "Feedback message is required")
	case errors.Is(err, errFeedbackMessageInvalid):
		httpx.ErrorCode(w, http.StatusBadRequest, "feedback_message_invalid", "Feedback message contains invalid characters")
	case errors.Is(err, errFeedbackMessageTooLong):
		httpx.ErrorCode(w, http.StatusBadRequest, "feedback_message_too_long", "Feedback message is too long")
	case errors.Is(err, errFeedbackPageInvalid):
		httpx.ErrorCode(w, http.StatusBadRequest, "feedback_page_invalid", "Invalid feedback page path")
	default:
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
	}
}

func (a *App) feedbackCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var input feedbackCreateInput
	r.Body = http.MaxBytesReader(w, r.Body, feedbackBodyMax)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		feedbackInputError(w, err)
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		feedbackInputError(w, err)
		return
	}
	input, err := normalizeFeedbackInput(input)
	if err != nil {
		feedbackInputError(w, err)
		return
	}
	if !a.rateLimit().allow(
		fmt.Sprintf("feedback-submit:user:%d", user.ID),
		feedbackSubmitAttempts,
		feedbackSubmitWindow,
	) {
		tooManyAttempts(w)
		return
	}

	client := feedbackRequestClient(r)
	userAgent := truncateRunes(strings.TrimSpace(r.UserAgent()), feedbackUserAgentMax)
	var feedbackID int64
	var createdAt time.Time
	if err := a.db.QueryRow(r.Context(), `
		INSERT INTO user_feedback (user_id, category, message, page_path, client, user_agent)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, created_at
	`, user.ID, input.Category, input.Message, input.PagePath, client, userAgent).Scan(
		&feedbackID, &createdAt,
	); err != nil {
		log.Printf("feedback create: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"feedback": map[string]any{
			"id":        feedbackID,
			"category":  input.Category,
			"message":   input.Message,
			"pagePath":  input.PagePath,
			"client":    client,
			"createdAt": createdAt,
		},
	})
}

func feedbackRequestClient(r *http.Request) string {
	if strings.HasPrefix(bearerToken(r), desktopAccessTokenPrefix) {
		return "desktop"
	}
	return "web"
}

func (a *App) adminFeedbackList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}

	before, limit, err := parseFeedbackListParams(r)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid feedback list parameters")
		return
	}

	rows, err := a.db.Query(r.Context(), `
		SELECT feedback.id,
		       feedback.user_id,
		       CASE WHEN users.id IS NULL THEN NULL
		            ELSE COALESCE(NULLIF(users.nickname, ''), NULLIF(users.username, ''), users.email)
		       END AS user_name,
		       users.email,
		       feedback.category,
		       feedback.message,
		       feedback.page_path,
		       feedback.client,
		       feedback.user_agent,
		       feedback.created_at
		FROM user_feedback feedback
		LEFT JOIN users ON users.id = feedback.user_id
		WHERE ($1::bigint = 0 OR feedback.id < $1)
		ORDER BY feedback.id DESC
		LIMIT $2
	`, before, limit+1)
	if err != nil {
		log.Printf("admin feedback list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()

	items := make([]adminFeedbackItem, 0)
	for rows.Next() {
		var item adminFeedbackItem
		if err := rows.Scan(
			&item.ID,
			&item.UserID,
			&item.UserName,
			&item.UserEmail,
			&item.Category,
			&item.Message,
			&item.PagePath,
			&item.Client,
			&item.UserAgent,
			&item.CreatedAt,
		); err != nil {
			log.Printf("admin feedback scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		item.PagePath = sanitizeFeedbackPagePath(item.PagePath)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		log.Printf("admin feedback rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var nextCursor *int64
	if len(items) > limit {
		items = items[:limit]
		cursor := items[len(items)-1].ID
		nextCursor = &cursor
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"feedback":   items,
		"nextCursor": nextCursor,
	})
}

func parseFeedbackListParams(r *http.Request) (int64, int, error) {
	before := int64(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("before")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			return 0, 0, errors.New("invalid feedback cursor")
		}
		before = parsed
	}

	limit := feedbackListDefault
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > feedbackListMax {
			return 0, 0, errors.New("invalid feedback limit")
		}
		limit = parsed
	}
	return before, limit, nil
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
