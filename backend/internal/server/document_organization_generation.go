package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"
)

type organizationBatchResult struct {
	Suggestions   []organizationSuggestion
	Usage         agentLLMResult
	AcceptedUsage agentLLMResult
	FailureStatus int
}

// These categories never contain model output, document text or provider bodies.
func organizationGenerationErrorKind(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, errAgentLLMTruncatedResponse):
		return "truncated"
	case errors.Is(err, errAgentLLMEmptyResponse):
		return "empty"
	case errors.Is(err, errAgentLLMInvalidResponse):
		return "invalid_response"
	case errors.Is(err, errAgentLLMUsageMissing), errors.Is(err, errAgentLLMUsageInvalid):
		return "invalid_usage"
	case errors.Is(err, errOrganizationConflict):
		return "run_stopped"
	}
	var providerError *agentLLMHTTPError
	if errors.As(err, &providerError) {
		return fmt.Sprintf("provider_http_%d", providerError.Status)
	}
	return "request_failed"
}

func (a *App) generateOrganizationBatch(ctx context.Context, userID int, id string, prompt agentLLMPrompt, items []organizationItem, folders []organizationFolder, provider agentLLMProvider) (organizationBatchResult, error) {
	var batch organizationBatchResult
	// Own the complete retry budget here. Calling the shared retrying wrapper
	// would multiply format retries by transient HTTP retries.
	for attempt := 0; attempt < organizationBatchAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return batch, err
		}
		// Check before every actual request, including retries, so a deleted
		// prompt source cannot be sent again after an in-flight response.
		var status string
		if err := a.db.QueryRow(ctx, `SELECT status FROM document_organizations WHERE user_id=$1 AND organization_id=$2::uuid`, userID, id).Scan(&status); err != nil {
			return batch, err
		}
		if status != "running" {
			return batch, errOrganizationConflict
		}
		result, err := callAgentLLMOnce(ctx, a.agentLLMHTTPClient, provider, prompt)
		// Keep only the final attempt's safe HTTP status, never its error body.
		// A successful retry must clear the earlier provider failure.
		batch.FailureStatus = 0
		var providerError *agentLLMHTTPError
		if errors.As(err, &providerError) {
			batch.FailureStatus = providerError.Status
		}
		kind := organizationGenerationErrorKind(err)
		if err == nil {
			if err := requireAgentLLMUsage(provider, result); err != nil {
				return batch, err
			}
			if err := addAgentLLMUsage(&batch.Usage, result); err != nil {
				return batch, err
			}
			batch.Suggestions, err = decodeOrganizationOutput(result.JSON, items, folders)
			if err == nil {
				batch.AcceptedUsage = result
				return batch, nil
			}
			kind = "json_format"
			err = fmt.Errorf("%w: organization JSON format", errAgentLLMInvalidResponse)
		}
		log.Printf("organization attempt id=%s documents=%d attempt=%d output_limit=%d reason=%s", id, len(items), attempt+1, prompt.MaxOutputTokens, kind)
		if ctx.Err() != nil {
			return batch, ctx.Err()
		}
		if errors.As(err, &providerError) && (providerError.Status == http.StatusBadRequest ||
			providerError.Status == http.StatusRequestEntityTooLarge || providerError.Status == http.StatusUnprocessableEntity) {
			// Content moderation and request/output limits can reject just this
			// batch, including a larger truncation retry. Repeating the rejected
			// request will not help; leave it unchecked without losing prior work.
			break
		}
		if !errors.Is(err, errAgentLLMInvalidResponse) && !isRetryableAgentLLMError(err) {
			// Authentication and endpoint/configuration failures retain their
			// normal failure/refund behavior. Deadlines are handled by the runner.
			return batch, err
		}
		if attempt+1 == organizationBatchAttempts {
			break
		}
		if errors.Is(err, errAgentLLMTruncatedResponse) {
			prompt.MaxOutputTokens = organizationRetryOutputTokens
		}
		if isRetryableAgentLLMError(err) {
			timer := time.NewTimer(750 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return batch, ctx.Err()
			case <-timer.C:
			}
		}
	}
	// Keep unusable suggestions editable but unchecked. The runner caps
	// consecutive failures and their share before publishing partial work.
	batch.Suggestions = make([]organizationSuggestion, 0, len(items))
	for _, item := range items {
		batch.Suggestions = append(batch.Suggestions, organizationFallback(item))
	}
	return batch, nil
}
