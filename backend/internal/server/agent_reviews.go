package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const (
	agentReviewRequestBytes   = 4 << 10
	agentReviewRateLimit      = 6
	agentReviewRateWindow     = 5 * time.Minute
	agentReviewMaxRunning     = 3
	agentReviewListLimit      = 20
	agentReviewRunLimit       = 15 * time.Minute
	agentReviewReservationTTL = agentReviewRunLimit + 2*time.Minute
	agentReviewFinalizeLimit  = 20 * time.Second
	agentReviewStaleAfter     = agentReviewReservationTTL
)

const expireStaleAgentReviewsSQL = `
	WITH expired AS (
		UPDATE agent_reviews
		SET status = 'failed', error_code = 'review_timeout',
		    completed_at = now(), updated_at = now()
		WHERE user_id = $1
		  AND status = 'running'
		  AND created_at < $2
		RETURNING id
	)
	DELETE FROM agent_review_suggestions suggestion
	USING expired
	WHERE suggestion.review_id = expired.id
`

const expireStaleAgentReviewSQL = `
	WITH expired AS (
		UPDATE agent_reviews
		SET status = 'failed', error_code = 'review_timeout',
		    completed_at = now(), updated_at = now()
		WHERE review_id = $1
		  AND user_id = $2
		  AND status = 'running'
		  AND created_at < $3
		RETURNING id
	)
	DELETE FROM agent_review_suggestions suggestion
	USING expired
	WHERE suggestion.review_id = expired.id
`

var (
	errAgentReviewNotFound     = errors.New("agent review not found")
	errAgentReviewStale        = errors.New("agent review is stale")
	errAgentReviewClosed       = errors.New("agent review is closed")
	errAgentReviewPersistence  = errors.New("agent review persistence failed")
	errAgentSuggestionNotFound = errors.New("agent suggestion not found")
	errAgentSuggestionClosed   = errors.New("agent suggestion is closed")
	errAgentSuggestionConflict = errors.New("agent suggestion no longer matches the document")
)

type agentReviewView struct {
	ReviewID         string                      `json:"reviewId"`
	DocumentID       string                      `json:"documentId"`
	BaseRevision     int64                       `json:"baseRevision"`
	CurrentRevision  int64                       `json:"currentRevision"`
	DocumentRevision int64                       `json:"documentRevision"`
	ProviderMode     string                      `json:"providerMode"`
	ProviderProtocol string                      `json:"providerProtocol"`
	ChannelID        *string                     `json:"channelId"`
	Model            string                      `json:"model"`
	Status           string                      `json:"status"`
	Summary          *string                     `json:"summary"`
	TitleScore       *int                        `json:"titleScore"`
	TitleAssessment  *string                     `json:"titleAssessment"`
	LayoutAssessment []writingReviewDimension    `json:"layoutAssessment"`
	TaskProgress     agentReviewTaskProgress     `json:"taskProgress"`
	InputTokens      int                         `json:"inputTokens"`
	OutputTokens     int                         `json:"outputTokens"`
	TotalTokens      int                         `json:"totalTokens"`
	CreditsCharged   int                         `json:"creditsCharged"`
	ErrorCode        *string                     `json:"errorCode"`
	CreatedAt        time.Time                   `json:"createdAt"`
	CompletedAt      *time.Time                  `json:"completedAt"`
	UpdatedAt        time.Time                   `json:"updatedAt"`
	Suggestions      []agentReviewSuggestionView `json:"suggestions,omitempty"`
}

type agentReviewTaskProgress struct {
	Mode           string                     `json:"mode,omitempty"`
	FocusDimension string                     `json:"focusDimension,omitempty"`
	CompletedTasks int                        `json:"completedTasks"`
	TotalTasks     int                        `json:"totalTasks"`
	Stages         []agentReviewStageProgress `json:"stages"`
}

type agentReviewStageProgress struct {
	ID             agentReviewTaskStage `json:"id"`
	Status         string               `json:"status"`
	CompletedTasks int                  `json:"completedTasks"`
	TotalTasks     int                  `json:"totalTasks"`
	DurationMS     int64                `json:"durationMs"`
}

type agentReviewSuggestionView struct {
	SuggestionID string     `json:"suggestionId"`
	Ordinal      int        `json:"ordinal"`
	Target       string     `json:"target"`
	Kind         string     `json:"kind"`
	Category     string     `json:"category"`
	Operation    *string    `json:"operation"`
	Before       string     `json:"before"`
	After        string     `json:"after"`
	Reason       string     `json:"reason"`
	Status       string     `json:"status"`
	AppliedAt    *time.Time `json:"appliedAt"`
}

type agentReviewDocument struct {
	DatabaseID int
	DocID      string
	Title      string
	Theme      string
	Content    string
	Revision   int64
	CreatedAt  *time.Time
	UpdatedAt  *time.Time
}

type preparedAgentReviewSuggestion struct {
	ID string
	validatedWritingSuggestion
}

type lockedAgentReview struct {
	DatabaseID      int64
	Status          string
	CurrentRevision int64
	Document        agentReviewDocument
}

type lockedAgentSuggestion struct {
	SuggestionID string
	Ordinal      int
	Target       string
	Kind         string
	Operation    string
	Before       string
	After        string
	Status       string
}

type agentReviewMutationResult struct {
	Review   agentReviewView
	Document model.Document
}

func (a *App) agentReviewCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow(
		fmt.Sprintf("agent-review:user:%d", user.ID),
		agentReviewRateLimit,
		agentReviewRateWindow,
	) {
		tooManyAttempts(w)
		return
	}

	var input struct {
		ProviderMode   string `json:"providerMode"`
		ChannelID      string `json:"channelId"`
		Depth          string `json:"depth"`
		FocusDimension string `json:"focusDimension"`
		SourceReviewID string `json:"sourceReviewId"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, agentReviewRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil && !errors.Is(err, io.EOF) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	input.ProviderMode = strings.ToLower(strings.TrimSpace(input.ProviderMode))
	input.ChannelID = strings.TrimSpace(input.ChannelID)
	input.Depth = strings.ToLower(strings.TrimSpace(input.Depth))
	input.FocusDimension = strings.ToLower(strings.TrimSpace(input.FocusDimension))
	input.SourceReviewID = strings.TrimSpace(input.SourceReviewID)
	if input.Depth == "" {
		input.Depth = agentReviewModeStandard
	}
	if input.Depth != agentReviewModeStandard && input.Depth != agentReviewModeDeep {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_review_depth", "Review depth must be standard or deep")
		return
	}
	if input.Depth == agentReviewModeDeep && !writingReviewDimensionExists(input.FocusDimension) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_review_focus", "Deep review requires a valid focus dimension")
		return
	}
	if input.Depth == agentReviewModeDeep && input.SourceReviewID == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_review_source", "Deep review requires a source review")
		return
	}
	if input.Depth == agentReviewModeStandard && input.FocusDimension != "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_review_focus", "Standard review cannot set a focus dimension")
		return
	}
	if input.Depth == agentReviewModeStandard && input.SourceReviewID != "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_review_source", "Standard review cannot set a source review")
		return
	}
	if input.ProviderMode == "" {
		mode, err := a.loadAgentProviderMode(r.Context(), user.ID)
		if err != nil {
			log.Printf("agent review load provider preference: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		input.ProviderMode = mode
	}
	if input.ProviderMode != "builtin" && input.ProviderMode != "byok" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_provider", "Provider mode must be builtin or byok")
		return
	}
	if input.ProviderMode == "builtin" && input.ChannelID != "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_provider", "Built-in provider cannot use a BYOK channel")
		return
	}

	document, err := a.loadAgentReviewDocument(r.Context(), user.ID, r.PathValue("docId"))
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if err != nil {
		log.Printf("agent review load document: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	deepContext := writingReviewDeepContext{}
	if input.Depth == agentReviewModeDeep {
		sourceReview, err := a.loadAgentReview(r.Context(), user.ID, input.SourceReviewID, true)
		if errors.Is(err, errAgentReviewNotFound) {
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_review_source", "Source review is not available for deep analysis")
			return
		}
		if err != nil {
			log.Printf("agent review load deep analysis source: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if sourceReview.DocumentID != document.DocID || sourceReview.CurrentRevision != document.Revision ||
			sourceReview.Status == "running" || sourceReview.Status == "failed" || sourceReview.Status == "stale" {
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_review_source", "Source review is not available for deep analysis")
			return
		}
		deepContext = writingReviewDeepContextFromReview(sourceReview, input.FocusDimension)
	}
	provider, channelDatabaseID, err := a.resolveAgentLLMProvider(r.Context(), user, input.ProviderMode, input.ChannelID)
	if err != nil {
		a.writeAgentProviderResolveError(w, err)
		return
	}
	var plan writingReviewTaskPlan
	if input.Depth == agentReviewModeDeep {
		plan, err = buildDeepWritingReviewTaskPlan(
			document.Title, document.Content, input.FocusDimension, deepContext,
		)
	} else {
		plan, err = buildWritingReviewTaskPlan(document.Title, document.Content)
	}
	if err != nil {
		log.Printf("agent review build task plan: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	reviewID, err := randomUUID()
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	reviewDatabaseID, err := a.insertRunningAgentReview(
		r.Context(),
		user.ID,
		document,
		reviewID,
		provider,
		channelDatabaseID,
		newAgentReviewTaskProgress(plan),
	)
	if errors.Is(err, errAgentReviewClosed) {
		httpx.ErrorCode(w, http.StatusConflict, "agent_review_in_progress", "Wait for an active review to finish")
		return
	}
	if err != nil {
		log.Printf("agent review insert: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	reservationID := ""
	if provider.Mode == "builtin" {
		reservationCredits := estimateAgentReviewPlanReservation(plan)
		reservation, err := a.reserveCredits(
			r.Context(),
			user.ID,
			reviewDatabaseID,
			reservationCredits,
			agentReviewReservationTTL,
		)
		if err != nil {
			a.failAgentReview(context.WithoutCancel(r.Context()), user.ID, reviewDatabaseID, "credit_reservation_failed", "")
			if errors.Is(err, errInsufficientCredits) {
				httpx.ErrorCode(w, http.StatusPaymentRequired, "insufficient_credits", "Not enough credits for this review")
				return
			}
			log.Printf("agent review reserve credits: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		reservationID = reservation.ReservationID
	}

	view, err := a.loadAgentReview(r.Context(), user.ID, reviewID, true)
	if err != nil {
		a.failAgentReview(context.Background(), user.ID, reviewDatabaseID, "server_error", reservationID)
		log.Printf("agent review load running review=%s: %v", reviewID, err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	go a.runAgentReview(user.ID, reviewDatabaseID, reviewID, document, provider, reservationID, plan)
	httpx.JSON(w, http.StatusAccepted, map[string]any{"review": view})
}

func writingReviewDeepContextFromReview(
	review agentReviewView,
	focusDimension string,
) writingReviewDeepContext {
	context := writingReviewDeepContext{Suggestions: make([]writingReviewDeepPriorSuggestion, 0)}
	sourceIsDifferentDeepFocus := review.TaskProgress.Mode == agentReviewModeDeep &&
		review.TaskProgress.FocusDimension != focusDimension
	if review.Summary != nil && !sourceIsDifferentDeepFocus {
		context.Summary = truncateWritingReviewContext(
			*review.Summary, agentReviewDeepContextSummaryBytes, false,
		)
	}
	for _, dimension := range review.LayoutAssessment {
		if dimension.ID != focusDimension {
			continue
		}
		value := dimension
		value.Label = truncateWritingReviewContext(value.Label, agentReviewDeepContextDimensionBytes, false)
		value.Summary = truncateWritingReviewContext(value.Summary, agentReviewDeepContextDimensionBytes, false)
		context.Dimension = &value
		if sourceIsDifferentDeepFocus {
			context.Summary = value.Summary
		}
		break
	}
	for _, suggestion := range writingReviewDeepContextSuggestions(review.Suggestions, focusDimension) {
		if len(context.Suggestions) >= agentReviewDeepContextSuggestionLimit {
			break
		}
		operation := ""
		if suggestion.Operation != nil {
			operation = *suggestion.Operation
		}
		candidate := writingReviewDeepPriorSuggestion{
			Kind:      suggestion.Kind,
			Category:  suggestion.Category,
			Operation: operation,
			Before: truncateWritingReviewContext(
				suggestion.Before, agentReviewDeepContextPatchBytes, false,
			),
			After: truncateWritingReviewContext(
				suggestion.After, agentReviewDeepContextPatchBytes, false,
			),
			Reason: truncateWritingReviewContext(
				suggestion.Reason, agentReviewDeepContextReasonBytes, false,
			),
			Status: suggestion.Status,
		}
		context.Suggestions = append(context.Suggestions, candidate)
		if writingReviewDeepContextEncodedBytes(context) > agentReviewDeepContextBytes {
			context.Suggestions = context.Suggestions[:len(context.Suggestions)-1]
		}
	}
	if writingReviewDeepContextEncodedBytes(context) > agentReviewDeepContextBytes {
		context.Dimension = nil
	}
	if writingReviewDeepContextEncodedBytes(context) > agentReviewDeepContextBytes {
		context.Summary = ""
	}
	return context
}

func writingReviewDeepContextEncodedBytes(context writingReviewDeepContext) int {
	encoded, err := json.Marshal(context)
	if err != nil {
		return agentReviewDeepContextBytes + 1
	}
	return len(encoded)
}

func writingReviewDeepContextSuggestions(
	suggestions []agentReviewSuggestionView,
	focusDimension string,
) []agentReviewSuggestionView {
	layout := make([]agentReviewSuggestionView, 0)
	content := make([]agentReviewSuggestionView, 0)
	for _, suggestion := range suggestions {
		if !writingReviewSuggestionSupportsDimension(suggestion, focusDimension) {
			continue
		}
		if suggestion.Kind == "layout" {
			layout = append(layout, suggestion)
		} else {
			content = append(content, suggestion)
		}
	}
	ordered := make([]agentReviewSuggestionView, 0, len(layout)+len(content))
	for index := 0; index < max(len(layout), len(content)); index++ {
		if index < len(layout) {
			ordered = append(ordered, layout[index])
		}
		if index < len(content) {
			ordered = append(ordered, content[index])
		}
	}
	return ordered
}

func writingReviewSuggestionSupportsDimension(suggestion agentReviewSuggestionView, focusDimension string) bool {
	if suggestion.Kind == "layout" {
		return suggestion.Category == focusDimension
	}
	if suggestion.Kind != "content" || suggestion.Target != "body" {
		return false
	}
	if suggestion.Category == focusDimension {
		return true
	}
	for _, category := range writingReviewDimensionBodyCategories[focusDimension] {
		if suggestion.Category == category {
			return true
		}
	}
	return false
}

var writingReviewDimensionBodyCategories = map[string][]string{
	"hierarchy":   {"structure"},
	"readability": {"clarity", "style"},
	"emphasis":    {"engagement", "conversion", "structure"},
	"rhythm":      {"style", "clarity"},
	"modules":     {"structure"},
	"mobile":      {"clarity", "structure", "style"},
}

func (a *App) runAgentReview(
	userID int,
	reviewDatabaseID int64,
	reviewID string,
	document agentReviewDocument,
	provider agentLLMProvider,
	reservationID string,
	plan writingReviewTaskPlan,
) {
	defer func() {
		if recovered := recover(); recovered != nil {
			a.failAgentReview(context.Background(), userID, reviewDatabaseID, "server_error", reservationID)
			log.Printf("agent review panic review=%s: %v", reviewID, recovered)
		}
	}()

	requestCtx, cancel := context.WithTimeout(context.Background(), agentReviewRunLimit)
	progress := newAgentReviewTaskProgress(plan)
	result, validated, callErr := executeWritingReviewTaskPlan(
		requestCtx,
		a.agentLLMHTTPClient,
		provider,
		plan,
		document.Title,
		document.Content,
		func(tasks []writingReviewTaskSpec) error {
			progress.start(tasks)
			persistCtx, persistCancel := context.WithTimeout(context.Background(), agentReviewFinalizeLimit)
			defer persistCancel()
			if err := a.storeAgentReviewTaskProgress(
				persistCtx, userID, reviewDatabaseID, progress,
			); err != nil {
				return fmt.Errorf("%w: store task progress: %w", errAgentReviewPersistence, err)
			}
			return nil
		},
		func(outcome writingReviewTaskOutcome) error {
			progress.record(outcome)
			persistCtx, persistCancel := context.WithTimeout(context.Background(), agentReviewFinalizeLimit)
			defer persistCancel()
			if err := a.storeAgentReviewTaskOutcome(
				persistCtx, userID, reviewDatabaseID, progress, outcome,
			); err != nil {
				return fmt.Errorf("%w: store task outcome: %w", errAgentReviewPersistence, err)
			}
			return nil
		},
	)
	cancel()
	if callErr != nil {
		errorCode := classifyAgentReviewFailure(callErr)
		a.failAgentReview(context.Background(), userID, reviewDatabaseID, errorCode, reservationID)
		log.Printf("agent review execution failed review=%s code=%s: %v", reviewID, errorCode, callErr)
		return
	}

	finalizeCtx, finalizeCancel := context.WithTimeout(context.Background(), agentReviewFinalizeLimit)
	_, err := a.finalizeAgentReview(
		finalizeCtx,
		userID,
		reviewDatabaseID,
		reviewID,
		document,
		provider,
		reservationID,
		result,
		validated,
	)
	finalizeCancel()
	if err != nil {
		errorCode := "finalize_failed"
		if errors.Is(err, errInsufficientCredits) {
			errorCode = "insufficient_credits"
		}
		a.failAgentReview(context.Background(), userID, reviewDatabaseID, errorCode, reservationID)
		log.Printf("agent review finalize review=%s: %v", reviewID, err)
	}
}

func generateValidatedWritingReview(
	ctx context.Context,
	httpClient *http.Client,
	provider agentLLMProvider,
	prompt agentLLMPrompt,
	title string,
	content string,
) (agentLLMResult, validatedWritingReview, error) {
	result, err := callAgentLLM(ctx, httpClient, provider, prompt)
	if err != nil {
		return agentLLMResult{}, validatedWritingReview{}, err
	}
	if err := requireAgentLLMUsage(provider, result); err != nil {
		return agentLLMResult{}, validatedWritingReview{}, err
	}
	validated, validationErr := parseAndValidateWritingReview(result.JSON, title, content)
	if validationErr == nil {
		return result, validated, nil
	}
	if !errors.Is(validationErr, errAgentLLMInvalidResponse) {
		return agentLLMResult{}, validatedWritingReview{}, validationErr
	}

	retryPrompt := prompt
	retryPrompt.User += "\n\nYour previous response was rejected by the review validator. " +
		"Generate the complete review again as valid JSON. Do not mention this retry. " +
		"Validator feedback: " + validationErr.Error()
	retryResult, err := callAgentLLM(ctx, httpClient, provider, retryPrompt)
	if err != nil {
		return agentLLMResult{}, validatedWritingReview{}, err
	}
	if err := requireAgentLLMUsage(provider, retryResult); err != nil {
		return agentLLMResult{}, validatedWritingReview{}, err
	}
	if err := addAgentLLMUsage(&retryResult, result); err != nil {
		return agentLLMResult{}, validatedWritingReview{}, err
	}
	validated, err = parseAndValidateWritingReview(retryResult.JSON, title, content)
	if err != nil {
		return agentLLMResult{}, validatedWritingReview{}, err
	}
	return retryResult, validated, nil
}

func addAgentLLMUsage(target *agentLLMResult, previous agentLLMResult) error {
	maximumInt := int(^uint(0) >> 1)
	if target.InputTokens > maximumInt-previous.InputTokens ||
		target.OutputTokens > maximumInt-previous.OutputTokens ||
		target.TotalTokens > maximumInt-previous.TotalTokens {
		return errAgentLLMUsageInvalid
	}
	target.InputTokens += previous.InputTokens
	target.OutputTokens += previous.OutputTokens
	target.TotalTokens += previous.TotalTokens
	return nil
}

func (a *App) expireStaleAgentReviews(ctx context.Context, userID int) error {
	_, err := a.db.Exec(
		ctx,
		expireStaleAgentReviewsSQL,
		userID,
		time.Now().UTC().Add(-agentReviewStaleAfter),
	)
	return err
}

func (a *App) expireStaleAgentReview(ctx context.Context, userID int, reviewID string) error {
	_, err := a.db.Exec(
		ctx,
		expireStaleAgentReviewSQL,
		strings.TrimSpace(reviewID),
		userID,
		time.Now().UTC().Add(-agentReviewStaleAfter),
	)
	return err
}

func (a *App) agentReviewsList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if err := a.expireStaleAgentReviews(r.Context(), user.ID); err != nil {
		log.Printf("agent review list expire stale: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	docID := strings.TrimSpace(r.PathValue("docId"))
	var documentExists bool
	if err := a.db.QueryRow(r.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM documents
			WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
		)
	`, docID, user.ID).Scan(&documentExists); err != nil {
		log.Printf("agent review list document: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if !documentExists {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT review.review_id
		FROM agent_reviews review
		JOIN documents document ON document.id = review.document_id
		WHERE review.user_id = $1 AND document.doc_id = $2
		ORDER BY review.created_at DESC
		LIMIT $3
	`, user.ID, docID, agentReviewListLimit)
	if err != nil {
		log.Printf("agent review list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var reviewIDs []string
	for rows.Next() {
		var reviewID string
		if err := rows.Scan(&reviewID); err != nil {
			rows.Close()
			log.Printf("agent review list scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		reviewIDs = append(reviewIDs, reviewID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		log.Printf("agent review list rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	rows.Close()

	reviews := make([]agentReviewView, 0, len(reviewIDs))
	for _, reviewID := range reviewIDs {
		review, err := a.loadAgentReview(r.Context(), user.ID, reviewID, false)
		if err != nil {
			log.Printf("agent review list detail: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		reviews = append(reviews, review)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"reviews": reviews})
}

func (a *App) agentReviewGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	reviewID := r.PathValue("reviewId")
	review, err := a.loadAgentReview(r.Context(), user.ID, reviewID, true)
	if errors.Is(err, errAgentReviewNotFound) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Agent review not found")
		return
	}
	if err != nil {
		log.Printf("agent review get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if review.Status == "running" && review.CreatedAt.Before(time.Now().UTC().Add(-agentReviewStaleAfter)) {
		if err := a.expireStaleAgentReview(r.Context(), user.ID, reviewID); err != nil {
			log.Printf("agent review get expire stale: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		review, err = a.loadAgentReview(r.Context(), user.ID, reviewID, true)
		if err != nil {
			log.Printf("agent review get expired result: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"review": review})
}

func (a *App) agentReviewSuggestionApply(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	expectedRevision, ok := decodeAgentReviewExpectedRevision(w, r)
	if !ok {
		return
	}
	result, err := a.applyAgentReviewSuggestion(
		r.Context(), user, r.PathValue("reviewId"), r.PathValue("suggestionId"), expectedRevision,
	)
	if err != nil {
		a.writeAgentReviewMutationError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"review":   result.Review,
		"document": result.Document,
	})
}

func (a *App) agentReviewApplyAll(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	expectedRevision, ok := decodeAgentReviewExpectedRevision(w, r)
	if !ok {
		return
	}
	result, err := a.applyAllAgentReviewSuggestions(
		r.Context(), user, r.PathValue("reviewId"), expectedRevision,
	)
	if err != nil {
		a.writeAgentReviewMutationError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"review":   result.Review,
		"document": result.Document,
	})
}

func (a *App) agentReviewSuggestionDismiss(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	review, err := a.dismissAgentReviewSuggestion(
		r.Context(), user.ID, r.PathValue("reviewId"), r.PathValue("suggestionId"),
	)
	if err != nil {
		a.writeAgentReviewMutationError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"review": review})
}

func (a *App) agentReviewDismiss(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	review, err := a.dismissAgentReview(r.Context(), user.ID, r.PathValue("reviewId"))
	if err != nil {
		a.writeAgentReviewMutationError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"review": review})
}

func decodeAgentReviewExpectedRevision(w http.ResponseWriter, r *http.Request) (int64, bool) {
	var input struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, agentReviewRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.ExpectedRevision <= 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "A positive expectedRevision is required")
		return 0, false
	}
	return input.ExpectedRevision, true
}

func (a *App) loadAgentReviewDocument(ctx context.Context, userID int, docID string) (agentReviewDocument, error) {
	var document agentReviewDocument
	err := a.db.QueryRow(ctx, `
		SELECT id, doc_id, title, theme, content, revision, created_at, updated_at
		FROM documents
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
	`, strings.TrimSpace(docID), userID).Scan(
		&document.DatabaseID,
		&document.DocID,
		&document.Title,
		&document.Theme,
		&document.Content,
		&document.Revision,
		&document.CreatedAt,
		&document.UpdatedAt,
	)
	return document, err
}

func (a *App) resolveAgentLLMProvider(
	ctx context.Context,
	user model.User,
	mode string,
	channelID string,
) (agentLLMProvider, *int64, error) {
	if mode == "builtin" {
		if !a.cfg.AgentLLMEnabled() {
			return agentLLMProvider{}, nil, errors.New("built-in agent LLM is not configured")
		}
		return agentLLMProvider{
			Mode:         "builtin",
			Protocol:     a.cfg.AgentLLMProtocol,
			BaseURL:      a.cfg.AgentLLMBaseURL,
			APIKey:       a.cfg.AgentLLMAPIKey,
			Model:        a.cfg.AgentLLMModel,
			StrictOutput: a.cfg.AgentLLMProtocol == "openai",
			SafeEndpoint: false,
		}, nil, nil
	}
	channel, err := a.loadLLMChannelCredential(ctx, user.ID, channelID)
	if err != nil {
		return agentLLMProvider{}, nil, err
	}
	return agentLLMProvider{
		Mode:         "byok",
		Protocol:     channel.Protocol,
		BaseURL:      channel.BaseURL,
		APIKey:       channel.APIKey,
		Model:        channel.Model,
		StrictOutput: false,
		SafeEndpoint: true,
	}, &channel.DatabaseID, nil
}

func (a *App) insertRunningAgentReview(
	ctx context.Context,
	userID int,
	document agentReviewDocument,
	reviewID string,
	provider agentLLMProvider,
	channelDatabaseID *int64,
	progress agentReviewTaskProgress,
) (int64, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return 0, err
	}
	// A process crash can leave the external LLM call without a handler to
	// mark its row failed. Reclaim those orphaned slots once their matching
	// credit reservation could no longer be active.
	if _, err := tx.Exec(
		ctx,
		expireStaleAgentReviewsSQL,
		userID,
		time.Now().UTC().Add(-agentReviewStaleAfter),
	); err != nil {
		return 0, err
	}
	var running int
	var sameDocumentRevisionRunning bool
	if err := tx.QueryRow(ctx, `
		SELECT count(*), COALESCE(bool_or(document_id = $2 AND base_revision = $3), false)
		FROM agent_reviews
		WHERE user_id = $1 AND status = 'running'
	`, userID, document.DatabaseID, document.Revision).Scan(&running, &sameDocumentRevisionRunning); err != nil {
		return 0, err
	}
	if sameDocumentRevisionRunning || running >= agentReviewMaxRunning {
		return 0, errAgentReviewClosed
	}
	progressJSON, err := json.Marshal(progress)
	if err != nil {
		return 0, err
	}
	var databaseID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO agent_reviews (
			review_id, user_id, document_id, base_revision, current_revision,
			provider_mode, provider_protocol, channel_id, model, status, task_progress
		)
		VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, 'running', $9::jsonb)
		RETURNING id
	`, reviewID, userID, document.DatabaseID, document.Revision, provider.Mode,
		provider.Protocol, channelDatabaseID, provider.Model, string(progressJSON)).Scan(&databaseID); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return databaseID, nil
}

func estimateAgentReviewReservation(prompt agentLLMPrompt) int64 {
	// BPE token count cannot exceed the UTF-8 byte count by more than small
	// message framing overhead. Reserving bytes is intentionally conservative;
	// only provider-reported usage is charged after a successful call.
	credits := creditsForTokens(agentReviewPromptTokenUpperBound(prompt))
	if credits < 1 {
		return 1
	}
	return credits
}

func agentReviewPromptTokenUpperBound(prompt agentLLMPrompt) int {
	schemaBytes, _ := json.Marshal(prompt.Schema)
	return len(prompt.System) + len(prompt.User) + len(schemaBytes) +
		agentLLMPromptOutputLimit(prompt, agentLLMMaxOutputTokens) + 512
}

func estimateAgentReviewPlanReservation(plan writingReviewTaskPlan) int64 {
	totalTokens := 0
	for _, task := range plan.Tasks {
		totalTokens += agentReviewPromptTokenUpperBound(task.Prompt)
		if task.WantsPriorFindings {
			// 首轮诊断是执行时才拼进提示词的，预留时提示词里还没有它
			totalTokens += agentReviewPriorFindingsTokens
		}
	}
	return max(1, creditsForTokens(totalTokens))
}

func newAgentReviewTaskProgress(plan writingReviewTaskPlan) agentReviewTaskProgress {
	progress := agentReviewTaskProgress{
		Mode: plan.Mode, FocusDimension: plan.FocusDimension, TotalTasks: len(plan.Tasks),
	}
	for _, stage := range []agentReviewTaskStage{
		agentReviewTaskTitle, agentReviewTaskLayout, agentReviewTaskDocument, agentReviewTaskBody,
	} {
		total := 0
		for _, task := range plan.Tasks {
			if task.Stage == stage {
				total++
			}
		}
		if total > 0 {
			progress.Stages = append(progress.Stages, agentReviewStageProgress{
				ID: stage, Status: "pending", TotalTasks: total,
			})
		}
	}
	return progress
}

func (progress *agentReviewTaskProgress) start(tasks []writingReviewTaskSpec) {
	stages := make(map[agentReviewTaskStage]struct{}, len(tasks))
	for _, task := range tasks {
		stages[task.Stage] = struct{}{}
	}
	for index := range progress.Stages {
		stage := &progress.Stages[index]
		if _, ok := stages[stage.ID]; ok && stage.Status == "pending" {
			stage.Status = "running"
		}
	}
}

func (progress *agentReviewTaskProgress) record(outcome writingReviewTaskOutcome) {
	for index := range progress.Stages {
		stage := &progress.Stages[index]
		if stage.ID != outcome.Result.Task.Stage {
			continue
		}
		stage.DurationMS += max(0, outcome.Result.Duration.Milliseconds())
		if outcome.Err != nil {
			stage.Status = "failed"
			return
		}
		stage.CompletedTasks++
		progress.CompletedTasks++
		if stage.CompletedTasks >= stage.TotalTasks {
			stage.Status = "completed"
		} else {
			stage.Status = "running"
		}
		return
	}
}

func (a *App) storeAgentReviewTaskProgress(
	ctx context.Context,
	userID int,
	reviewDatabaseID int64,
	progress agentReviewTaskProgress,
) error {
	progressJSON, err := json.Marshal(progress)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(ctx, `
		UPDATE agent_reviews
		SET task_progress = $3::jsonb, updated_at = now()
		WHERE id = $1 AND user_id = $2 AND status = 'running'
	`, reviewDatabaseID, userID, string(progressJSON))
	return err
}

func (a *App) storeAgentReviewTaskOutcome(
	ctx context.Context,
	userID int,
	reviewDatabaseID int64,
	progress agentReviewTaskProgress,
	outcome writingReviewTaskOutcome,
) error {
	if outcome.Err != nil {
		return a.storeAgentReviewTaskProgress(ctx, userID, reviewDatabaseID, progress)
	}
	prepared := make([]preparedAgentReviewSuggestion, 0, len(outcome.Result.Validated.Suggestions))
	for _, suggestion := range outcome.Result.Validated.Suggestions {
		suggestionID, err := randomUUID()
		if err != nil {
			return err
		}
		prepared = append(prepared, preparedAgentReviewSuggestion{
			ID: suggestionID, validatedWritingSuggestion: suggestion,
		})
	}
	progressJSON, err := json.Marshal(progress)
	if err != nil {
		return err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	command, err := tx.Exec(ctx, `
		UPDATE agent_reviews
		SET task_progress = $3::jsonb, updated_at = now()
		WHERE id = $1 AND user_id = $2 AND status = 'running'
	`, reviewDatabaseID, userID, string(progressJSON))
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return fmt.Errorf("agent review is no longer running")
	}
	switch outcome.Result.Task.Stage {
	case agentReviewTaskTitle:
		if _, err := tx.Exec(ctx, `
			UPDATE agent_reviews
			SET summary = $2, title_score = $3, title_assessment = $4
			WHERE id = $1
		`, reviewDatabaseID, outcome.Result.Validated.Summary,
			outcome.Result.Validated.TitleScore, outcome.Result.Validated.TitleAssessment); err != nil {
			return err
		}
	case agentReviewTaskLayout:
		assessmentJSON, err := json.Marshal(outcome.Result.Validated.LayoutAssessment)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE agent_reviews SET layout_assessment = $2::jsonb WHERE id = $1
		`, reviewDatabaseID, string(assessmentJSON)); err != nil {
			return err
		}
	}
	for index, suggestion := range prepared {
		var operation any
		if suggestion.Operation != "" {
			operation = suggestion.Operation
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_review_suggestions (
				suggestion_id, review_id, ordinal, target, suggestion_kind,
				category, operation, before_text, after_text, reason
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		`, suggestion.ID, reviewDatabaseID, outcome.Result.Task.OrdinalBase+index,
			suggestion.Target, suggestion.Kind, suggestion.Category, operation,
			suggestion.Before, suggestion.After, suggestion.Reason); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (a *App) finalizeAgentReview(
	ctx context.Context,
	userID int,
	reviewDatabaseID int64,
	reviewID string,
	document agentReviewDocument,
	provider agentLLMProvider,
	reservationID string,
	result agentLLMResult,
	validated validatedWritingReview,
) (agentReviewView, error) {
	prepared := make([]preparedAgentReviewSuggestion, 0, len(validated.Suggestions))
	for _, suggestion := range validated.Suggestions {
		suggestionID, err := randomUUID()
		if err != nil {
			return agentReviewView{}, err
		}
		prepared = append(prepared, preparedAgentReviewSuggestion{ID: suggestionID, validatedWritingSuggestion: suggestion})
	}

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return agentReviewView{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	var storedStatus string
	var documentRevision int64
	if err := tx.QueryRow(ctx, `
		SELECT review.status, current_document.revision
		FROM agent_reviews review
		JOIN documents current_document ON current_document.id = review.document_id
		WHERE review.id = $1 AND review.user_id = $2
		FOR UPDATE OF review, current_document
	`, reviewDatabaseID, userID).Scan(&storedStatus, &documentRevision); err != nil {
		return agentReviewView{}, err
	}
	if storedStatus != "running" {
		return agentReviewView{}, fmt.Errorf("review is no longer running")
	}

	creditsCharged := int64(0)
	if provider.Mode == "builtin" {
		_, creditsCharged, err = commitCreditReservationTx(
			ctx,
			tx,
			userID,
			reservationID,
			result.TotalTokens,
			map[string]any{
				"reviewId": reviewID,
				"protocol": provider.Protocol,
				"model":    provider.Model,
			},
		)
		if err != nil {
			return agentReviewView{}, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM agent_review_suggestions WHERE review_id = $1`, reviewDatabaseID); err != nil {
		return agentReviewView{}, err
	}
	for ordinal, suggestion := range prepared {
		var operation any
		if suggestion.Operation != "" {
			operation = suggestion.Operation
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_review_suggestions (
				suggestion_id, review_id, ordinal, target, suggestion_kind,
				category, operation, before_text, after_text, reason
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		`, suggestion.ID, reviewDatabaseID, ordinal, suggestion.Target, suggestion.Kind,
			suggestion.Category, operation, suggestion.Before, suggestion.After, suggestion.Reason); err != nil {
			return agentReviewView{}, err
		}
	}
	layoutAssessmentJSON, err := json.Marshal(validated.LayoutAssessment)
	if err != nil {
		return agentReviewView{}, err
	}
	status := "ready"
	if documentRevision != document.Revision {
		status = "stale"
	}
	var titleScore any
	var titleAssessment any
	if validated.HasTitleReview {
		titleScore = validated.TitleScore
		titleAssessment = validated.TitleAssessment
	}
	if _, err := tx.Exec(ctx, `
		UPDATE agent_reviews
		SET status = $2,
		    summary = $3,
		    title_score = $4,
		    title_assessment = $5,
		    layout_assessment = $6::jsonb,
		    input_tokens = $7,
		    output_tokens = $8,
		    total_tokens = $9,
		    credits_charged = $10,
		    completed_at = now(),
		    updated_at = now()
		WHERE id = $1
	`, reviewDatabaseID, status, validated.Summary, titleScore,
		titleAssessment, string(layoutAssessmentJSON), result.InputTokens, result.OutputTokens,
		result.TotalTokens, creditsCharged); err != nil {
		return agentReviewView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return agentReviewView{}, err
	}
	return a.loadAgentReview(ctx, userID, reviewID, true)
}

func (a *App) failAgentReview(
	ctx context.Context,
	userID int,
	reviewDatabaseID int64,
	errorCode string,
	reservationID string,
) {
	cleanupCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if reservationID != "" {
		if _, err := a.releaseCreditReservation(cleanupCtx, userID, reservationID); err != nil &&
			!errors.Is(err, errCreditReservationNotFound) {
			log.Printf("agent review release reservation: %v", err)
		}
	}
	if _, err := a.db.Exec(cleanupCtx, `
		WITH failed AS (
			UPDATE agent_reviews
			SET status = 'failed', error_code = $2, completed_at = now(), updated_at = now()
			WHERE id = $1 AND user_id = $3 AND status = 'running'
			RETURNING id
		)
		DELETE FROM agent_review_suggestions suggestion
		USING failed
		WHERE suggestion.review_id = failed.id
	`, reviewDatabaseID, errorCode, userID); err != nil {
		log.Printf("agent review mark failed: %v", err)
	}
}

func (a *App) loadAgentReview(
	ctx context.Context,
	userID int,
	reviewID string,
	includeSuggestions bool,
) (agentReviewView, error) {
	var review agentReviewView
	var layoutAssessmentJSON []byte
	var taskProgressJSON []byte
	err := a.db.QueryRow(ctx, `
		SELECT review.review_id, document.doc_id, review.base_revision,
		       review.current_revision, document.revision, review.provider_mode,
		       review.provider_protocol, channel.channel_id, review.model,
		       review.status, review.summary, review.title_score,
		       review.title_assessment, review.layout_assessment, review.task_progress,
		       review.input_tokens, review.output_tokens,
		       review.total_tokens, review.credits_charged, review.error_code,
		       review.created_at, review.completed_at, review.updated_at
		FROM agent_reviews review
		JOIN documents document ON document.id = review.document_id
		LEFT JOIN llm_channels channel ON channel.id = review.channel_id
		WHERE review.review_id = $1 AND review.user_id = $2
	`, strings.TrimSpace(reviewID), userID).Scan(
		&review.ReviewID,
		&review.DocumentID,
		&review.BaseRevision,
		&review.CurrentRevision,
		&review.DocumentRevision,
		&review.ProviderMode,
		&review.ProviderProtocol,
		&review.ChannelID,
		&review.Model,
		&review.Status,
		&review.Summary,
		&review.TitleScore,
		&review.TitleAssessment,
		&layoutAssessmentJSON,
		&taskProgressJSON,
		&review.InputTokens,
		&review.OutputTokens,
		&review.TotalTokens,
		&review.CreditsCharged,
		&review.ErrorCode,
		&review.CreatedAt,
		&review.CompletedAt,
		&review.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return agentReviewView{}, errAgentReviewNotFound
	}
	if err != nil {
		return agentReviewView{}, err
	}
	if err := json.Unmarshal(layoutAssessmentJSON, &review.LayoutAssessment); err != nil {
		return agentReviewView{}, fmt.Errorf("decode agent layout assessment: %w", err)
	}
	if review.LayoutAssessment == nil {
		review.LayoutAssessment = make([]writingReviewDimension, 0)
	}
	if err := json.Unmarshal(taskProgressJSON, &review.TaskProgress); err != nil {
		return agentReviewView{}, fmt.Errorf("decode agent review task progress: %w", err)
	}
	if review.TaskProgress.Stages == nil {
		review.TaskProgress.Stages = make([]agentReviewStageProgress, 0)
	}
	if (review.Status == "ready" || review.Status == "partially_applied") &&
		review.DocumentRevision != review.CurrentRevision {
		review.Status = "stale"
	}
	if !includeSuggestions {
		return review, nil
	}

	rows, err := a.db.Query(ctx, `
		SELECT suggestion.suggestion_id, suggestion.ordinal, suggestion.target,
		       suggestion.suggestion_kind, suggestion.category, suggestion.operation,
		       suggestion.before_text, suggestion.after_text,
		       suggestion.reason, suggestion.status, suggestion.applied_at
		FROM agent_review_suggestions suggestion
		JOIN agent_reviews review ON review.id = suggestion.review_id
		WHERE review.review_id = $1 AND review.user_id = $2
		ORDER BY suggestion.ordinal
	`, review.ReviewID, userID)
	if err != nil {
		return agentReviewView{}, err
	}
	defer rows.Close()
	review.Suggestions = make([]agentReviewSuggestionView, 0)
	for rows.Next() {
		var suggestion agentReviewSuggestionView
		if err := rows.Scan(
			&suggestion.SuggestionID,
			&suggestion.Ordinal,
			&suggestion.Target,
			&suggestion.Kind,
			&suggestion.Category,
			&suggestion.Operation,
			&suggestion.Before,
			&suggestion.After,
			&suggestion.Reason,
			&suggestion.Status,
			&suggestion.AppliedAt,
		); err != nil {
			return agentReviewView{}, err
		}
		review.Suggestions = append(review.Suggestions, suggestion)
	}
	if err := rows.Err(); err != nil {
		return agentReviewView{}, err
	}
	return review, nil
}

func (a *App) applyAgentReviewSuggestion(
	ctx context.Context,
	user model.User,
	reviewID string,
	suggestionID string,
	expectedRevision int64,
) (agentReviewMutationResult, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return agentReviewMutationResult{}, err
	}
	locked, err := lockAgentReview(ctx, tx, user.ID, reviewID)
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	suggestion, err := lockAgentSuggestion(ctx, tx, locked.DatabaseID, suggestionID)
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	if suggestion.Status == "applied" {
		if err := tx.Commit(ctx); err != nil {
			return agentReviewMutationResult{}, err
		}
		return a.loadAgentReviewMutationResult(ctx, user.ID, reviewID, locked.Document)
	}
	if suggestion.Status != "pending" {
		return agentReviewMutationResult{}, errAgentSuggestionClosed
	}
	if err := validateAgentReviewForApply(locked, expectedRevision); err != nil {
		if errors.Is(err, errAgentReviewStale) {
			return agentReviewMutationResult{}, markAgentReviewStaleAndCommit(ctx, tx, locked.DatabaseID)
		}
		return agentReviewMutationResult{}, err
	}

	nextTitle, nextContent, err := applyLockedAgentSuggestion(locked.Document, suggestion)
	if err != nil {
		return agentReviewMutationResult{}, markAgentReviewStaleAndCommit(ctx, tx, locked.DatabaseID)
	}
	updateResult, err := a.updateDocumentTx(ctx, tx, updateDocumentParams{
		User:             user,
		DocID:            locked.Document.DocID,
		Title:            nextTitle,
		Theme:            locked.Document.Theme,
		Content:          nextContent,
		ExpectedRevision: locked.Document.Revision,
		Source:           documentSourceAgent,
	})
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE agent_review_suggestions
		SET status = 'applied', applied_at = now()
		WHERE suggestion_id = $1 AND review_id = $2 AND status = 'pending'
	`, suggestion.SuggestionID, locked.DatabaseID); err != nil {
		return agentReviewMutationResult{}, err
	}
	if suggestion.Target == "title" {
		if _, err := tx.Exec(ctx, `
			UPDATE agent_review_suggestions
			SET status = 'dismissed'
			WHERE review_id = $1 AND target = 'title' AND status = 'pending'
		`, locked.DatabaseID); err != nil {
			return agentReviewMutationResult{}, err
		}
	}
	status, err := resolvedAgentReviewStatus(ctx, tx, locked.DatabaseID, false)
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE agent_reviews
		SET current_revision = $2, status = $3, updated_at = now()
		WHERE id = $1
	`, locked.DatabaseID, updateResult.Document.Revision, status); err != nil {
		return agentReviewMutationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return agentReviewMutationResult{}, err
	}
	a.finishDocumentUpdate(ctx, user, updateResult)
	return a.loadAgentReviewMutationResult(
		ctx, user.ID, reviewID, agentReviewDocumentFromModel(locked.Document.DatabaseID, updateResult.Document),
	)
}

func (a *App) applyAllAgentReviewSuggestions(
	ctx context.Context,
	user model.User,
	reviewID string,
	expectedRevision int64,
) (agentReviewMutationResult, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return agentReviewMutationResult{}, err
	}
	locked, err := lockAgentReview(ctx, tx, user.ID, reviewID)
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	suggestions, err := lockPendingAgentSuggestions(ctx, tx, locked.DatabaseID)
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	if len(suggestions) == 0 && locked.Status == "applied" {
		if err := tx.Commit(ctx); err != nil {
			return agentReviewMutationResult{}, err
		}
		return a.loadAgentReviewMutationResult(ctx, user.ID, reviewID, locked.Document)
	}
	if err := validateAgentReviewForApply(locked, expectedRevision); err != nil {
		if errors.Is(err, errAgentReviewStale) {
			return agentReviewMutationResult{}, markAgentReviewStaleAndCommit(ctx, tx, locked.DatabaseID)
		}
		return agentReviewMutationResult{}, err
	}
	if len(suggestions) == 0 {
		return agentReviewMutationResult{}, errAgentReviewClosed
	}

	nextTitle, nextContent, appliedIDs, dismissedTitleIDs, err := applyAllLockedAgentSuggestions(
		locked.Document, suggestions,
	)
	if err != nil {
		return agentReviewMutationResult{}, markAgentReviewStaleAndCommit(ctx, tx, locked.DatabaseID)
	}
	updateResult, err := a.updateDocumentTx(ctx, tx, updateDocumentParams{
		User:             user,
		DocID:            locked.Document.DocID,
		Title:            nextTitle,
		Theme:            locked.Document.Theme,
		Content:          nextContent,
		ExpectedRevision: locked.Document.Revision,
		Source:           documentSourceAgent,
	})
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	for _, id := range appliedIDs {
		if _, err := tx.Exec(ctx, `
			UPDATE agent_review_suggestions
			SET status = 'applied', applied_at = now()
			WHERE suggestion_id = $1 AND review_id = $2 AND status = 'pending'
		`, id, locked.DatabaseID); err != nil {
			return agentReviewMutationResult{}, err
		}
	}
	for _, id := range dismissedTitleIDs {
		if _, err := tx.Exec(ctx, `
			UPDATE agent_review_suggestions
			SET status = 'dismissed'
			WHERE suggestion_id = $1 AND review_id = $2 AND status = 'pending'
		`, id, locked.DatabaseID); err != nil {
			return agentReviewMutationResult{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE agent_reviews
		SET current_revision = $2, status = 'applied', updated_at = now()
		WHERE id = $1
	`, locked.DatabaseID, updateResult.Document.Revision); err != nil {
		return agentReviewMutationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return agentReviewMutationResult{}, err
	}
	a.finishDocumentUpdate(ctx, user, updateResult)
	return a.loadAgentReviewMutationResult(
		ctx, user.ID, reviewID, agentReviewDocumentFromModel(locked.Document.DatabaseID, updateResult.Document),
	)
}

func (a *App) dismissAgentReviewSuggestion(
	ctx context.Context,
	userID int,
	reviewID string,
	suggestionID string,
) (agentReviewView, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return agentReviewView{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return agentReviewView{}, err
	}
	locked, err := lockAgentReview(ctx, tx, userID, reviewID)
	if err != nil {
		return agentReviewView{}, err
	}
	suggestion, err := lockAgentSuggestion(ctx, tx, locked.DatabaseID, suggestionID)
	if err != nil {
		return agentReviewView{}, err
	}
	if suggestion.Status == "applied" {
		return agentReviewView{}, errAgentSuggestionClosed
	}
	if suggestion.Status == "pending" {
		if locked.Status == "running" || locked.Status == "failed" || locked.Status == "dismissed" || locked.Status == "applied" {
			return agentReviewView{}, errAgentReviewClosed
		}
		if _, err := tx.Exec(ctx, `
			UPDATE agent_review_suggestions SET status = 'dismissed'
			WHERE suggestion_id = $1 AND review_id = $2 AND status = 'pending'
		`, suggestion.SuggestionID, locked.DatabaseID); err != nil {
			return agentReviewView{}, err
		}
	}
	stale := locked.Status == "stale" || locked.Document.Revision != locked.CurrentRevision
	status, err := resolvedAgentReviewStatus(ctx, tx, locked.DatabaseID, stale)
	if err != nil {
		return agentReviewView{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE agent_reviews SET status = $2, updated_at = now() WHERE id = $1
	`, locked.DatabaseID, status); err != nil {
		return agentReviewView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return agentReviewView{}, err
	}
	return a.loadAgentReview(ctx, userID, reviewID, true)
}

func (a *App) dismissAgentReview(ctx context.Context, userID int, reviewID string) (agentReviewView, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return agentReviewView{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return agentReviewView{}, err
	}
	locked, err := lockAgentReview(ctx, tx, userID, reviewID)
	if err != nil {
		return agentReviewView{}, err
	}
	if locked.Status == "running" || locked.Status == "failed" {
		return agentReviewView{}, errAgentReviewClosed
	}
	if locked.Status == "applied" {
		if err := tx.Commit(ctx); err != nil {
			return agentReviewView{}, err
		}
		return a.loadAgentReview(ctx, userID, reviewID, true)
	}
	if locked.Status != "dismissed" {
		if _, err := tx.Exec(ctx, `
			UPDATE agent_review_suggestions
			SET status = 'dismissed'
			WHERE review_id = $1 AND status = 'pending'
		`, locked.DatabaseID); err != nil {
			return agentReviewView{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE agent_reviews SET status = 'dismissed', updated_at = now() WHERE id = $1
		`, locked.DatabaseID); err != nil {
			return agentReviewView{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return agentReviewView{}, err
	}
	return a.loadAgentReview(ctx, userID, reviewID, true)
}

func lockAgentReview(ctx context.Context, tx pgx.Tx, userID int, reviewID string) (lockedAgentReview, error) {
	var locked lockedAgentReview
	err := tx.QueryRow(ctx, `
		SELECT review.id, review.status, review.current_revision,
		       document.id, document.doc_id, document.title, document.theme,
		       document.content, document.revision, document.created_at, document.updated_at
		FROM agent_reviews review
		JOIN documents document ON document.id = review.document_id
		WHERE review.review_id = $1 AND review.user_id = $2 AND document.trashed_at IS NULL
		FOR UPDATE OF review, document
	`, strings.TrimSpace(reviewID), userID).Scan(
		&locked.DatabaseID,
		&locked.Status,
		&locked.CurrentRevision,
		&locked.Document.DatabaseID,
		&locked.Document.DocID,
		&locked.Document.Title,
		&locked.Document.Theme,
		&locked.Document.Content,
		&locked.Document.Revision,
		&locked.Document.CreatedAt,
		&locked.Document.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedAgentReview{}, errAgentReviewNotFound
	}
	return locked, err
}

func lockAgentSuggestion(
	ctx context.Context,
	tx pgx.Tx,
	reviewDatabaseID int64,
	suggestionID string,
) (lockedAgentSuggestion, error) {
	var suggestion lockedAgentSuggestion
	err := tx.QueryRow(ctx, `
		SELECT suggestion_id, ordinal, target, suggestion_kind,
		       COALESCE(operation, ''), before_text, after_text, status
		FROM agent_review_suggestions
		WHERE review_id = $1 AND suggestion_id = $2
		FOR UPDATE
	`, reviewDatabaseID, strings.TrimSpace(suggestionID)).Scan(
		&suggestion.SuggestionID,
		&suggestion.Ordinal,
		&suggestion.Target,
		&suggestion.Kind,
		&suggestion.Operation,
		&suggestion.Before,
		&suggestion.After,
		&suggestion.Status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedAgentSuggestion{}, errAgentSuggestionNotFound
	}
	return suggestion, err
}

func lockPendingAgentSuggestions(ctx context.Context, tx pgx.Tx, reviewDatabaseID int64) ([]lockedAgentSuggestion, error) {
	rows, err := tx.Query(ctx, `
		SELECT suggestion_id, ordinal, target, suggestion_kind,
		       COALESCE(operation, ''), before_text, after_text, status
		FROM agent_review_suggestions
		WHERE review_id = $1 AND status = 'pending'
		ORDER BY ordinal
		FOR UPDATE
	`, reviewDatabaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]lockedAgentSuggestion, 0)
	for rows.Next() {
		var suggestion lockedAgentSuggestion
		if err := rows.Scan(
			&suggestion.SuggestionID,
			&suggestion.Ordinal,
			&suggestion.Target,
			&suggestion.Kind,
			&suggestion.Operation,
			&suggestion.Before,
			&suggestion.After,
			&suggestion.Status,
		); err != nil {
			return nil, err
		}
		result = append(result, suggestion)
	}
	return result, rows.Err()
}

func validateAgentReviewForApply(locked lockedAgentReview, expectedRevision int64) error {
	if locked.Status != "ready" && locked.Status != "partially_applied" {
		if locked.Status == "stale" {
			return errAgentReviewStale
		}
		return errAgentReviewClosed
	}
	if locked.Document.Revision != locked.CurrentRevision {
		return errAgentReviewStale
	}
	if locked.Document.Revision != expectedRevision {
		return errDocumentRevisionConflict
	}
	return nil
}

func applyLockedAgentSuggestion(document agentReviewDocument, suggestion lockedAgentSuggestion) (string, string, error) {
	title := document.Title
	content := document.Content
	switch suggestion.Target {
	case "title":
		if title != suggestion.Before {
			return "", "", errAgentSuggestionConflict
		}
		title = suggestion.After
	case "body":
		if countOverlappingOccurrences(content, suggestion.Before) != 1 {
			return "", "", errAgentSuggestionConflict
		}
		content = strings.Replace(content, suggestion.Before, suggestion.After, 1)
	default:
		return "", "", errAgentSuggestionConflict
	}
	return title, content, nil
}

type agentBodyReplacement struct {
	SuggestionID string
	Start        int
	End          int
	After        string
}

func applyAllLockedAgentSuggestions(
	document agentReviewDocument,
	suggestions []lockedAgentSuggestion,
) (string, string, []string, []string, error) {
	title := document.Title
	content := document.Content
	appliedIDs := make([]string, 0, len(suggestions))
	dismissedTitleIDs := make([]string, 0)
	replacements := make([]agentBodyReplacement, 0)
	titleSelected := false
	for _, suggestion := range suggestions {
		switch suggestion.Target {
		case "title":
			if titleSelected {
				dismissedTitleIDs = append(dismissedTitleIDs, suggestion.SuggestionID)
				continue
			}
			if title != suggestion.Before {
				return "", "", nil, nil, errAgentSuggestionConflict
			}
			title = suggestion.After
			titleSelected = true
			appliedIDs = append(appliedIDs, suggestion.SuggestionID)
		case "body":
			if countOverlappingOccurrences(content, suggestion.Before) != 1 {
				return "", "", nil, nil, errAgentSuggestionConflict
			}
			start := strings.Index(content, suggestion.Before)
			replacements = append(replacements, agentBodyReplacement{
				SuggestionID: suggestion.SuggestionID,
				Start:        start,
				End:          start + len(suggestion.Before),
				After:        suggestion.After,
			})
		default:
			return "", "", nil, nil, errAgentSuggestionConflict
		}
	}
	sort.Slice(replacements, func(i, j int) bool { return replacements[i].Start > replacements[j].Start })
	for _, replacement := range replacements {
		content = content[:replacement.Start] + replacement.After + content[replacement.End:]
		appliedIDs = append(appliedIDs, replacement.SuggestionID)
	}
	return title, content, appliedIDs, dismissedTitleIDs, nil
}

func resolvedAgentReviewStatus(ctx context.Context, tx pgx.Tx, reviewDatabaseID int64, stale bool) (string, error) {
	var pending int
	var applied int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status = 'pending'),
		       count(*) FILTER (WHERE status = 'applied')
		FROM agent_review_suggestions
		WHERE review_id = $1
	`, reviewDatabaseID).Scan(&pending, &applied); err != nil {
		return "", err
	}
	if pending > 0 {
		if stale {
			return "stale", nil
		}
		if applied > 0 {
			return "partially_applied", nil
		}
		return "ready", nil
	}
	if applied > 0 {
		return "applied", nil
	}
	return "dismissed", nil
}

func markAgentReviewStaleAndCommit(ctx context.Context, tx pgx.Tx, reviewDatabaseID int64) error {
	if _, err := tx.Exec(ctx, `
		UPDATE agent_reviews SET status = 'stale', updated_at = now() WHERE id = $1
	`, reviewDatabaseID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return errAgentReviewStale
}

func agentReviewDocumentFromModel(databaseID int, document model.Document) agentReviewDocument {
	return agentReviewDocument{
		DatabaseID: databaseID,
		DocID:      document.DocID,
		Title:      document.Title,
		Theme:      document.Theme,
		Content:    document.Content,
		Revision:   document.Revision,
		CreatedAt:  document.CreatedAt,
		UpdatedAt:  document.UpdatedAt,
	}
}

func modelDocumentFromAgentReview(document agentReviewDocument) model.Document {
	return model.Document{
		DocID:     document.DocID,
		Title:     document.Title,
		Theme:     document.Theme,
		Content:   document.Content,
		Revision:  document.Revision,
		CreatedAt: document.CreatedAt,
		UpdatedAt: document.UpdatedAt,
	}
}

func (a *App) loadAgentReviewMutationResult(
	ctx context.Context,
	userID int,
	reviewID string,
	document agentReviewDocument,
) (agentReviewMutationResult, error) {
	review, err := a.loadAgentReview(ctx, userID, reviewID, true)
	if err != nil {
		return agentReviewMutationResult{}, err
	}
	return agentReviewMutationResult{
		Review:   review,
		Document: modelDocumentFromAgentReview(document),
	}, nil
}

func (a *App) writeAgentReviewMutationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAgentReviewNotFound), errors.Is(err, errAgentSuggestionNotFound), errors.Is(err, errDocumentNotFound):
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Agent review or suggestion not found")
	case errors.Is(err, errAgentReviewStale), errors.Is(err, errAgentSuggestionConflict):
		httpx.ErrorCode(w, http.StatusConflict, "agent_review_stale", "The document changed after this review")
	case errors.Is(err, errDocumentRevisionConflict):
		httpx.ErrorCode(w, http.StatusConflict, "document_revision_conflict", "Reload the latest document before applying suggestions")
	case errors.Is(err, errAgentReviewClosed), errors.Is(err, errAgentSuggestionClosed):
		httpx.ErrorCode(w, http.StatusConflict, "agent_review_closed", "This review or suggestion is already closed")
	case errors.Is(err, errDocumentQuotaExceeded):
		httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "document_quota_exceeded", "Document storage quota exceeded")
	default:
		log.Printf("agent review mutation: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
	}
}

func classifyAgentReviewFailure(err error) string {
	var httpError *agentLLMHTTPError
	switch {
	case errors.Is(err, errAgentReviewPersistence):
		return "server_error"
	case errors.Is(err, context.DeadlineExceeded):
		return "review_timeout"
	case errors.Is(err, errAgentLLMUsageMissing):
		return "usage_missing"
	case errors.Is(err, errAgentLLMUsageInvalid):
		return "usage_invalid"
	case errors.Is(err, errAgentLLMInvalidResponse):
		return "invalid_response"
	case errors.As(err, &httpError):
		if httpError.Status == http.StatusRequestTimeout ||
			httpError.Status == http.StatusTooManyRequests ||
			httpError.Status >= http.StatusInternalServerError {
			return "provider_unavailable"
		}
		return "provider_http_error"
	default:
		return "provider_unavailable"
	}
}

func (a *App) writeAgentProviderResolveError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "llm_channel_not_found", "LLM channel not found")
		return
	}
	if strings.Contains(err.Error(), "not configured") {
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "agent_llm_not_configured", "Built-in AI optimization is not configured")
		return
	}
	log.Printf("agent review resolve provider: %v", err)
	httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
}
