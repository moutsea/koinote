package server

import (
	"context"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpAgentWorkspaceFileInput struct {
	Path          string `json:"path" jsonschema:"Relative file path using forward slashes."`
	ContentBase64 string `json:"contentBase64" jsonschema:"Complete file content encoded with standard base64."`
	MimeType      string `json:"mimeType,omitempty" jsonschema:"Optional MIME type."`
}

type mcpUpdateAgentWorkspaceInput struct {
	WorkspaceID      int64                        `json:"workspaceId,omitempty" jsonschema:"Repository workspace ID returned by list_agent_workspaces. Required when multiple repositories exist."`
	ExpectedRevision int64                        `json:"expectedRevision" jsonschema:"Revision returned by get_agent_workspace. Use 0 when no workspace exists."`
	Upsert           []mcpAgentWorkspaceFileInput `json:"upsert,omitempty" jsonschema:"Files that are new or changed. Only these files are uploaded."`
	Delete           []string                     `json:"delete,omitempty" jsonschema:"Relative paths to delete."`
	Files            []mcpAgentWorkspaceFileInput `json:"files,omitempty" jsonschema:"Legacy complete replacement file set. Prefer upsert and delete for incremental updates."`
	ReplaceAll       bool                         `json:"replaceAll,omitempty" jsonschema:"Explicitly allow files to replace the entire repository in ONE request. Never split a replacement into batches. Cannot be combined with upsert or delete."`
}

type mcpAgentWorkspaceSelectionInput struct {
	WorkspaceID int64 `json:"workspaceId,omitempty" jsonschema:"Repository workspace ID. Omit only when the account has one repository."`
}

type mcpCreateAgentWorkspaceInput struct {
	Name        string `json:"name" jsonschema:"Repository name, 1 to 80 characters."`
	Description string `json:"description,omitempty" jsonschema:"Optional repository note, up to 500 characters."`
	Locale      string `json:"locale,omitempty" jsonschema:"README language: en, zh, fr, or ja. Defaults to en."`
}

type mcpManageAgentWorkspaceInput struct {
	WorkspaceID      int64  `json:"workspaceId" jsonschema:"Repository workspace ID."`
	ExpectedRevision int64  `json:"expectedRevision" jsonschema:"Revision returned by the repository metadata."`
	Name             string `json:"name,omitempty" jsonschema:"New repository name."`
	Description      string `json:"description,omitempty" jsonschema:"New repository note."`
	Delete           bool   `json:"delete,omitempty" jsonschema:"Permanently delete this repository and all its files."`
}

type mcpAgentWorkspaceListOutput struct {
	Workspaces []agentWorkspaceSummary `json:"workspaces"`
}

type mcpReadAgentWorkspaceFileInput struct {
	FileID int64 `json:"fileId" jsonschema:"File ID returned by get_agent_workspace."`
	mcpAgentWorkspaceReadRange
}

func (a *App) mcpListAgentWorkspaces(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, mcpAgentWorkspaceListOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "list_agent_workspaces", "", result, started) }()
	workspaces, err := a.listAgentWorkspaces(ctx, principal.User.ID)
	if err != nil {
		return nil, mcpAgentWorkspaceListOutput{}, mcpInternalError("list agent workspaces", err)
	}
	result = "success"
	return nil, mcpAgentWorkspaceListOutput{Workspaces: workspaces}, nil
}

func (a *App) mcpCreateAgentWorkspace(ctx context.Context, _ *mcp.CallToolRequest, input mcpCreateAgentWorkspaceInput) (*mcp.CallToolResult, agentWorkspaceView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "create_agent_workspace", "", result, started) }()
	if err := a.allowMCPAgentWorkspaceWrite(principal); err != nil {
		return nil, agentWorkspaceView{}, err
	}
	view, err := a.createAgentWorkspace(ctx, principal.User.ID, input.Name, input.Description, input.Locale)
	if err != nil {
		return nil, agentWorkspaceView{}, mapMCPAgentWorkspaceError(err)
	}
	result = "success"
	return nil, view, nil
}

func (a *App) mcpManageAgentWorkspace(ctx context.Context, _ *mcp.CallToolRequest, input mcpManageAgentWorkspaceInput) (*mcp.CallToolResult, agentWorkspaceView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() {
		a.auditMCPCallWithWorkspace(principal, "manage_agent_workspace", "", result, started, mcpWorkspaceAudit{WorkspaceID: input.WorkspaceID, ExpectedRevision: &input.ExpectedRevision})
	}()
	if err := a.allowMCPAgentWorkspaceWrite(principal); err != nil {
		return nil, agentWorkspaceView{}, err
	}
	view, err := a.manageAgentWorkspace(ctx, principal.User.ID, input.WorkspaceID, input.ExpectedRevision, input.Name, input.Description, input.Delete)
	if err != nil {
		return nil, agentWorkspaceView{}, mapMCPAgentWorkspaceError(err)
	}
	result = "success"
	return nil, view, nil
}

func (a *App) mcpGetAgentWorkspace(ctx context.Context, _ *mcp.CallToolRequest, input mcpAgentWorkspaceSelectionInput) (*mcp.CallToolResult, agentWorkspaceView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_agent_workspace", "", result, started) }()
	view, err := a.loadAgentWorkspace(ctx, principal.User.ID, input.WorkspaceID)
	if errors.Is(err, errAgentWorkspaceNotFound) {
		if input.WorkspaceID != 0 {
			return nil, agentWorkspaceView{}, errors.New("agent workspace not found")
		}
		result = "success"
		return nil, agentWorkspaceView{Files: []agentWorkspaceFileView{}}, nil
	}
	if errors.Is(err, errAgentWorkspaceSelection) {
		return nil, agentWorkspaceView{}, errors.New("multiple repositories exist; specify workspaceId")
	}
	if err != nil {
		return nil, agentWorkspaceView{}, mcpInternalError("get agent workspace", err)
	}
	result = "success"
	return nil, view, nil
}

func (a *App) mcpReadAgentWorkspaceFile(ctx context.Context, _ *mcp.CallToolRequest, input mcpReadAgentWorkspaceFileInput) (*mcp.CallToolResult, mcpAgentWorkspaceFileChunk, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "read_agent_workspace_file", "", result, started) }()
	limit, err := input.mcpAgentWorkspaceReadRange.validate()
	if err != nil {
		return nil, mcpAgentWorkspaceFileChunk{}, err
	}
	var view mcpAgentWorkspaceFileChunk
	var content []byte
	err = a.db.QueryRow(ctx, `
		SELECT f.id, f.path, f.mime_type, f.size_bytes, f.sha256, substring(f.content FROM $3::int FOR $4::int)
		FROM agent_workspace_files f
		JOIN agent_workspaces w ON w.id = f.workspace_id
		WHERE f.id = $1 AND w.user_id = $2 AND w.deleted_at IS NULL
	`, input.FileID, principal.User.ID, input.Offset+1, limit).Scan(&view.FileID, &view.Path, &view.MimeType, &view.SizeBytes, &view.SHA256, &content)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, mcpAgentWorkspaceFileChunk{}, errors.New("agent workspace file not found")
		}
		return nil, mcpAgentWorkspaceFileChunk{}, mcpInternalError("read agent workspace file", err)
	}
	if err := input.mcpAgentWorkspaceReadRange.checkFile(view.SizeBytes, view.SHA256); err != nil {
		return nil, mcpAgentWorkspaceFileChunk{}, err
	}
	view.mcpAgentWorkspaceChunkRange = newMCPAgentWorkspaceChunkRange(input.Offset, int64(len(content)), view.SizeBytes)
	view.ContentBase64 = encodeAgentWorkspaceContent(content)
	result = "success"
	return nil, view, nil
}

func (a *App) mcpUpdateAgentWorkspace(ctx context.Context, _ *mcp.CallToolRequest, input mcpUpdateAgentWorkspaceInput) (*mcp.CallToolResult, agentWorkspaceView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	target := mcpWorkspaceAudit{WorkspaceID: input.WorkspaceID, ExpectedRevision: &input.ExpectedRevision}
	defer func() { a.auditMCPCallWithWorkspace(principal, "update_agent_workspace", "", result, started, target) }()
	if err := a.allowMCPAgentWorkspaceWrite(principal); err != nil {
		return nil, agentWorkspaceView{}, err
	}
	if target.WorkspaceID == 0 {
		// Legacy callers may omit the ID for a single repository. Resolve it for
		// failed attempts too; a successful write records its authoritative ID below.
		if id, err := resolveAgentWorkspaceID(ctx, a.db, principal.User.ID, 0); err == nil {
			target.WorkspaceID = id
		}
	}
	upsert := input.Upsert
	if input.Upsert != nil || input.Delete != nil {
		if input.Files != nil || input.ReplaceAll {
			return nil, agentWorkspaceView{}, errors.New("files and replaceAll cannot be combined with upsert or delete")
		}
	} else if input.ReplaceAll {
		upsert = input.Files
	} else {
		return nil, agentWorkspaceView{}, errors.New("use upsert/delete for incremental batches; complete replacement requires files and replaceAll: true in a single request")
	}
	patchMode := input.Upsert != nil || input.Delete != nil
	if patchMode && len(upsert) == 0 && len(input.Delete) == 0 {
		return nil, agentWorkspaceView{}, errors.New("at least one file must be updated or deleted")
	}
	files := make([]agentWorkspaceFileInput, len(upsert))
	for index, file := range upsert {
		files[index] = agentWorkspaceFileInput{Path: file.Path, ContentBase64: file.ContentBase64, MimeType: file.MimeType}
	}
	if patchMode {
		validated, err := validateAgentWorkspaceFilesAllowEmpty(files)
		deletePaths, deleteErr := normalizeAgentWorkspaceDeletePaths(input.Delete)
		if deleteErr != nil {
			return nil, agentWorkspaceView{}, deleteErr
		}
		if err != nil {
			return nil, agentWorkspaceView{}, errors.New(strings.TrimSpace(err.Error()))
		}
		if overlapErr := ensureAgentWorkspacePatchPathsDoNotOverlap(validated, deletePaths); overlapErr != nil {
			return nil, agentWorkspaceView{}, overlapErr
		}
		view, patchErr := a.patchAgentWorkspace(ctx, principal.User.ID, input.WorkspaceID, input.ExpectedRevision, validated, deletePaths)
		if errors.Is(patchErr, errAgentWorkspaceConflict) {
			return nil, agentWorkspaceView{}, errors.New("agent workspace revision conflict; read the latest workspace and retry")
		}
		if patchErr != nil {
			return nil, agentWorkspaceView{}, mapMCPAgentWorkspaceError(patchErr)
		}
		result = "success"
		target.WorkspaceID = view.WorkspaceID
		target.ResultingRevision = &view.Revision
		return nil, view, nil
	}
	validated, err := validateAgentWorkspaceFiles(files)
	if err != nil {
		return nil, agentWorkspaceView{}, errors.New(strings.TrimSpace(err.Error()))
	}
	view, err := a.replaceAgentWorkspace(ctx, principal.User.ID, input.WorkspaceID, input.ExpectedRevision, validated)
	if errors.Is(err, errAgentWorkspaceConflict) {
		return nil, agentWorkspaceView{}, errors.New("agent workspace revision conflict; read the latest workspace and retry")
	}
	if err != nil {
		return nil, agentWorkspaceView{}, mapMCPAgentWorkspaceError(err)
	}
	result = "success"
	target.WorkspaceID = view.WorkspaceID
	target.ResultingRevision = &view.Revision
	return nil, view, nil
}

func (a *App) allowMCPAgentWorkspaceWrite(principal mcpPrincipal) error {
	if !principal.canAgentWorkspaceWrite() {
		return errors.New("an agent_write repository token is required")
	}
	if !a.rateLimit().allow("agent-workspace-write:"+strconv.Itoa(principal.User.ID), agentWorkspaceWriteLimit, time.Minute) {
		return errors.New("too many workspace updates; try again later")
	}
	return nil
}

func mapMCPAgentWorkspaceError(err error) error {
	var sensitive *agentWorkspaceSensitiveError
	switch {
	case errors.As(err, &sensitive), errors.Is(err, errAgentWorkspaceRevisionNotFound), errors.Is(err, errAgentWorkspaceFileNotFound), errors.Is(err, errAgentWorkspaceFileRange):
		return err
	case errors.Is(err, errAgentWorkspaceNotFound):
		return errors.New("agent workspace not found")
	case errors.Is(err, errAgentWorkspaceSelection):
		return errors.New("multiple repositories exist; specify workspaceId")
	case errors.Is(err, errAgentWorkspaceQuota):
		return errors.New("agent workspace storage quota exceeded")
	case errors.Is(err, errAgentWorkspaceConflict):
		return errors.New("agent workspace revision conflict; read the latest workspace and retry")
	case errors.Is(err, errAgentWorkspaceLimit):
		return errors.New("repository limit reached")
	case errors.Is(err, errAgentWorkspaceName):
		return errors.New("repository name or description is invalid")
	default:
		return mcpInternalError("agent workspace operation", err)
	}
}

func (a *App) mcpGetAgentWorkspacePrompt(ctx context.Context, _ *mcp.CallToolRequest, input mcpAgentWorkspaceSelectionInput) (*mcp.CallToolResult, map[string]string, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_agent_workspace_prompt", "", result, started) }()
	result = "success"
	return nil, map[string]string{
		"version": agentWorkspacePromptRevision,
		"prompt":  agentWorkspacePromptForID(strings.TrimRight(a.cfg.AppURL, "/"), input.WorkspaceID),
	}, nil
}

func encodeAgentWorkspaceContent(content []byte) string {
	return base64.StdEncoding.EncodeToString(content)
}
