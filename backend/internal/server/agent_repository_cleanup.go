package server

import (
	"context"
	"log"
	"time"
)

const agentRepositoryCloneRetention = 30 * 24 * time.Hour

// Keep a bounded retry-deduplication window, while lifetime counters remain.
func (a *App) cleanupAgentRepositoryClones(ctx context.Context) error {
	for range 20 {
		result, err := a.db.Exec(ctx, `WITH expired AS (
 SELECT request_id FROM agent_repository_clones WHERE created_at < $1
 ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED
 ) DELETE FROM agent_repository_clones c USING expired e WHERE c.request_id=e.request_id`, time.Now().Add(-agentRepositoryCloneRetention))
		if err != nil {
			return err
		}
		if result.RowsAffected() < 1000 {
			return nil
		}
	}
	return nil
}

func (a *App) StartAgentRepositoryCleanup(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			if ctx.Err() != nil {
				return
			}
			runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := a.cleanupAgentRepositoryClones(runCtx)
			cancel()
			if err != nil && ctx.Err() == nil {
				log.Printf("repository Clone cleanup: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}
