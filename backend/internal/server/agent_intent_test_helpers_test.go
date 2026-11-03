package server

import "context"

// Existing operation regressions use a genuine host-signed proof. Dedicated
// intent tests exercise the public MCP preparation and rejection paths as well.
func proposeAgentOperationsForTest(a *App, ctx context.Context, t writingTask, inputs []agentOperationInput) ([]agentOperation, error) {
	proof, err := agentProofForTest(a, ctx, t, "propose_operations", inputs)
	if err != nil {
		return nil, err
	}
	return a.proposeAgentOperations(ctx, t, inputs, agentIntentAuthorization{ToolName: "propose_operations", Proof: proof})
}
func agentProofForTest(a *App, ctx context.Context, t writingTask, tool string, inputs []agentOperationInput) (*agentIntentProof, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	fresh, s, err := a.lockAgentTask(ctx, tx, t.UserID, t.ID, true)
	if err != nil {
		return nil, err
	}
	if fresh.IntentVersion == 0 {
		return nil, nil
	}
	effects, err := a.agentIntentEffects(ctx, tx, fresh, inputs)
	if err != nil {
		return nil, err
	}
	return &agentIntentProof{TaskID: t.SessionID, SessionID: t.SessionID, Version: t.IntentVersion, CurrentMessageID: agentUserMessageID(t.ID), Effects: effects, Token: a.agentIntentToken(fresh, s, tool, inputs, effects)}, nil
}
