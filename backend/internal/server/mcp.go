package server

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"koinote/backend/internal/model"
)

const (
	mcpServerVersion        = "0.1.0"
	mcpDefaultPageSize      = 50
	mcpMaxPageSize          = 100
	mcpDefaultContentRunes  = 12000
	mcpMaxContentRunes      = 40000
	mcpRequestsPerMinute    = 120
	mcpMaxRequestBytes      = 2 << 20
	mcpAuditRetention       = 180 * 24 * time.Hour
	mcpAuditCleanupInterval = 24 * time.Hour
)

func (a *App) mcpHandler() http.Handler {
	handler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		principal, _ := r.Context().Value(mcpPrincipalContextKey{}).(mcpPrincipal)
		return a.newMCPServer(principal)
	}, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !a.validMCPOrigin(r) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		principal, err := a.authenticateMCPToken(r)
		if err != nil {
			if !errors.Is(err, errMCPTokenUnauthorized) {
				log.Printf("mcp authenticate: %v", err)
				http.Error(w, "internal server error", http.StatusInternalServerError)
				return
			}
			w.Header().Set("WWW-Authenticate", `Bearer realm="Koinote MCP"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		key := "mcp:token:" + strconv.FormatInt(principal.TokenID, 10)
		if !a.rateLimit().allow(key, mcpRequestsPerMinute, time.Minute) {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, mcpMaxRequestBytes)
		}
		handler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), mcpPrincipalContextKey{}, principal)))
	})
}

type mcpPrincipalContextKey struct{}

func (a *App) validMCPOrigin(r *http.Request) bool {
	rawOrigin := strings.TrimSpace(r.Header.Get("Origin"))
	if rawOrigin == "" {
		return true
	}
	origin, err := url.Parse(rawOrigin)
	if err != nil || origin.Scheme == "" || origin.Host == "" || origin.User != nil {
		return false
	}
	appURL, err := url.Parse(a.cfg.AppURL)
	if err != nil {
		return false
	}
	return strings.EqualFold(origin.Scheme, appURL.Scheme) && strings.EqualFold(origin.Host, appURL.Host)
}

func (a *App) newMCPServer(principal mcpPrincipal) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{
		Name: "koinote", Title: "Koinote Documents", Version: mcpServerVersion,
		WebsiteURL: strings.TrimRight(a.cfg.AppURL, "/"),
	}, nil)

	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: boolPtr(false)}
	mcp.AddTool(server, &mcp.Tool{
		Name: "list_documents", Title: "List documents",
		Description: "List the authenticated member's own Koinote documents in recently-edited order. Optionally filter by folderId. Results are paginated and never include document content.",
		Annotations: readOnly,
	}, a.mcpListDocuments)
	mcp.AddTool(server, &mcp.Tool{
		Name: "search_documents", Title: "Search documents",
		Description: "Search the authenticated member's own document titles and Markdown bodies. Optionally filter by folderId; use null or an empty string for root documents. Results include a matching content snippet and never expose another member's documents.",
		Annotations: readOnly,
	}, a.mcpSearchDocuments)
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_document", Title: "Read a document",
		Description: "Read a character range from one of the authenticated member's own documents. Use offset and limit to continue when hasMore is true.",
		Annotations: readOnly,
	}, a.mcpGetDocument)
	mcp.AddTool(server, &mcp.Tool{
		Name: "list_document_versions", Title: "List document versions",
		Description: "List retained recovery snapshots for one of the authenticated member's documents. Content is omitted; call get_document_version for a snapshot.",
		Annotations: readOnly,
	}, a.mcpListDocumentVersions)
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_document_version", Title: "Read a document version",
		Description: "Read a character range from a retained recovery snapshot owned by the authenticated member.",
		Annotations: readOnly,
	}, a.mcpGetDocumentVersion)
	mcp.AddTool(server, &mcp.Tool{
		Name: "list_trashed_documents", Title: "List trashed documents",
		Description: "List the authenticated member's documents waiting in the 30-day trash. Content is omitted.",
		Annotations: readOnly,
	}, a.mcpListTrashedDocuments)
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_document_history_settings", Title: "Get document history settings",
		Description: "Read the authenticated member's version-history policy, including whether regular history and full MCP history are enabled. MCP writes retain one latest safety snapshot even when either setting is off.",
		Annotations: readOnly,
	}, a.mcpGetDocumentHistorySettings)
	mcp.AddTool(server, &mcp.Tool{
		Name: "list_folders", Title: "List folders",
		Description: "List the authenticated member's folder tree with document counts. Results are paginated; folder names and IDs never cross account boundaries.",
		Annotations: readOnly,
	}, a.mcpListFolders)
	mcp.AddTool(server, &mcp.Tool{
		Name: "list_wechat_accounts", Title: "List WeChat accounts",
		Description: "List the authenticated member's bound WeChat Official Accounts, including labels, AppIDs, and which account is default. Secrets are never returned.",
		Annotations: readOnly,
	}, a.mcpListWechatAccounts)
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_wechat_geo_summary", Title: "Get WeChat GEO summary",
		Description: "Read the saved WeChat GEO summary for one of the authenticated member's documents. Reports whether it is stale relative to the current document and never generates or charges credits.",
		Annotations: readOnly,
	}, a.mcpGetWechatGeoSummary)
	mcp.AddTool(server, &mcp.Tool{
		Name: "list_document_themes", Title: "List document themes",
		Description: "List every supported Koinote WeChat document theme ID. The empty ID means no theme; use these IDs with create_document or update_document_metadata.",
		Annotations: readOnly,
	}, a.mcpListDocumentThemes)
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_agent_credits", Title: "Get agent credits",
		Description: "Read the authenticated member's current AI credits balance, active reservations, and available credits. This never creates a reservation or charges credits.",
		Annotations: readOnly,
	}, a.mcpGetAgentCredits)
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_document_outline", Title: "Get document outline",
		Description: "Read up to 500 heading entries from one of the authenticated member's documents without loading the full body. Check headingsTruncated for very large outlines.",
		Annotations: readOnly,
	}, a.mcpGetDocumentOutline)
	mcp.AddTool(server, &mcp.Tool{
		Name: "get_document_context", Title: "Get document context",
		Description: "Read a document chunk together with up to 500 heading entries, reducing round trips for agents working on a long document. Check headingsTruncated for very large outlines.",
		Annotations: readOnly,
	}, a.mcpGetDocumentContext)
	mcp.AddTool(server, &mcp.Tool{
		Name: "compare_document_versions", Title: "Compare document versions",
		Description: "Compare two retained revisions or the current revision and return metadata and unique-line change counts without exposing another member's content.",
		Annotations: readOnly,
	}, a.mcpCompareDocumentVersions)
	mcp.AddTool(server, &mcp.Tool{
		Name: "find_text_in_document", Title: "Find text in a document",
		Description: "Find exact, case-insensitive text matches in one of the authenticated member's documents and return Unicode offsets with nearby context.",
		Annotations: readOnly,
	}, a.mcpFindTextInDocument)
	addWechatGeoTools := func(annotations *mcp.ToolAnnotations) {
		mcp.AddTool(server, &mcp.Tool{
			Name: "generate_wechat_geo_summary", Title: "Generate WeChat GEO summary",
			Description: "Generate and save a WeChat GEO summary from the current document using the member's configured AI provider. Built-in provider usage consumes credits; BYOK usage does not. Requires lifetime membership and may take up to 90 seconds.",
			Annotations: annotations,
		}, a.mcpGenerateWechatGeoSummary)
		mcp.AddTool(server, &mcp.Tool{
			Name: "update_wechat_geo_summary", Title: "Update WeChat GEO summary",
			Description: "Edit the saved WeChat GEO summary text or enable/disable its inclusion in WeChat exports. This does not call the model or consume credits.",
			Annotations: annotations,
		}, a.mcpUpdateWechatGeoSummary)
	}

	if principal.canWrite() {
		additive := &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)}
		destructive := &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: boolPtr(true), OpenWorldHint: boolPtr(false)}
		mcp.AddTool(server, &mcp.Tool{
			Name: "create_document", Title: "Create a document",
			Description: "Create a new Koinote Markdown document, optionally in a folder and with a WeChat theme. This is additive and does not modify existing documents.",
			Annotations: additive,
		}, a.mcpCreateDocument)
		mcp.AddTool(server, &mcp.Tool{
			Name: "append_to_document", Title: "Append to a document",
			Description: "Append Markdown to an existing document only if expectedRevision still matches. Read the document again and retry after a revision conflict.",
			Annotations: additive,
		}, a.mcpAppendDocument)
		mcp.AddTool(server, &mcp.Tool{
			Name: "update_document", Title: "Replace a document",
			Description: "Replace an existing document only if expectedRevision still matches. Lifetime members retain the previous state: full MCP history when enabled, otherwise the latest safety snapshot only.",
			Annotations: destructive,
		}, a.mcpUpdateDocument)
		mcp.AddTool(server, &mcp.Tool{
			Name: "restore_document_version", Title: "Restore a document version",
			Description: "Restore a retained snapshot only if expectedRevision still matches. Lifetime members retain the replaced state: full MCP history when enabled, otherwise the latest safety snapshot only.",
			Annotations: destructive,
		}, a.mcpRestoreDocumentVersion)
		mcp.AddTool(server, &mcp.Tool{
			Name: "trash_document", Title: "Move a document to trash",
			Description: "Move a document to the 30-day trash only if expectedRevision still matches. It can be restored before automatic deletion.",
			Annotations: destructive,
		}, a.mcpTrashDocument)
		mcp.AddTool(server, &mcp.Tool{
			Name: "restore_trashed_document", Title: "Restore a trashed document",
			Description: "Restore a document from the 30-day trash only if expectedRevision still matches.",
			Annotations: destructive,
		}, a.mcpRestoreTrashedDocument)
		mcp.AddTool(server, &mcp.Tool{
			Name: "update_document_history_settings", Title: "Update document history settings",
			Description: "Set whether regular history and full MCP history are enabled and how many versions each document keeps. MCP writes still maintain one latest safety snapshot when either history setting is off. Lowering the limit prunes immediately.",
			Annotations: destructive,
		}, a.mcpUpdateDocumentHistorySettings)
		mcp.AddTool(server, &mcp.Tool{
			Name: "create_folder", Title: "Create a folder",
			Description: "Create a folder under the authenticated member's folder tree. Creating the same request twice is not automatically deduplicated.",
			Annotations: additive,
		}, a.mcpCreateFolder)
		mcp.AddTool(server, &mcp.Tool{
			Name: "rename_folder", Title: "Rename a folder",
			Description: "Rename one of the authenticated member's folders.",
			Annotations: destructive,
		}, a.mcpRenameFolder)
		mcp.AddTool(server, &mcp.Tool{
			Name: "move_folder", Title: "Move a folder",
			Description: "Move a folder under another folder or to the root. Cycles and nesting deeper than the product limit are rejected.",
			Annotations: destructive,
		}, a.mcpMoveFolder)
		mcp.AddTool(server, &mcp.Tool{
			Name: "move_document", Title: "Move a document",
			Description: "Move one of the authenticated member's documents into a folder or back to the root.",
			Annotations: destructive,
		}, a.mcpMoveDocument)
		mcp.AddTool(server, &mcp.Tool{
			Name: "batch_move_documents", Title: "Move documents in bulk",
			Description: "Move up to 100 of the authenticated member's documents into one folder or back to the root. The operation is all-or-nothing.",
			Annotations: destructive,
		}, a.mcpBatchMoveDocuments)
		mcp.AddTool(server, &mcp.Tool{
			Name: "delete_folder", Title: "Delete a folder",
			Description: "Delete a folder while lifting its child folders and documents to the deleted folder's parent. Documents are not deleted.",
			Annotations: destructive,
		}, a.mcpDeleteFolder)
		mcp.AddTool(server, &mcp.Tool{
			Name: "update_document_metadata", Title: "Update document metadata",
			Description: "Update a document's title and/or WeChat theme with revision protection, without resending its Markdown body.",
			Annotations: destructive,
		}, a.mcpUpdateDocumentMetadata)
		mcp.AddTool(server, &mcp.Tool{
			Name: "apply_text_patch", Title: "Apply text patches",
			Description: "Apply one or more unique exact-text replacements to a document only if expectedRevision still matches. Read the document again after a conflict or ambiguous anchor.",
			Annotations: destructive,
		}, a.mcpApplyTextPatch)
		addWechatGeoTools(destructive)
	}
	if principal.canPublish() {
		addWechatGeoTools(&mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: boolPtr(true), OpenWorldHint: boolPtr(false)})
		publish := &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: boolPtr(false), IdempotentHint: false, OpenWorldHint: boolPtr(true)}
		mcp.AddTool(server, &mcp.Tool{
			Name: "push_wechat_draft", Title: "Push a WeChat draft",
			Description: "Render one of the authenticated member's documents as basic HTML (the document's Koinote WeChat theme is not applied by this MCP tool) and create a draft in a bound WeChat Official Account. This is an external side effect and may upload article images. Set includeGeo=true only when you explicitly want the current enabled, non-stale GEO summary embedded in the draft.",
			Annotations: publish,
		}, a.mcpPushWechatDraft)
	}
	return server
}

type mcpDocumentHistorySettingsInput struct {
	Enabled        bool `json:"enabled" jsonschema:"Whether browser and regular document changes create new version-history snapshots. This does not disable the latest MCP safety snapshot."`
	PerDocumentMax int  `json:"perDocumentMax" jsonschema:"Maximum retained snapshots per document, from 1 to 100. Safety snapshots count toward this and the 100-version account limit."`
	MCPEnabled     bool `json:"mcpEnabled" jsonschema:"Whether MCP document writes keep full history. When false, MCP writes still maintain the latest safety snapshot for each changed document."`
}

func (a *App) mcpGetDocumentHistorySettings(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, documentHistorySettings, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_document_history_settings", "", result, started) }()
	settings, err := a.loadDocumentHistorySettings(ctx, principal.User.ID, principal.User.MembershipTier)
	if err != nil {
		return nil, documentHistorySettings{}, mcpInternalError("get document history settings", err)
	}
	result = "success"
	return nil, settings, nil
}

func (a *App) mcpUpdateDocumentHistorySettings(ctx context.Context, _ *mcp.CallToolRequest, input mcpDocumentHistorySettingsInput) (*mcp.CallToolResult, documentHistorySettings, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "update_document_history_settings", "", result, started) }()
	if input.PerDocumentMax < 1 || input.PerDocumentMax > maxDocumentHistoryLimit {
		return nil, documentHistorySettings{}, errors.New("perDocumentMax must be between 1 and 100")
	}
	settings, err := a.updateDocumentHistorySettings(ctx, userRef{
		ID: principal.User.ID, AuthUserID: principal.User.AuthUserID,
	}, input.Enabled, input.PerDocumentMax, input.MCPEnabled)
	if err != nil {
		return nil, documentHistorySettings{}, mcpInternalError("update document history settings", err)
	}
	result = "success"
	return nil, settings, nil
}

type mcpPageInput struct {
	Cursor string `json:"cursor,omitempty" jsonschema:"Opaque cursor returned by the previous call."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Number of results, from 1 to 100. Defaults to 50."`
}

type mcpListDocumentsInput struct {
	Cursor   string  `json:"cursor,omitempty" jsonschema:"Opaque cursor returned by the previous call."`
	Limit    int     `json:"limit,omitempty" jsonschema:"Number of results, from 1 to 100. Defaults to 50."`
	FolderID *string `json:"folderId,omitempty" jsonschema:"Optional folder ID. Omit it to list all documents; use null or an empty string for root documents."`
}

type mcpDocumentSummary struct {
	DocID          string `json:"docId"`
	Title          string `json:"title"`
	Snippet        string `json:"snippet,omitempty"`
	TitleMatched   bool   `json:"titleMatched,omitempty"`
	ContentMatched bool   `json:"contentMatched,omitempty"`
	FolderID       string `json:"folderId,omitempty"`
	Revision       int64  `json:"revision"`
	UpdatedAt      string `json:"updatedAt"`
}

type mcpDocumentPage struct {
	Documents  []mcpDocumentSummary `json:"documents"`
	NextCursor string               `json:"nextCursor,omitempty"`
}

type mcpTrashedDocumentSummary struct {
	DocID     string `json:"docId"`
	Title     string `json:"title"`
	Revision  int64  `json:"revision"`
	TrashedAt string `json:"trashedAt"`
	DeletesAt string `json:"deletesAt"`
}

type mcpTrashedDocumentPage struct {
	Documents  []mcpTrashedDocumentSummary `json:"documents"`
	NextCursor string                      `json:"nextCursor,omitempty"`
}

func (a *App) mcpListTrashedDocuments(ctx context.Context, _ *mcp.CallToolRequest, input mcpPageInput) (*mcp.CallToolResult, mcpTrashedDocumentPage, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "list_trashed_documents", "", result, started) }()
	offset, limit, err := parseMCPPage(input.Cursor, input.Limit)
	if err != nil {
		return nil, mcpTrashedDocumentPage{}, err
	}
	rows, err := a.db.Query(ctx, `
		SELECT doc_id, title, revision, trashed_at
		FROM documents
		WHERE user_id = $1 AND trashed_at IS NOT NULL
		ORDER BY trashed_at DESC, id DESC
		LIMIT $2 OFFSET $3
	`, principal.User.ID, limit+1, offset)
	if err != nil {
		return nil, mcpTrashedDocumentPage{}, mcpInternalError("list trashed documents", err)
	}
	defer rows.Close()
	page := mcpTrashedDocumentPage{Documents: make([]mcpTrashedDocumentSummary, 0, limit)}
	for rows.Next() {
		var item mcpTrashedDocumentSummary
		var trashedAt time.Time
		if err := rows.Scan(&item.DocID, &item.Title, &item.Revision, &trashedAt); err != nil {
			return nil, mcpTrashedDocumentPage{}, mcpInternalError("scan trashed documents", err)
		}
		item.TrashedAt = trashedAt.UTC().Format(time.RFC3339)
		item.DeletesAt = trashedAt.Add(documentTrashRetention).UTC().Format(time.RFC3339)
		page.Documents = append(page.Documents, item)
	}
	if err := rows.Err(); err != nil {
		return nil, mcpTrashedDocumentPage{}, mcpInternalError("iterate trashed documents", err)
	}
	if len(page.Documents) > limit {
		page.Documents = page.Documents[:limit]
		page.NextCursor = encodeMCPCursor(offset + limit)
	}
	result = "success"
	return nil, page, nil
}

func (a *App) mcpListDocuments(ctx context.Context, _ *mcp.CallToolRequest, input mcpListDocumentsInput) (*mcp.CallToolResult, mcpDocumentPage, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "list_documents", "", result, started) }()
	offset, limit, err := parseMCPPage(input.Cursor, input.Limit)
	if err != nil {
		return nil, mcpDocumentPage{}, err
	}
	folderID := ""
	if input.FolderID != nil {
		folderID = strings.TrimSpace(*input.FolderID)
		if folderID != "" {
			if err := a.ensureMCPFolder(ctx, principal.User.ID, folderID); err != nil {
				return nil, mcpDocumentPage{}, err
			}
		}
	}
	var requestedFolderID *string
	if input.FolderID != nil {
		requestedFolderID = &folderID
	}
	rows, err := a.db.Query(ctx, `
		SELECT d.doc_id, d.title, d.revision, d.updated_at, COALESCE(f.folder_id, '')
		FROM documents d
		LEFT JOIN folders f ON f.id = d.folder_id AND f.user_id = d.user_id
		WHERE d.user_id = $1 AND d.trashed_at IS NULL
		  AND ($4::text IS NULL OR ($4 = '' AND d.folder_id IS NULL) OR f.folder_id = $4)
		ORDER BY d.updated_at DESC, d.id DESC
		LIMIT $2 OFFSET $3
	`, principal.User.ID, limit+1, offset, requestedFolderID)
	if err != nil {
		return nil, mcpDocumentPage{}, mcpInternalError("list documents", err)
	}
	defer rows.Close()
	page := mcpDocumentPage{Documents: make([]mcpDocumentSummary, 0, limit)}
	for rows.Next() {
		var item mcpDocumentSummary
		var updated time.Time
		if err := rows.Scan(&item.DocID, &item.Title, &item.Revision, &updated, &item.FolderID); err != nil {
			return nil, mcpDocumentPage{}, mcpInternalError("scan documents", err)
		}
		item.UpdatedAt = updated.UTC().Format(time.RFC3339)
		page.Documents = append(page.Documents, item)
	}
	if rows.Err() != nil {
		return nil, mcpDocumentPage{}, mcpInternalError("iterate documents", rows.Err())
	}
	if len(page.Documents) > limit {
		page.Documents = page.Documents[:limit]
		page.NextCursor = encodeMCPCursor(offset + limit)
	}
	result = "success"
	return nil, page, nil
}

type mcpSearchDocumentsInput struct {
	Query    string  `json:"query" jsonschema:"Non-empty text to find in document titles or Markdown bodies."`
	Cursor   string  `json:"cursor,omitempty" jsonschema:"Opaque cursor returned by the previous call."`
	Limit    int     `json:"limit,omitempty" jsonschema:"Number of results, from 1 to 100. Defaults to 50."`
	FolderID *string `json:"folderId,omitempty" jsonschema:"Optional folder ID. Omit it to search all documents; use null or an empty string for root documents."`
}

func (a *App) mcpSearchDocuments(ctx context.Context, _ *mcp.CallToolRequest, input mcpSearchDocumentsInput) (*mcp.CallToolResult, mcpDocumentPage, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "search_documents", "", result, started) }()
	query := strings.TrimSpace(input.Query)
	if query == "" || utf8.RuneCountInString(query) > 200 {
		return nil, mcpDocumentPage{}, errors.New("query must contain 1 to 200 characters")
	}
	offset, limit, err := parseMCPPage(input.Cursor, input.Limit)
	if err != nil {
		return nil, mcpDocumentPage{}, err
	}
	var folderID *string
	if input.FolderID != nil {
		normalizedFolderID := strings.TrimSpace(*input.FolderID)
		folderID = &normalizedFolderID
		if normalizedFolderID != "" {
			if err := a.ensureMCPFolder(ctx, principal.User.ID, normalizedFolderID); err != nil {
				return nil, mcpDocumentPage{}, err
			}
		}
	}
	items, err := a.searchDocuments(ctx, principal.User.ID, query, limit+1, offset, folderID)
	if err != nil {
		return nil, mcpDocumentPage{}, mcpInternalError("search documents", err)
	}
	page := mcpDocumentPage{Documents: make([]mcpDocumentSummary, 0, limit)}
	for _, item := range items {
		updatedAt := ""
		if item.UpdatedAt != nil {
			updatedAt = item.UpdatedAt.UTC().Format(time.RFC3339)
		}
		page.Documents = append(page.Documents, mcpDocumentSummary{
			DocID: item.DocID, Title: item.Title, Snippet: item.Snippet,
			TitleMatched: item.TitleMatched, ContentMatched: item.ContentMatched,
			FolderID: item.FolderID,
			Revision: item.Revision, UpdatedAt: updatedAt,
		})
	}
	if len(page.Documents) > limit {
		page.Documents = page.Documents[:limit]
		page.NextCursor = encodeMCPCursor(offset + limit)
	}
	result = "success"
	return nil, page, nil
}

type mcpGetDocumentInput struct {
	DocID  string `json:"docId" jsonschema:"Koinote document ID."`
	Offset int    `json:"offset,omitempty" jsonschema:"Zero-based Unicode character offset. Defaults to 0."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Maximum Unicode characters to return, up to 40000. Defaults to 12000."`
}

type mcpDocumentChunk struct {
	DocID           string `json:"docId"`
	Title           string `json:"title"`
	Theme           string `json:"theme"`
	Revision        int64  `json:"revision"`
	Content         string `json:"content"`
	Offset          int    `json:"offset"`
	NextOffset      int    `json:"nextOffset"`
	TotalCharacters int    `json:"totalCharacters"`
	HasMore         bool   `json:"hasMore"`
	UpdatedAt       string `json:"updatedAt"`
}

func (a *App) mcpGetDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpGetDocumentInput) (*mcp.CallToolResult, mcpDocumentChunk, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_document", input.DocID, result, started) }()
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, mcpDocumentChunk{}, err
	}
	chunk, err := chunkDocument(doc, input.Offset, input.Limit)
	if err != nil {
		return nil, mcpDocumentChunk{}, err
	}
	result = "success"
	return nil, chunk, nil
}

type mcpCreateDocumentInput struct {
	Title    string  `json:"title,omitempty" jsonschema:"Document title, up to 200 characters."`
	Content  string  `json:"content,omitempty" jsonschema:"Markdown content, up to 1 MiB."`
	Theme    *string `json:"theme,omitempty" jsonschema:"Optional Koinote WeChat theme ID."`
	FolderID *string `json:"folderId,omitempty" jsonschema:"Optional folder ID. Omit to create at the root."`
}

type mcpDocumentMutationOutput struct {
	DocID     string `json:"docId"`
	Title     string `json:"title"`
	Revision  int64  `json:"revision"`
	UpdatedAt string `json:"updatedAt"`
}

func (a *App) mcpCreateDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpCreateDocumentInput) (*mcp.CallToolResult, mcpDocumentMutationOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	docID := ""
	defer func() { a.auditMCPCall(principal, "create_document", docID, result, started) }()
	title, content, err := validateMCPDocumentInput(input.Title, input.Content)
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, err
	}
	var theme *string
	if input.Theme != nil {
		normalizedTheme, themeErr := validateMCPDocumentTheme(*input.Theme)
		if themeErr != nil {
			return nil, mcpDocumentMutationOutput{}, themeErr
		}
		theme = &normalizedTheme
	}
	folderID := derefOrEmpty(input.FolderID)
	var normalizedFolderID *string
	if folderID != "" {
		if err := a.ensureMCPFolder(ctx, principal.User.ID, folderID); err != nil {
			return nil, mcpDocumentMutationOutput{}, err
		}
		normalizedFolderID = &folderID
	}
	doc, err := a.createDocument(ctx, createDocumentParams{User: principal.User, Title: title, Content: content, Theme: theme, FolderID: normalizedFolderID})
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(err)
	}
	docID = doc.DocID
	result = "success"
	return nil, mutationOutput(doc), nil
}

type mcpUpdateDocumentInput struct {
	DocID            string  `json:"docId" jsonschema:"Koinote document ID."`
	ExpectedRevision int64   `json:"expectedRevision" jsonschema:"Revision returned by get_document. The update fails if the document changed meanwhile."`
	Title            string  `json:"title" jsonschema:"Complete replacement title, up to 200 characters."`
	Content          string  `json:"content" jsonschema:"Complete replacement Markdown content, up to 1 MiB."`
	Theme            *string `json:"theme,omitempty" jsonschema:"Optional Koinote WeChat theme ID. Omit it to preserve the current theme; send an empty string to remove the theme."`
}

func (a *App) mcpUpdateDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpUpdateDocumentInput) (*mcp.CallToolResult, mcpDocumentMutationOutput, error) {
	return a.mutateMCPDocument(ctx, "update_document", input.DocID, input.ExpectedRevision, input.Title, input.Content, input.Theme)
}

type mcpAppendDocumentInput struct {
	DocID            string `json:"docId" jsonschema:"Koinote document ID."`
	ExpectedRevision int64  `json:"expectedRevision" jsonschema:"Revision returned by get_document. The append fails if the document changed meanwhile."`
	Content          string `json:"content" jsonschema:"Markdown to append. It is added verbatim."`
	Separator        string `json:"separator,omitempty" jsonschema:"Text inserted before content. Defaults to two newlines."`
}

func (a *App) mcpAppendDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpAppendDocumentInput) (*mcp.CallToolResult, mcpDocumentMutationOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "append_to_document", input.DocID, result, started) }()
	if input.ExpectedRevision <= 0 {
		return nil, mcpDocumentMutationOutput{}, errors.New("expectedRevision must be positive")
	}
	if input.Content == "" {
		return nil, mcpDocumentMutationOutput{}, errors.New("content must not be empty")
	}
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, err
	}
	if doc.Revision != input.ExpectedRevision {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(errDocumentRevisionConflict)
	}
	separator := input.Separator
	if separator == "" {
		separator = "\n\n"
	}
	content := doc.Content
	if content == "" {
		separator = ""
	}
	content += separator + input.Content
	_, content, err = validateMCPDocumentInput(doc.Title, content)
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, err
	}
	updated, err := a.updateDocument(ctx, updateDocumentParams{
		User: principal.User, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
		Content: content, ExpectedRevision: input.ExpectedRevision,
		Source: documentSourceMCP, SourceTokenID: &principal.TokenID,
	})
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(err)
	}
	result = "success"
	return nil, mutationOutput(updated), nil
}

func (a *App) mutateMCPDocument(ctx context.Context, toolName, docID string, expectedRevision int64, title, content string, theme *string) (*mcp.CallToolResult, mcpDocumentMutationOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, toolName, docID, result, started) }()
	if expectedRevision <= 0 {
		return nil, mcpDocumentMutationOutput{}, errors.New("expectedRevision must be positive")
	}
	title, content, err := validateMCPDocumentInput(title, content)
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, err
	}
	themeID := ""
	if theme == nil {
		currentTheme, loadErr := a.loadMCPDocumentTheme(ctx, principal.User.ID, docID)
		if loadErr != nil {
			return nil, mcpDocumentMutationOutput{}, loadErr
		}
		themeID = currentTheme
	} else {
		var themeErr error
		themeID, themeErr = validateMCPDocumentTheme(*theme)
		if themeErr != nil {
			return nil, mcpDocumentMutationOutput{}, themeErr
		}
	}
	doc, err := a.updateDocument(ctx, updateDocumentParams{
		User: principal.User, DocID: strings.TrimSpace(docID), Title: title,
		Theme: themeID, Content: content,
		ExpectedRevision: expectedRevision, Source: documentSourceMCP,
		SourceTokenID: &principal.TokenID,
	})
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(err)
	}
	result = "success"
	return nil, mutationOutput(doc), nil
}

type mcpVersionInput struct {
	DocID string `json:"docId" jsonschema:"Koinote document ID."`
}

type mcpVersionSummary struct {
	Revision       int64  `json:"revision"`
	Title          string `json:"title"`
	Source         string `json:"source"`
	SafetySnapshot bool   `json:"safetySnapshot"`
	CreatedAt      string `json:"createdAt"`
}

type mcpVersionPage struct {
	Versions []mcpVersionSummary `json:"versions"`
}

func (a *App) mcpListDocumentVersions(ctx context.Context, _ *mcp.CallToolRequest, input mcpVersionInput) (*mcp.CallToolResult, mcpVersionPage, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "list_document_versions", input.DocID, result, started) }()
	rows, err := a.db.Query(ctx, `
		SELECT v.revision, v.title, v.source, v.safety_snapshot, v.created_at
		FROM document_versions v
		JOIN documents d ON d.id = v.document_id
		WHERE d.doc_id = $1 AND d.user_id = $2 AND d.trashed_at IS NULL
		ORDER BY v.revision DESC
	`, strings.TrimSpace(input.DocID), principal.User.ID)
	if err != nil {
		return nil, mcpVersionPage{}, mcpInternalError("list document versions", err)
	}
	defer rows.Close()
	page := mcpVersionPage{Versions: make([]mcpVersionSummary, 0)}
	for rows.Next() {
		var item mcpVersionSummary
		var created time.Time
		if err := rows.Scan(&item.Revision, &item.Title, &item.Source, &item.SafetySnapshot, &created); err != nil {
			return nil, mcpVersionPage{}, mcpInternalError("scan document versions", err)
		}
		item.CreatedAt = created.UTC().Format(time.RFC3339)
		page.Versions = append(page.Versions, item)
	}
	if rows.Err() != nil {
		return nil, mcpVersionPage{}, mcpInternalError("iterate document versions", rows.Err())
	}
	result = "success"
	return nil, page, nil
}

type mcpGetVersionInput struct {
	DocID    string `json:"docId" jsonschema:"Koinote document ID."`
	Revision int64  `json:"revision" jsonschema:"Retained revision number."`
	Offset   int    `json:"offset,omitempty" jsonschema:"Zero-based Unicode character offset."`
	Limit    int    `json:"limit,omitempty" jsonschema:"Maximum Unicode characters to return, up to 40000."`
}

type mcpVersionChunk struct {
	DocID           string `json:"docId"`
	Title           string `json:"title"`
	Theme           string `json:"theme"`
	Revision        int64  `json:"revision"`
	Source          string `json:"source"`
	SafetySnapshot  bool   `json:"safetySnapshot"`
	Content         string `json:"content"`
	Offset          int    `json:"offset"`
	NextOffset      int    `json:"nextOffset"`
	TotalCharacters int    `json:"totalCharacters"`
	HasMore         bool   `json:"hasMore"`
	CreatedAt       string `json:"createdAt"`
}

func (a *App) mcpGetDocumentVersion(ctx context.Context, _ *mcp.CallToolRequest, input mcpGetVersionInput) (*mcp.CallToolResult, mcpVersionChunk, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_document_version", input.DocID, result, started) }()
	version, err := a.loadMCPDocumentVersion(ctx, principal.User.ID, input.DocID, input.Revision)
	if err != nil {
		return nil, mcpVersionChunk{}, err
	}
	content, offset, nextOffset, total, hasMore, err := chunkText(version.Content, input.Offset, input.Limit)
	if err != nil {
		return nil, mcpVersionChunk{}, err
	}
	result = "success"
	return nil, mcpVersionChunk{
		DocID: input.DocID, Title: version.Title, Theme: version.Theme,
		Revision: version.Revision, Source: version.Source,
		SafetySnapshot: version.SafetySnapshot, Content: content,
		Offset: offset, NextOffset: nextOffset, TotalCharacters: total, HasMore: hasMore,
		CreatedAt: version.CreatedAt.UTC().Format(time.RFC3339),
	}, nil
}

type mcpRestoreVersionInput struct {
	DocID            string `json:"docId" jsonschema:"Koinote document ID."`
	Revision         int64  `json:"revision" jsonschema:"Retained revision to restore."`
	ExpectedRevision int64  `json:"expectedRevision" jsonschema:"Current revision returned by get_document."`
}

func (a *App) mcpRestoreDocumentVersion(ctx context.Context, _ *mcp.CallToolRequest, input mcpRestoreVersionInput) (*mcp.CallToolResult, mcpDocumentMutationOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "restore_document_version", input.DocID, result, started) }()
	if input.ExpectedRevision <= 0 || input.Revision <= 0 {
		return nil, mcpDocumentMutationOutput{}, errors.New("revision and expectedRevision must be positive")
	}
	version, err := a.loadMCPDocumentVersion(ctx, principal.User.ID, input.DocID, input.Revision)
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, err
	}
	doc, err := a.updateDocument(ctx, updateDocumentParams{
		User: principal.User, DocID: input.DocID, Title: version.Title, Theme: version.Theme,
		Content: version.Content, ExpectedRevision: input.ExpectedRevision,
		Source: documentSourceRestore, SourceTokenID: &principal.TokenID,
	})
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(err)
	}
	result = "success"
	return nil, mutationOutput(doc), nil
}

type mcpTrashDocumentInput struct {
	DocID            string `json:"docId" jsonschema:"Koinote document ID."`
	ExpectedRevision int64  `json:"expectedRevision" jsonschema:"Revision returned by get_document. The trash operation fails if the document changed meanwhile."`
}

type mcpTrashedDocumentOutput struct {
	DocID     string `json:"docId"`
	Title     string `json:"title"`
	Revision  int64  `json:"revision"`
	TrashedAt string `json:"trashedAt"`
	DeletesAt string `json:"deletesAt"`
}

func (a *App) mcpTrashDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpTrashDocumentInput) (*mcp.CallToolResult, mcpTrashedDocumentOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "trash_document", input.DocID, result, started) }()
	if input.ExpectedRevision <= 0 {
		return nil, mcpTrashedDocumentOutput{}, errors.New("expectedRevision must be positive")
	}
	doc, err := a.trashDocument(ctx, principal.User, input.DocID, input.ExpectedRevision)
	if err != nil {
		return nil, mcpTrashedDocumentOutput{}, mapMCPDocumentError(err)
	}
	result = "success"
	return nil, mcpTrashedDocumentOutput{
		DocID: doc.DocID, Title: doc.Title, Revision: doc.Revision,
		TrashedAt: doc.TrashedAt.UTC().Format(time.RFC3339),
		DeletesAt: doc.TrashedAt.Add(documentTrashRetention).UTC().Format(time.RFC3339),
	}, nil
}

func (a *App) mcpRestoreTrashedDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpTrashDocumentInput) (*mcp.CallToolResult, mcpDocumentMutationOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "restore_trashed_document", input.DocID, result, started) }()
	if input.ExpectedRevision <= 0 {
		return nil, mcpDocumentMutationOutput{}, errors.New("expectedRevision must be positive")
	}
	doc, err := a.restoreTrashedDocument(ctx, principal.User, input.DocID, input.ExpectedRevision)
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(err)
	}
	result = "success"
	return nil, mutationOutput(doc), nil
}

func (a *App) loadMCPDocument(ctx context.Context, userID int, docID string) (model.Document, error) {
	var doc model.Document
	err := a.db.QueryRow(ctx, `
		SELECT doc_id, title, theme, content, revision, created_at, updated_at
		FROM documents WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
	`, strings.TrimSpace(docID), userID).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.Revision,
		&doc.CreatedAt, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Document{}, errors.New("document not found")
	}
	if err != nil {
		return model.Document{}, mcpInternalError("get document", err)
	}
	return doc, nil
}

func (a *App) loadMCPDocumentTheme(ctx context.Context, userID int, docID string) (string, error) {
	var theme string
	err := a.db.QueryRow(ctx, `
		SELECT theme
		FROM documents
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
	`, strings.TrimSpace(docID), userID).Scan(&theme)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errors.New("document not found")
	}
	if err != nil {
		return "", mcpInternalError("load document theme", err)
	}
	return theme, nil
}

func (a *App) loadMCPDocumentVersion(ctx context.Context, userID int, docID string, revision int64) (model.DocumentVersion, error) {
	var version model.DocumentVersion
	err := a.db.QueryRow(ctx, `
		SELECT v.revision, v.title, v.theme, v.content, v.source,
		       v.safety_snapshot, v.created_at
		FROM document_versions v
		JOIN documents d ON d.id = v.document_id
		WHERE d.doc_id = $1 AND d.user_id = $2 AND d.trashed_at IS NULL AND v.revision = $3
	`, strings.TrimSpace(docID), userID, revision).Scan(
		&version.Revision, &version.Title, &version.Theme, &version.Content,
		&version.Source, &version.SafetySnapshot, &version.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.DocumentVersion{}, errDocumentVersionNotFound
	}
	if err != nil {
		return model.DocumentVersion{}, mcpInternalError("get document version", err)
	}
	return version, nil
}

func validateMCPDocumentInput(title, content string) (string, string, error) {
	title = strings.TrimSpace(title)
	if utf8.RuneCountInString(title) > maxTitleRunes {
		return "", "", fmt.Errorf("title exceeds %d characters", maxTitleRunes)
	}
	if len(content) > maxContentBytes {
		return "", "", fmt.Errorf("content exceeds %d bytes", maxContentBytes)
	}
	return title, content, nil
}

func validateMCPDocumentTheme(raw string) (string, error) {
	theme := strings.TrimSpace(raw)
	if !documentThemes[theme] {
		return "", errors.New("theme is not a supported Koinote theme ID")
	}
	return theme, nil
}

func chunkDocument(doc model.Document, offset, limit int) (mcpDocumentChunk, error) {
	content, offset, nextOffset, total, hasMore, err := chunkText(doc.Content, offset, limit)
	if err != nil {
		return mcpDocumentChunk{}, err
	}
	updatedAt := ""
	if doc.UpdatedAt != nil {
		updatedAt = doc.UpdatedAt.UTC().Format(time.RFC3339)
	}
	return mcpDocumentChunk{
		DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme, Revision: doc.Revision,
		Content: content, Offset: offset, NextOffset: nextOffset,
		TotalCharacters: total, HasMore: hasMore, UpdatedAt: updatedAt,
	}, nil
}

func chunkText(value string, offset, limit int) (string, int, int, int, bool, error) {
	if offset < 0 {
		return "", 0, 0, 0, false, errors.New("offset must not be negative")
	}
	if limit == 0 {
		limit = mcpDefaultContentRunes
	}
	if limit < 1 || limit > mcpMaxContentRunes {
		return "", 0, 0, 0, false, fmt.Errorf("limit must be between 1 and %d", mcpMaxContentRunes)
	}
	runes := []rune(value)
	if offset > len(runes) {
		return "", 0, 0, 0, false, errors.New("offset exceeds document length")
	}
	end := min(offset+limit, len(runes))
	return string(runes[offset:end]), offset, end, len(runes), end < len(runes), nil
}

func parseMCPPage(cursor string, limit int) (int, int, error) {
	if limit == 0 {
		limit = mcpDefaultPageSize
	}
	if limit < 1 || limit > mcpMaxPageSize {
		return 0, 0, fmt.Errorf("limit must be between 1 and %d", mcpMaxPageSize)
	}
	if cursor == "" {
		return 0, limit, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, 0, errors.New("invalid cursor")
	}
	offset, err := strconv.Atoi(string(decoded))
	if err != nil || offset < 0 || offset > 1_000_000 {
		return 0, 0, errors.New("invalid cursor")
	}
	return offset, limit, nil
}

func encodeMCPCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func mutationOutput(doc model.Document) mcpDocumentMutationOutput {
	updatedAt := ""
	if doc.UpdatedAt != nil {
		updatedAt = doc.UpdatedAt.UTC().Format(time.RFC3339)
	}
	return mcpDocumentMutationOutput{DocID: doc.DocID, Title: doc.Title, Revision: doc.Revision, UpdatedAt: updatedAt}
}

func mcpPrincipalFromContext(ctx context.Context) mcpPrincipal {
	principal, _ := ctx.Value(mcpPrincipalContextKey{}).(mcpPrincipal)
	return principal
}

func mapMCPDocumentError(err error) error {
	switch {
	case errors.Is(err, errDocumentNotFound):
		return errors.New("document not found")
	case errors.Is(err, errDocumentQuotaExceeded):
		return errors.New("cloud storage quota exceeded")
	case errors.Is(err, errDocumentRevisionConflict):
		return errors.New("document revision conflict; read the latest document and retry")
	case errors.Is(err, errDocumentVersionNotFound):
		return errors.New("document version not found")
	case errors.Is(err, errDocumentNotTrashed):
		return errors.New("trashed document not found")
	default:
		return mcpInternalError("mutate document", err)
	}
}

func mcpInternalError(operation string, err error) error {
	log.Printf("mcp %s: %v", operation, err)
	return errors.New("internal server error")
}

func (a *App) auditMCPCall(principal mcpPrincipal, toolName, docID, result string, started time.Time) {
	duration := max(0, int(time.Since(started).Milliseconds()))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := a.db.Exec(ctx, `
		INSERT INTO mcp_audit_logs (user_id, token_id, tool_name, document_id, doc_id, result, duration_ms)
		VALUES (
			$1, $2, $3,
			(SELECT id FROM documents WHERE doc_id = NULLIF($4, '') AND user_id = $1),
			NULLIF($4, ''), $5, $6
		)
	`, principal.User.ID, principal.TokenID, toolName, docID, result, duration)
	if err != nil {
		log.Printf("mcp audit %s: %v", toolName, err)
	}
	if result == "success" {
		a.recordProductMilestoneAsync(principal.User.ID, milestoneMCPConnected)
	}
}

func (a *App) StartMCPAuditCleanup(ctx context.Context) {
	go func() {
		if err := a.runMCPAuditCleanupOnce(ctx); err != nil && ctx.Err() == nil {
			log.Printf("mcp audit cleanup: %v", err)
		}
		ticker := time.NewTicker(mcpAuditCleanupInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.runMCPAuditCleanupOnce(ctx); err != nil && ctx.Err() == nil {
					log.Printf("mcp audit cleanup: %v", err)
				}
			}
		}
	}()
}

func (a *App) runMCPAuditCleanupOnce(ctx context.Context) error {
	_, err := a.db.Exec(ctx, `
		DELETE FROM mcp_audit_logs
		WHERE created_at < now() - $1::interval
	`, mcpAuditRetention.String())
	return err
}

func boolPtr(value bool) *bool {
	return &value
}
