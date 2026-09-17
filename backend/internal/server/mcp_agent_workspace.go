package server

import (
	"context"
	"encoding/base64"
	"errors"
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
}

func (a *App) addAgentWorkspaceMCPTools(server *mcp.Server, principal mcpPrincipal) {
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: boolPtr(false)}
	mcp.AddTool(server, &mcp.Tool{Name: "list_agent_workspaces", Title: "List Agent repositories", Description: "List the authenticated member's private Skills/Agent repositories.", Annotations: readOnly}, a.mcpListAgentWorkspaces)
	mcp.AddTool(server, &mcp.Tool{Name: "create_agent_workspace", Title: "Create Agent repository", Description: "Create a private Skills/Agent repository; upload files separately.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)}}, a.mcpCreateAgentWorkspace)
	mcp.AddTool(server, &mcp.Tool{Name: "manage_agent_workspace", Title: "Manage Agent repository", Description: "Rename or permanently delete a private Skills/Agent repository using its expected revision.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: boolPtr(true), OpenWorldHint: boolPtr(false)}}, a.mcpManageAgentWorkspace)
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_agent_workspace", Title: "Read agent workspace",
		Description: "Read the authenticated member's private Agent settings workspace metadata and file list.",
		Annotations: readOnly,
	}, a.mcpGetAgentWorkspace)
	mcp.AddTool(server, &mcp.Tool{
		Name: "read_agent_workspace_file", Title: "Read agent workspace file",
		Description: "Read one original file from the authenticated member's private Agent settings workspace as base64.",
		Annotations: readOnly,
	}, a.mcpReadAgentWorkspaceFile)
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_agent_workspace_prompt", Title: "Get agent workspace instructions",
		Description: "Return instructions for safely reading and updating the authenticated member's private Agent settings workspace.",
		Annotations: readOnly,
	}, a.mcpGetAgentWorkspacePrompt)
	if principal.canAgentWorkspaceWrite() {
		mcp.AddTool(server, &mcp.Tool{
			Name: "update_agent_workspace", Title: "Update agent workspace",
			Description: "Incrementally update the authenticated member's private Agent settings workspace with changed files in upsert and paths in delete. Check the expected revision and redact sensitive data first.",
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: boolPtr(true), OpenWorldHint: boolPtr(false)},
		}, a.mcpUpdateAgentWorkspace)
	}
}

func (a *App) mcpListAgentWorkspaces(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, mcpAgentWorkspaceListOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	workspaces, err := a.listAgentWorkspaces(ctx, principal.User.ID)
	if err != nil {
		return nil, mcpAgentWorkspaceListOutput{}, mcpInternalError("list agent workspaces", err)
	}
	return nil, mcpAgentWorkspaceListOutput{Workspaces: workspaces}, nil
}

func (a *App) mcpCreateAgentWorkspace(ctx context.Context, _ *mcp.CallToolRequest, input mcpCreateAgentWorkspaceInput) (*mcp.CallToolResult, agentWorkspaceView, error) {
	principal := mcpPrincipalFromContext(ctx)
	view, err := a.createAgentWorkspace(ctx, principal.User.ID, input.Name, input.Description, input.Locale)
	if err != nil {
		return nil, agentWorkspaceView{}, err
	}
	return nil, view, nil
}

func (a *App) mcpManageAgentWorkspace(ctx context.Context, _ *mcp.CallToolRequest, input mcpManageAgentWorkspaceInput) (*mcp.CallToolResult, agentWorkspaceView, error) {
	principal := mcpPrincipalFromContext(ctx)
	view, err := a.manageAgentWorkspace(ctx, principal.User.ID, input.WorkspaceID, input.ExpectedRevision, input.Name, input.Description, input.Delete)
	if err != nil {
		return nil, agentWorkspaceView{}, err
	}
	return nil, view, nil
}

func (a *App) mcpGetAgentWorkspace(ctx context.Context, _ *mcp.CallToolRequest, input mcpAgentWorkspaceSelectionInput) (*mcp.CallToolResult, agentWorkspaceView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_agent_workspace", "", result, started) }()
	view, err := a.loadAgentWorkspace(ctx, principal.User.ID, input.WorkspaceID)
	if errors.Is(err, errAgentWorkspaceNotFound) {
		result = "success"
		return nil, agentWorkspaceView{Files: []agentWorkspaceFileView{}}, nil
	}
	if err != nil {
		return nil, agentWorkspaceView{}, mcpInternalError("get agent workspace", err)
	}
	result = "success"
	return nil, view, nil
}

func (a *App) mcpReadAgentWorkspaceFile(ctx context.Context, _ *mcp.CallToolRequest, input mcpReadAgentWorkspaceFileInput) (*mcp.CallToolResult, agentWorkspaceFileContentView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "read_agent_workspace_file", "", result, started) }()
	var view agentWorkspaceFileContentView
	var content []byte
	err := a.db.QueryRow(ctx, `
		SELECT f.id, f.path, f.mime_type, f.size_bytes, f.sha256, f.content
		FROM agent_workspace_files f
		JOIN agent_workspaces w ON w.id = f.workspace_id
		WHERE f.id = $1 AND w.user_id = $2 AND w.deleted_at IS NULL
	`, input.FileID, principal.User.ID).Scan(&view.FileID, &view.Path, &view.MimeType, &view.SizeBytes, &view.SHA256, &content)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, agentWorkspaceFileContentView{}, errors.New("agent workspace file not found")
		}
		return nil, agentWorkspaceFileContentView{}, mcpInternalError("read agent workspace file", err)
	}
	view.ContentBase64 = encodeAgentWorkspaceContent(content)
	result = "success"
	return nil, view, nil
}

func (a *App) mcpUpdateAgentWorkspace(ctx context.Context, _ *mcp.CallToolRequest, input mcpUpdateAgentWorkspaceInput) (*mcp.CallToolResult, agentWorkspaceView, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "update_agent_workspace", "", result, started) }()
	upsert := input.Upsert
	if input.Upsert != nil || input.Delete != nil {
		if len(input.Files) > 0 {
			return nil, agentWorkspaceView{}, errors.New("files cannot be combined with upsert or delete")
		}
	} else if len(input.Files) > 0 {
		upsert = input.Files
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
			return nil, agentWorkspaceView{}, mcpInternalError("patch agent workspace", patchErr)
		}
		result = "success"
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
		return nil, agentWorkspaceView{}, mcpInternalError("update agent workspace", err)
	}
	result = "success"
	return nil, view, nil
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
