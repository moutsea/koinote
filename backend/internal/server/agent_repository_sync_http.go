package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"koinote/backend/internal/httpx"
)

// Interactive users contribute only their own GitHub credential. Anonymous
// callers have the same public access as Clone and use GitHub's anonymous quota.
func (a *App) refreshPublicAgentRepositoryForViewer(ctx context.Context, id int64, viewer *int, recheck bool) (*agentRepositoryPublication, SystemRepositorySyncResult, error) {
	var token string
	var err error
	var credentialUnavailable bool
	if viewer != nil {
		before, loadErr := a.loadAgentRepositorySyncSnapshot(ctx, a.db, id)
		if loadErr != nil {
			return nil, SystemRepositorySyncResult{}, loadErr
		}
		if before.publishedRevision == nil {
			return nil, SystemRepositorySyncResult{}, errAgentWorkspaceNotFound
		}
		var skip string
		skip, err = agentRepositoryRefreshSkipReason(ctx, a.db, before, !recheck)
		if err == nil && skip == "" {
			token, err = a.loadGitHubToken(ctx, *viewer)
			if errors.Is(err, errAgentGitHubCredentialCrypto) {
				token, err, credentialUnavailable = "", nil, true
			}
		}
		if err != nil {
			return nil, SystemRepositorySyncResult{}, err
		}
	}
	repository, result, err := a.refreshPublicAgentRepositoryWithCredential(ctx, id, token, recheck, credentialUnavailable)
	// A rejected upstream update does not invalidate the existing publication.
	// Only action preparation falls back; manual sync still reports the failure.
	if !recheck && (errors.Is(err, errAgentRepositorySyncLicense) || errors.Is(err, errAgentRepositorySyncLicenseReview) || errors.Is(err, errAgentRepositorySyncPublicationLicense) || errors.Is(err, errAgentRepositorySyncIdentity)) {
		result.Status, result.Code = "skipped", systemRepositorySyncErrorCode(err)
		repository, err = a.loadPublicAgentRepository(ctx, id, nil)
	}
	if err != nil {
		return nil, result, err
	}
	if credentialUnavailable {
		result.WarningCode = "github_credential_unavailable"
	}
	repository.agentRepositoryEngagement, err = loadAgentRepositoryEngagement(ctx, a.db, id, viewer)
	return repository, result, err
}

// A client that already refreshed may explicitly consume its prepared public
// snapshot. The Fork/Clone transaction checks its revision and publication ID,
// so a republication cannot silently change its license. Other API callers
// keep the default upstream check.
func (a *App) preparePublicAgentRepositoryAction(ctx context.Context, id int64, viewer *int, refresh *bool) (*agentRepositoryPublication, error) {
	if refresh != nil && !*refresh {
		return a.loadPublicAgentRepository(ctx, id, nil)
	}
	repository, _, err := a.refreshPublicAgentRepositoryForViewer(ctx, id, viewer, false)
	return repository, err
}

func writePublicAgentRepositorySyncError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAgentRepositorySyncBusy):
		w.Header().Set("Retry-After", "5")
		httpx.ErrorCode(w, http.StatusTooManyRequests, "github_rate_limited", "This repository is already synchronizing; try again shortly")
	case errors.Is(err, errAgentRepositorySyncIdentity):
		httpx.ErrorCode(w, http.StatusConflict, "repository_identity_mismatch", "The GitHub repository identity no longer matches its saved source")
	case errors.Is(err, errAgentRepositorySyncLicense), errors.Is(err, errAgentRepositorySyncLicenseReview):
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, systemRepositorySyncErrorCode(err), "The upstream license needs review before its contents can be refreshed")
	case errors.Is(err, errAgentRepositorySyncPublicationLicense):
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "publication_license_mismatch", "The publication license differs from the upstream license; updates are paused to preserve the saved version")
	default:
		writeAgentGitHubImportError(w, err)
	}
}

func (a *App) publicAgentRepositorySync(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	id, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return
	}
	// Action preparation uses current server state to skip a known retired source.
	// Only an explicit manual sync rechecks such a source.
	recheck := true
	if values, present := r.URL.Query()["recheck"]; present {
		if len(values) != 1 || (values[0] != "true" && values[0] != "false") {
			httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "recheck must be true or false")
			return
		}
		recheck = values[0] == "true"
	}
	// Preparing ordinary or retired snapshots must not inherit the stricter
	// manual-sync budget. Match the existing Clone limits, with separate counters.
	prefix, perIP, global := "agent-repository-sync:", 10, 120
	if !recheck {
		prefix, perIP, global = "agent-repository-prepare:", 30, 600
	}
	if !a.rateLimit().allow(prefix+a.publicRepositoryRequestIP(r), perIP, time.Minute) || !a.rateLimit().allow(prefix+"global", global, time.Minute) {
		w.Header().Set("Retry-After", "60")
		tooManyAttempts(w)
		return
	}
	viewer, err := a.publicRepositoryViewerID(r)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*githubRequestTimeout)
	defer cancel()
	repository, result, err := a.refreshPublicAgentRepositoryForViewer(ctx, id, viewer, recheck)
	if err != nil {
		writePublicAgentRepositorySyncError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"repository": a.publicRepositoryForClient(r, repository), "sync": result})
}
