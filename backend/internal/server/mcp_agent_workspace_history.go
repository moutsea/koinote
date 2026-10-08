package server

import (
	"context"
	"errors"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpAgentWorkspaceCommitsInput struct {
	WorkspaceID int64  `json:"workspaceId" jsonschema:"Repository ID from list_agent_workspaces."`
	Before      *int64 `json:"before,omitempty" jsonschema:"Exclusive revision cursor. Pass nextBefore from the previous page; omit for the latest page."`
}

type mcpAgentWorkspaceCommitInput struct {
	WorkspaceID int64 `json:"workspaceId" jsonschema:"Repository ID from list_agent_workspaces."`
	Revision    int64 `json:"revision" jsonschema:"Retained revision from list_agent_workspace_commits."`
}

type mcpAgentWorkspaceCommitFileInput struct {
	WorkspaceID int64  `json:"workspaceId" jsonschema:"Repository ID from list_agent_workspaces."`
	Revision    int64  `json:"revision" jsonschema:"Retained revision from list_agent_workspace_commits."`
	Path        string `json:"path" jsonschema:"Exact relative file path from get_agent_workspace_commit."`
	mcpAgentWorkspaceReadRange
}

type mcpRestoreAgentWorkspaceCommitInput struct {
	WorkspaceID      int64 `json:"workspaceId" jsonschema:"Repository ID from list_agent_workspaces."`
	Revision         int64 `json:"revision" jsonschema:"Retained revision whose files should be restored."`
	ExpectedRevision int64 `json:"expectedRevision" jsonschema:"Current revision from get_agent_workspace, not the historical revision. A conflict requires reading the repository again."`
}

func (a *App) mcpGetAgentWorkspaceStorage(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, agentWorkspaceQuotaView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_agent_workspace_storage", "", result, started) }()
	view, err := loadAgentWorkspaceQuota(ctx, a.db, principal.User.ID)
	if err != nil {
		return nil, agentWorkspaceQuotaView{}, mcpInternalError("read repository storage", err)
	}
	result = "success"
	return nil, view, nil
}

func (a *App) mcpListAgentWorkspaceCommits(ctx context.Context, _ *mcp.CallToolRequest, input mcpAgentWorkspaceCommitsInput) (*mcp.CallToolResult, agentWorkspaceCommitPage, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "list_agent_workspace_commits", "", result, started) }()
	if input.WorkspaceID <= 0 || (input.Before != nil && *input.Before < 0) {
		return nil, agentWorkspaceCommitPage{}, errors.New("workspaceId must be positive and before must be non-negative")
	}
	page, err := a.listAgentWorkspaceCommits(ctx, principal.User.ID, input.WorkspaceID, input.Before)
	if err != nil {
		return nil, agentWorkspaceCommitPage{}, mapMCPAgentWorkspaceError(err)
	}
	result = "success"
	return nil, page, nil
}

func validMCPAgentWorkspaceRevision(workspaceID, revision int64) error {
	if workspaceID <= 0 || revision < 0 {
		return errors.New("workspaceId must be positive and revision must be non-negative")
	}
	return nil
}

func (a *App) mcpGetAgentWorkspaceCommit(ctx context.Context, _ *mcp.CallToolRequest, input mcpAgentWorkspaceCommitInput) (*mcp.CallToolResult, agentWorkspaceCommitView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_agent_workspace_commit", "", result, started) }()
	if err := validMCPAgentWorkspaceRevision(input.WorkspaceID, input.Revision); err != nil {
		return nil, agentWorkspaceCommitView{}, err
	}
	view, err := a.loadAgentWorkspaceCommit(ctx, principal.User.ID, input.WorkspaceID, input.Revision)
	if err != nil {
		return nil, agentWorkspaceCommitView{}, mapMCPAgentWorkspaceError(err)
	}
	result = "success"
	return nil, view, nil
}

func (a *App) mcpReadAgentWorkspaceCommitFile(ctx context.Context, _ *mcp.CallToolRequest, input mcpAgentWorkspaceCommitFileInput) (*mcp.CallToolResult, mcpAgentWorkspaceCommitFileChunk, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "read_agent_workspace_commit_file", "", result, started) }()
	if err := validMCPAgentWorkspaceRevision(input.WorkspaceID, input.Revision); err != nil {
		return nil, mcpAgentWorkspaceCommitFileChunk{}, err
	}
	path, err := normalizeAgentWorkspacePath(input.Path)
	if err != nil {
		return nil, mcpAgentWorkspaceCommitFileChunk{}, err
	}
	limit, err := input.mcpAgentWorkspaceReadRange.validate()
	if err != nil {
		return nil, mcpAgentWorkspaceCommitFileChunk{}, err
	}
	file, err := a.loadAgentWorkspaceCommitFileRange(ctx, principal.User.ID, input.WorkspaceID, input.Revision, path, input.Offset, limit)
	if err != nil {
		return nil, mcpAgentWorkspaceCommitFileChunk{}, mapMCPAgentWorkspaceError(err)
	}
	if err := input.mcpAgentWorkspaceReadRange.checkFile(file.SizeBytes, file.SHA256); err != nil {
		return nil, mcpAgentWorkspaceCommitFileChunk{}, err
	}
	result = "success"
	length := int64(limit)
	if length > file.SizeBytes-input.Offset {
		length = file.SizeBytes - input.Offset
	}
	return nil, mcpAgentWorkspaceCommitFileChunk{agentWorkspaceCommitFileContent: file, mcpAgentWorkspaceChunkRange: newMCPAgentWorkspaceChunkRange(input.Offset, length, file.SizeBytes)}, nil
}

func (a *App) mcpRestoreAgentWorkspaceCommit(ctx context.Context, _ *mcp.CallToolRequest, input mcpRestoreAgentWorkspaceCommitInput) (*mcp.CallToolResult, agentWorkspaceView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	target := mcpWorkspaceAudit{WorkspaceID: input.WorkspaceID, SourceRevision: &input.Revision, ExpectedRevision: &input.ExpectedRevision}
	defer func() {
		a.auditMCPCallWithWorkspace(principal, "restore_agent_workspace_commit", "", result, started, target)
	}()
	if err := validMCPAgentWorkspaceRevision(input.WorkspaceID, input.Revision); err != nil {
		return nil, agentWorkspaceView{}, err
	}
	if err := a.allowMCPAgentWorkspaceWrite(principal); err != nil {
		return nil, agentWorkspaceView{}, err
	}
	view, err := a.mutateAgentWorkspaceWithHistory(ctx, principal.User.ID, input.WorkspaceID, input.ExpectedRevision, nil, nil, true, &input.Revision, false)
	if err != nil {
		return nil, agentWorkspaceView{}, mapMCPAgentWorkspaceError(err)
	}
	result = "success"
	target.ResultingRevision = &view.Revision
	return nil, view, nil
}
