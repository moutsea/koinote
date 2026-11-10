package server

import (
	"context"
	"crypto/sha256"
	"strings"
)

// Credentials and forced rechecks are separate access contexts: a manual
// recheck must not inherit a Clone's decision to skip a known retired source.
type agentRepositoryRefreshKey struct {
	workspaceID           int64
	credential            [sha256.Size]byte
	recheck               bool
	credentialUnavailable bool
}

type agentRepositoryRefresh struct {
	done   chan struct{}
	result SystemRepositorySyncResult
	err    error
}

func (a *App) acquireGitHubImportSlot() bool {
	a.githubImportOnce.Do(func() { a.githubImportSlots = make(chan struct{}, 2) })
	select {
	case a.githubImportSlots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (a *App) releaseGitHubImportSlot() { <-a.githubImportSlots }

// Only overlapping work is shared, never cached results or mutable viewer data.
// Each HTTP caller already owns its goroutine; rejected work creates no queue.
func (a *App) refreshPublicAgentRepository(ctx context.Context, id int64, token string, recheck bool) (*agentRepositoryPublication, SystemRepositorySyncResult, error) {
	return a.refreshPublicAgentRepositoryWithCredential(ctx, id, token, recheck, false)
}

func (a *App) refreshPublicAgentRepositoryWithCredential(ctx context.Context, id int64, token string, recheck, credentialUnavailable bool) (*agentRepositoryPublication, SystemRepositorySyncResult, error) {
	empty := SystemRepositorySyncResult{WorkspaceID: id}
	if err := ctx.Err(); err != nil {
		return nil, empty, err
	}
	token = strings.TrimSpace(token)
	key := agentRepositoryRefreshKey{workspaceID: id, credential: sha256.Sum256([]byte(token)), recheck: recheck, credentialUnavailable: credentialUnavailable}
	a.agentRepositorySyncMu.Lock()
	flight := a.agentRepositorySyncs[key]
	leader := flight == nil
	if leader {
		if a.agentRepositorySyncs == nil {
			a.agentRepositorySyncs = make(map[agentRepositoryRefreshKey]*agentRepositoryRefresh)
		}
		// A panic must release waiters as a retryable failure, not a false success.
		flight = &agentRepositoryRefresh{done: make(chan struct{}), result: empty, err: errAgentGitHubTransient}
		a.agentRepositorySyncs[key] = flight
	}
	a.agentRepositorySyncMu.Unlock()
	if leader {
		a.runAgentRepositoryRefresh(ctx, key, flight, token)
	} else {
		select {
		case <-ctx.Done():
			return nil, empty, ctx.Err()
		case <-flight.done:
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, empty, err
	}
	if flight.err != nil {
		return nil, flight.result, flight.err
	}
	// The publication and engagement are loaded independently for every viewer.
	repository, err := a.loadPublicAgentRepository(ctx, id, nil)
	return repository, flight.result, err
}

func (a *App) runAgentRepositoryRefresh(ctx context.Context, key agentRepositoryRefreshKey, flight *agentRepositoryRefresh, token string) {
	work, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*githubRequestTimeout)
	defer cancel()
	defer func() {
		a.agentRepositorySyncMu.Lock()
		delete(a.agentRepositorySyncs, key)
		close(flight.done)
		a.agentRepositorySyncMu.Unlock()
	}()
	flight.result, flight.err = a.refreshPublicAgentRepositoryOnce(work, key.workspaceID, token, key.recheck, key.credentialUnavailable)
}
