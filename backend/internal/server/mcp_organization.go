package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpBatchMoveMaxDocuments = 100

const mcpMaxOutlineItems = 500

func (a *App) ensureMCPFolder(ctx context.Context, userID int, folderID string) error {
	var exists bool
	if err := a.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM folders WHERE folder_id = $1 AND user_id = $2)`, strings.TrimSpace(folderID), userID).Scan(&exists); err != nil {
		return mcpInternalError("find folder", err)
	}
	if !exists {
		return errors.New("folder not found")
	}
	return nil
}

type mcpFolderSummary struct {
	FolderID       string `json:"folderId"`
	Name           string `json:"name"`
	ParentFolderID string `json:"parentFolderId,omitempty"`
	OrganizerKind  string `json:"organizerKind,omitempty"`
	DocumentCount  int    `json:"documentCount"`
}

type mcpDocumentOutlineItem struct {
	Level  int    `json:"level"`
	Text   string `json:"text"`
	Source string `json:"source"`
}

type mcpFolderPage struct {
	Folders    []mcpFolderSummary `json:"folders"`
	NextCursor string             `json:"nextCursor,omitempty"`
}

type mcpFolderInput struct {
	FolderID string `json:"folderId" jsonschema:"Koinote folder ID."`
}

type mcpDocumentIDInput struct {
	DocID string `json:"docId" jsonschema:"Koinote document ID."`
}

type mcpCreateFolderInput struct {
	Name           string  `json:"name" jsonschema:"Folder name, up to 60 characters."`
	ParentFolderID *string `json:"parentFolderId,omitempty" jsonschema:"Optional parent folder ID. Omit for a root folder."`
}

type mcpMoveFolderInput struct {
	FolderID       string  `json:"folderId" jsonschema:"Koinote folder ID."`
	ParentFolderID *string `json:"parentFolderId,omitempty" jsonschema:"Target parent folder ID. Omit or send null to move to the root."`
}

type mcpRenameFolderInput struct {
	FolderID string `json:"folderId" jsonschema:"Koinote folder ID."`
	Name     string `json:"name" jsonschema:"New folder name, up to 60 characters."`
}

type mcpMoveDocumentInput struct {
	DocID            string  `json:"docId" jsonschema:"Koinote document ID."`
	FolderID         *string `json:"folderId,omitempty" jsonschema:"Target folder ID. Omit or send null to move to the root."`
	ExpectedRevision int64   `json:"expectedRevision,omitempty" jsonschema:"Optional current document revision. When supplied, the move fails if the document changed meanwhile."`
}

type mcpBatchMoveDocumentsInput struct {
	DocIDs   []string `json:"docIds" jsonschema:"One to 100 Koinote document IDs."`
	FolderID *string  `json:"folderId,omitempty" jsonschema:"Target folder ID. Omit or send null to move to the root."`
}

type mcpMoveDocumentsOutput struct {
	Moved    int    `json:"moved"`
	FolderID string `json:"folderId,omitempty"`
}

type mcpUpdateDocumentMetadataInput struct {
	DocID            string  `json:"docId" jsonschema:"Koinote document ID."`
	ExpectedRevision int64   `json:"expectedRevision" jsonschema:"Revision returned by get_document."`
	Title            *string `json:"title,omitempty" jsonschema:"Optional replacement title."`
	Theme            *string `json:"theme,omitempty" jsonschema:"Optional Koinote WeChat theme ID. Send an empty string to remove the theme."`
}

type mcpTextPatch struct {
	Find    string `json:"find" jsonschema:"Exact non-empty text to find. It must occur exactly once in the current document."`
	Replace string `json:"replace" jsonschema:"Replacement text. It may be empty to delete the match."`
}

type mcpApplyTextPatchInput struct {
	DocID            string         `json:"docId" jsonschema:"Koinote document ID."`
	ExpectedRevision int64          `json:"expectedRevision" jsonschema:"Revision returned by get_document."`
	Patches          []mcpTextPatch `json:"patches" jsonschema:"One to 20 exact replacements. All anchors are checked before any write."`
}

func (a *App) mcpListFolders(ctx context.Context, _ *mcp.CallToolRequest, input mcpPageInput) (*mcp.CallToolResult, mcpFolderPage, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "list_folders", "", result, started) }()
	offset, limit, err := parseMCPPage(input.Cursor, input.Limit)
	if err != nil {
		return nil, mcpFolderPage{}, err
	}
	rows, err := a.db.Query(ctx, `
		SELECT f.folder_id, f.name, COALESCE(p.folder_id, ''), COALESCE(f.organizer_kind, ''),
		       COUNT(d.id)
		FROM folders f
		LEFT JOIN folders p ON p.id = f.parent_id AND p.user_id = f.user_id
		LEFT JOIN documents d ON d.folder_id = f.id AND d.user_id = f.user_id AND d.trashed_at IS NULL
		WHERE f.user_id = $1
		GROUP BY f.id, f.folder_id, f.name, p.folder_id, f.organizer_kind
		ORDER BY f.name, f.folder_id
		LIMIT $2 OFFSET $3
	`, principal.User.ID, limit+1, offset)
	if err != nil {
		return nil, mcpFolderPage{}, mcpInternalError("list folders", err)
	}
	defer rows.Close()
	page := mcpFolderPage{Folders: make([]mcpFolderSummary, 0, limit)}
	for rows.Next() {
		var item mcpFolderSummary
		if err := rows.Scan(&item.FolderID, &item.Name, &item.ParentFolderID, &item.OrganizerKind, &item.DocumentCount); err != nil {
			return nil, mcpFolderPage{}, mcpInternalError("scan folders", err)
		}
		page.Folders = append(page.Folders, item)
	}
	if err := rows.Err(); err != nil {
		return nil, mcpFolderPage{}, mcpInternalError("iterate folders", err)
	}
	if len(page.Folders) > limit {
		page.Folders = page.Folders[:limit]
		page.NextCursor = encodeMCPCursor(offset + limit)
	}
	result = "success"
	return nil, page, nil
}

func (a *App) mcpGetDocumentOutline(ctx context.Context, _ *mcp.CallToolRequest, input mcpDocumentIDInput) (*mcp.CallToolResult, map[string]any, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_document_outline", input.DocID, result, started) }()
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, nil, err
	}
	items, truncated := mcpDocumentHeadings(doc.Content)
	result = "success"
	return nil, map[string]any{"docId": doc.DocID, "title": doc.Title, "revision": doc.Revision, "headings": items, "headingsTruncated": truncated}, nil
}

func mcpDocumentHeadings(content string) ([]mcpDocumentOutlineItem, bool) {
	items := make([]mcpDocumentOutlineItem, 0, 32)
	for _, block := range parseMarkdownReviewBlocks(content) {
		if block.Kind != "heading" {
			continue
		}
		if len(items) >= mcpMaxOutlineItems {
			return items, true
		}
		items = append(items, mcpDocumentOutlineItem{
			Level: block.Level, Text: strings.TrimSpace(block.Text), Source: block.Source,
		})
	}
	return items, false
}

type mcpDocumentContextInput struct {
	DocID  string `json:"docId" jsonschema:"Koinote document ID."`
	Offset int    `json:"offset,omitempty" jsonschema:"Zero-based Unicode character offset. Defaults to 0."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Maximum Unicode characters to return, up to 40000."`
}

func (a *App) mcpGetDocumentContext(ctx context.Context, _ *mcp.CallToolRequest, input mcpDocumentContextInput) (*mcp.CallToolResult, map[string]any, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_document_context", input.DocID, result, started) }()
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, nil, err
	}
	chunk, err := chunkDocument(doc, input.Offset, input.Limit)
	if err != nil {
		return nil, nil, err
	}
	headings, headingsTruncated := mcpDocumentHeadings(doc.Content)
	result = "success"
	return nil, map[string]any{
		"docId": doc.DocID, "title": doc.Title, "theme": doc.Theme, "revision": doc.Revision,
		"content": chunk.Content, "offset": chunk.Offset, "nextOffset": chunk.NextOffset,
		"totalCharacters": chunk.TotalCharacters, "hasMore": chunk.HasMore,
		"headings": headings, "headingsTruncated": headingsTruncated,
	}, nil
}

type mcpCompareDocumentVersionsInput struct {
	DocID           string `json:"docId" jsonschema:"Koinote document ID."`
	BaseRevision    int64  `json:"baseRevision" jsonschema:"First retained revision, or the current revision returned by get_document."`
	CompareRevision int64  `json:"compareRevision" jsonschema:"Second retained revision, or the current revision returned by get_document."`
}

func (a *App) mcpCompareDocumentVersions(ctx context.Context, _ *mcp.CallToolRequest, input mcpCompareDocumentVersionsInput) (*mcp.CallToolResult, map[string]any, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "compare_document_versions", input.DocID, result, started) }()
	if input.BaseRevision <= 0 || input.CompareRevision <= 0 {
		return nil, nil, errors.New("baseRevision and compareRevision must be positive")
	}
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, nil, err
	}
	type state struct {
		title, theme, content string
		revision              int64
	}
	load := func(revision int64) (state, error) {
		if revision == doc.Revision {
			return state{title: doc.Title, theme: doc.Theme, content: doc.Content, revision: doc.Revision}, nil
		}
		version, versionErr := a.loadMCPDocumentVersion(ctx, principal.User.ID, doc.DocID, revision)
		if versionErr != nil {
			return state{}, versionErr
		}
		return state{title: version.Title, theme: version.Theme, content: version.Content, revision: version.Revision}, nil
	}
	base, err := load(input.BaseRevision)
	if err != nil {
		return nil, nil, err
	}
	compare, err := load(input.CompareRevision)
	if err != nil {
		return nil, nil, err
	}
	baseLines := strings.Split(base.content, "\n")
	compareLines := strings.Split(compare.content, "\n")
	baseSet := make(map[string]struct{}, len(baseLines))
	compareSet := make(map[string]struct{}, len(compareLines))
	for _, line := range baseLines {
		baseSet[line] = struct{}{}
	}
	for _, line := range compareLines {
		compareSet[line] = struct{}{}
	}
	added, removed := 0, 0
	for line := range compareSet {
		if _, ok := baseSet[line]; !ok {
			added++
		}
	}
	for line := range baseSet {
		if _, ok := compareSet[line]; !ok {
			removed++
		}
	}
	result = "success"
	return nil, map[string]any{
		"docId": doc.DocID, "baseRevision": base.revision, "compareRevision": compare.revision,
		"titleChanged": base.title != compare.title, "themeChanged": base.theme != compare.theme,
		"contentChanged": base.content != compare.content, "baseCharacters": utf8.RuneCountInString(base.content),
		"compareCharacters": utf8.RuneCountInString(compare.content), "addedUniqueLines": added,
		"removedUniqueLines": removed,
	}, nil
}

type mcpFindTextInput struct {
	DocID string `json:"docId" jsonschema:"Koinote document ID."`
	Query string `json:"query" jsonschema:"Non-empty text to find, up to 200 characters."`
}

type mcpTextMatch struct {
	Offset      int    `json:"offset"`
	Length      int    `json:"length"`
	MatchedText string `json:"matchedText"`
	Context     string `json:"context"`
}

func (a *App) mcpFindTextInDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpFindTextInput) (*mcp.CallToolResult, map[string]any, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "find_text_in_document", input.DocID, result, started) }()
	query := strings.TrimSpace(input.Query)
	if query == "" || utf8.RuneCountInString(query) > 200 {
		return nil, nil, errors.New("query must contain 1 to 200 characters")
	}
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, nil, err
	}
	matches, truncated := findMCPTextMatches(doc.Content, query)
	result = "success"
	return nil, map[string]any{"docId": doc.DocID, "revision": doc.Revision, "matches": matches, "truncated": truncated}, nil
}

func findMCPTextMatches(content, query string) ([]mcpTextMatch, bool) {
	runes := []rune(content)
	normalizedRunes := make([]rune, len(runes))
	for index, value := range runes {
		normalizedRunes[index] = unicode.ToLower(value)
	}
	needleRunes := []rune(query)
	needle := make([]rune, len(needleRunes))
	for index, value := range needleRunes {
		needle[index] = unicode.ToLower(value)
	}
	matches := make([]mcpTextMatch, 0, 101)
	for offset := 0; offset+len(needle) <= len(runes) && len(matches) < 101; offset++ {
		matched := true
		for index, value := range needle {
			if normalizedRunes[offset+index] != value {
				matched = false
				break
			}
		}
		if !matched {
			continue
		}
		start := max(0, offset-80)
		end := min(len(runes), offset+len(needle)+80)
		matches = append(matches, mcpTextMatch{Offset: offset, Length: len(needle), MatchedText: string(runes[offset : offset+len(needle)]), Context: string(runes[start:end])})
		offset += len(needle) - 1
	}
	truncated := len(matches) > 100
	if truncated {
		matches = matches[:100]
	}
	return matches, truncated
}

func (a *App) mcpCreateFolder(ctx context.Context, _ *mcp.CallToolRequest, input mcpCreateFolderInput) (*mcp.CallToolResult, mcpFolderSummary, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "create_folder", "", result, started) }()
	name, err := validateFolderName(input.Name)
	if err != nil || name == "" {
		return nil, mcpFolderSummary{}, errors.New("folder name must contain 1 to 60 characters")
	}
	parent := derefOrEmpty(input.ParentFolderID)
	folderID, err := randomUUID()
	if err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("generate folder id", err)
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("create folder", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, principal.User.ID); err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("lock folders", err)
	}
	var parentID *int
	if parent != "" {
		var resolved int
		if err := tx.QueryRow(ctx, `SELECT id FROM folders WHERE folder_id = $1 AND user_id = $2`, parent, principal.User.ID).Scan(&resolved); errors.Is(err, pgx.ErrNoRows) {
			return nil, mcpFolderSummary{}, errors.New("parent folder not found")
		} else if err != nil {
			return nil, mcpFolderSummary{}, mcpInternalError("find parent folder", err)
		} else {
			parentID = &resolved
		}
		depth, err := a.folderDepthTx(ctx, tx, resolved)
		if err != nil {
			return nil, mcpFolderSummary{}, mcpInternalError("check folder depth", err)
		}
		if depth+1 > maxFolderDepth {
			return nil, mcpFolderSummary{}, errors.New("folder nesting is too deep")
		}
	}
	var created mcpFolderSummary
	var storedParent string
	if err := tx.QueryRow(ctx, `
		INSERT INTO folders (folder_id, user_id, parent_id, name)
		VALUES ($1, $2, $3, $4)
		RETURNING folder_id, name, COALESCE((SELECT folder_id FROM folders WHERE id = parent_id), ''), COALESCE(organizer_kind, '')
	`, folderID, principal.User.ID, parentID, name).Scan(&created.FolderID, &created.Name, &storedParent, &created.OrganizerKind); err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("insert folder", err)
	}
	created.ParentFolderID = storedParent
	if err := tx.Commit(ctx); err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("commit folder", err)
	}
	result = "success"
	return nil, created, nil
}

func (a *App) mcpRenameFolder(ctx context.Context, _ *mcp.CallToolRequest, input mcpRenameFolderInput) (*mcp.CallToolResult, mcpFolderSummary, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "rename_folder", input.FolderID, result, started) }()
	name, err := validateFolderName(input.Name)
	if err != nil || name == "" {
		return nil, mcpFolderSummary{}, errors.New("folder name must contain 1 to 60 characters")
	}
	var item mcpFolderSummary
	var parent string
	err = a.db.QueryRow(ctx, `
		UPDATE folders SET name = $3, updated_at = now()
		WHERE folder_id = $1 AND user_id = $2
		RETURNING folder_id, name, COALESCE((SELECT folder_id FROM folders WHERE id = parent_id), ''), COALESCE(organizer_kind, '')
	`, strings.TrimSpace(input.FolderID), principal.User.ID, name).Scan(&item.FolderID, &item.Name, &parent, &item.OrganizerKind)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, mcpFolderSummary{}, errors.New("folder not found")
	}
	if err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("rename folder", err)
	}
	item.ParentFolderID = parent
	result = "success"
	return nil, item, nil
}

func (a *App) mcpMoveFolder(ctx context.Context, _ *mcp.CallToolRequest, input mcpMoveFolderInput) (*mcp.CallToolResult, mcpFolderSummary, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "move_folder", input.FolderID, result, started) }()
	folderID := strings.TrimSpace(input.FolderID)
	parent := derefOrEmpty(input.ParentFolderID)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("move folder", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, principal.User.ID); err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("lock folders", err)
	}
	var selfID int
	if err := tx.QueryRow(ctx, `SELECT id FROM folders WHERE folder_id = $1 AND user_id = $2`, folderID, principal.User.ID).Scan(&selfID); errors.Is(err, pgx.ErrNoRows) {
		return nil, mcpFolderSummary{}, errors.New("folder not found")
	} else if err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("find folder", err)
	}
	if parent == folderID {
		return nil, mcpFolderSummary{}, errors.New("cannot move a folder into itself")
	}
	var parentID *int
	if parent != "" {
		var resolved int
		if err := tx.QueryRow(ctx, `SELECT id FROM folders WHERE folder_id = $1 AND user_id = $2`, parent, principal.User.ID).Scan(&resolved); errors.Is(err, pgx.ErrNoRows) {
			return nil, mcpFolderSummary{}, errors.New("parent folder not found")
		} else if err != nil {
			return nil, mcpFolderSummary{}, mcpInternalError("find parent folder", err)
		} else {
			parentID = &resolved
		}
		var cyclic bool
		if err := tx.QueryRow(ctx, `
			WITH RECURSIVE sub AS (
				SELECT id FROM folders WHERE id = $1
				UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
			)
			SELECT EXISTS (SELECT 1 FROM sub WHERE id = $2)
		`, selfID, resolved).Scan(&cyclic); err != nil {
			return nil, mcpFolderSummary{}, mcpInternalError("check folder cycle", err)
		}
		if cyclic {
			return nil, mcpFolderSummary{}, errors.New("cannot move a folder into its own subtree")
		}
		depth, err := a.folderDepthTx(ctx, tx, resolved)
		if err != nil {
			return nil, mcpFolderSummary{}, mcpInternalError("check folder depth", err)
		}
		var subtreeHeight int
		if err := tx.QueryRow(ctx, `
			WITH RECURSIVE sub AS (
				SELECT id, 0 AS depth FROM folders WHERE id = $1
				UNION ALL SELECT f.id, sub.depth + 1 FROM folders f JOIN sub ON f.parent_id = sub.id
			)
			SELECT COALESCE(MAX(depth), 0) FROM sub
		`, selfID).Scan(&subtreeHeight); err != nil {
			return nil, mcpFolderSummary{}, mcpInternalError("check folder subtree depth", err)
		}
		if depth+1+subtreeHeight > maxFolderDepth {
			return nil, mcpFolderSummary{}, errors.New("folder nesting is too deep")
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE folders SET parent_id = $2, updated_at = now() WHERE id = $1 AND user_id = $3`, selfID, parentID, principal.User.ID); err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("move folder", err)
	}
	var item mcpFolderSummary
	var storedParent string
	if err := tx.QueryRow(ctx, `
		SELECT f.folder_id, f.name, COALESCE(p.folder_id, ''), COALESCE(f.organizer_kind, '')
		FROM folders f LEFT JOIN folders p ON p.id = f.parent_id
		WHERE f.id = $1
	`, selfID).Scan(&item.FolderID, &item.Name, &storedParent, &item.OrganizerKind); err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("read moved folder", err)
	}
	item.ParentFolderID = storedParent
	if err := tx.Commit(ctx); err != nil {
		return nil, mcpFolderSummary{}, mcpInternalError("commit folder move", err)
	}
	result = "success"
	return nil, item, nil
}

func (a *App) mcpMoveDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpMoveDocumentInput) (*mcp.CallToolResult, mcpMoveDocumentsOutput, error) {
	return a.mcpMoveDocuments(ctx, "move_document", []string{input.DocID}, input.FolderID, input.ExpectedRevision)
}

func (a *App) mcpBatchMoveDocuments(ctx context.Context, _ *mcp.CallToolRequest, input mcpBatchMoveDocumentsInput) (*mcp.CallToolResult, mcpMoveDocumentsOutput, error) {
	return a.mcpMoveDocuments(ctx, "batch_move_documents", input.DocIDs, input.FolderID, 0)
}

func (a *App) mcpMoveDocuments(ctx context.Context, toolName string, rawDocIDs []string, folderID *string, expectedRevision int64) (*mcp.CallToolResult, mcpMoveDocumentsOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	docID := ""
	if len(rawDocIDs) == 1 {
		docID = rawDocIDs[0]
	}
	defer func() { a.auditMCPCall(principal, toolName, docID, result, started) }()
	if len(rawDocIDs) < 1 || len(rawDocIDs) > mcpBatchMoveMaxDocuments {
		return nil, mcpMoveDocumentsOutput{}, fmt.Errorf("docIds must contain 1 to %d items", mcpBatchMoveMaxDocuments)
	}
	docIDs := make([]string, 0, len(rawDocIDs))
	seen := make(map[string]struct{}, len(rawDocIDs))
	for _, raw := range rawDocIDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			return nil, mcpMoveDocumentsOutput{}, errors.New("document IDs must not be empty")
		}
		if _, ok := seen[id]; ok {
			return nil, mcpMoveDocumentsOutput{}, errors.New("docIds must be unique")
		}
		seen[id] = struct{}{}
		docIDs = append(docIDs, id)
	}
	target := derefOrEmpty(folderID)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, mcpMoveDocumentsOutput{}, mcpInternalError("move documents", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, principal.User.ID); err != nil {
		return nil, mcpMoveDocumentsOutput{}, mcpInternalError("lock documents", err)
	}
	var targetID *int
	if target != "" {
		var id int
		if err := tx.QueryRow(ctx, `SELECT id FROM folders WHERE folder_id = $1 AND user_id = $2`, target, principal.User.ID).Scan(&id); errors.Is(err, pgx.ErrNoRows) {
			return nil, mcpMoveDocumentsOutput{}, errors.New("target folder not found")
		} else if err != nil {
			return nil, mcpMoveDocumentsOutput{}, mcpInternalError("find target folder", err)
		} else {
			targetID = &id
		}
	}
	for _, id := range docIDs {
		var revision int64
		if err := tx.QueryRow(ctx, `SELECT revision FROM documents WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL`, id, principal.User.ID).Scan(&revision); errors.Is(err, pgx.ErrNoRows) {
			return nil, mcpMoveDocumentsOutput{}, errors.New("document not found")
		} else if err != nil {
			return nil, mcpMoveDocumentsOutput{}, mcpInternalError("find document", err)
		}
		if expectedRevision > 0 && revision != expectedRevision {
			return nil, mcpMoveDocumentsOutput{}, errors.New("document revision conflict; read the latest document and retry")
		}
	}
	for _, id := range docIDs {
		if _, err := tx.Exec(ctx, `UPDATE documents SET folder_id = $3 WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL`, id, principal.User.ID, targetID); err != nil {
			return nil, mcpMoveDocumentsOutput{}, mcpInternalError("move document", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mcpMoveDocumentsOutput{}, mcpInternalError("commit document move", err)
	}
	result = "success"
	return nil, mcpMoveDocumentsOutput{Moved: len(docIDs), FolderID: target}, nil
}

func (a *App) mcpDeleteFolder(ctx context.Context, _ *mcp.CallToolRequest, input mcpFolderInput) (*mcp.CallToolResult, map[string]any, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "delete_folder", input.FolderID, result, started) }()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, nil, mcpInternalError("delete folder", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, principal.User.ID); err != nil {
		return nil, nil, mcpInternalError("lock folders", err)
	}
	var internalID int
	var parentID *int
	if err := tx.QueryRow(ctx, `SELECT id, parent_id FROM folders WHERE folder_id = $1 AND user_id = $2`, strings.TrimSpace(input.FolderID), principal.User.ID).Scan(&internalID, &parentID); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, errors.New("folder not found")
	} else if err != nil {
		return nil, nil, mcpInternalError("find folder", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE folders SET parent_id = $2, updated_at = now() WHERE parent_id = $1 AND user_id = $3`, internalID, parentID, principal.User.ID); err != nil {
		return nil, nil, mcpInternalError("lift child folders", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE documents SET folder_id = $2 WHERE folder_id = $1 AND user_id = $3`, internalID, parentID, principal.User.ID); err != nil {
		return nil, nil, mcpInternalError("lift folder documents", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM folders WHERE id = $1 AND user_id = $2`, internalID, principal.User.ID); err != nil {
		return nil, nil, mcpInternalError("delete folder", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, mcpInternalError("commit folder deletion", err)
	}
	result = "success"
	return nil, map[string]any{"deleted": true, "folderId": strings.TrimSpace(input.FolderID)}, nil
}

func (a *App) mcpUpdateDocumentMetadata(ctx context.Context, _ *mcp.CallToolRequest, input mcpUpdateDocumentMetadataInput) (*mcp.CallToolResult, mcpDocumentMutationOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "update_document_metadata", input.DocID, result, started) }()
	if input.ExpectedRevision <= 0 {
		return nil, mcpDocumentMutationOutput{}, errors.New("expectedRevision must be positive")
	}
	if input.Title == nil && input.Theme == nil {
		return nil, mcpDocumentMutationOutput{}, errors.New("title or theme must be provided")
	}
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, err
	}
	if doc.Revision != input.ExpectedRevision {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(errDocumentRevisionConflict)
	}
	title := doc.Title
	if input.Title != nil {
		title = strings.TrimSpace(*input.Title)
	}
	_, content, err := validateMCPDocumentInput(title, doc.Content)
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, err
	}
	theme := doc.Theme
	if input.Theme != nil {
		theme, err = validateMCPDocumentTheme(*input.Theme)
		if err != nil {
			return nil, mcpDocumentMutationOutput{}, err
		}
	}
	updated, err := a.updateDocument(ctx, updateDocumentParams{User: principal.User, DocID: doc.DocID, Title: title, Theme: theme, Content: content, ExpectedRevision: input.ExpectedRevision, Source: documentSourceMCP, SourceTokenID: &principal.TokenID})
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(err)
	}
	result = "success"
	return nil, mutationOutput(updated), nil
}

func (a *App) mcpApplyTextPatch(ctx context.Context, _ *mcp.CallToolRequest, input mcpApplyTextPatchInput) (*mcp.CallToolResult, mcpDocumentMutationOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "apply_text_patch", input.DocID, result, started) }()
	if input.ExpectedRevision <= 0 {
		return nil, mcpDocumentMutationOutput{}, errors.New("expectedRevision must be positive")
	}
	if len(input.Patches) < 1 || len(input.Patches) > 20 {
		return nil, mcpDocumentMutationOutput{}, errors.New("patches must contain 1 to 20 items")
	}
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, err
	}
	if doc.Revision != input.ExpectedRevision {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(errDocumentRevisionConflict)
	}
	content := []rune(doc.Content)
	type located struct {
		start, end  int
		replacement []rune
	}
	locations := make([]located, 0, len(input.Patches))
	for _, patch := range input.Patches {
		find := []rune(patch.Find)
		if len(find) == 0 || len(find) > 20_000 {
			return nil, mcpDocumentMutationOutput{}, errors.New("each patch find must contain 1 to 20000 characters")
		}
		if len([]byte(patch.Replace)) > maxContentBytes {
			return nil, mcpDocumentMutationOutput{}, errors.New("replacement content is too large")
		}
		start, count := locateUniqueRuneMatch(content, find)
		if count != 1 {
			return nil, mcpDocumentMutationOutput{}, fmt.Errorf("patch anchor must match exactly once, found %d matches", count)
		}
		locations = append(locations, located{start: start, end: start + len(find), replacement: []rune(patch.Replace)})
	}
	for left := 0; left < len(locations); left++ {
		for right := left + 1; right < len(locations); right++ {
			if locations[left].start == locations[right].start || locations[left].start < locations[right].end && locations[right].start < locations[left].end {
				return nil, mcpDocumentMutationOutput{}, errors.New("patch anchors overlap")
			}
		}
	}
	for index := 0; index < len(locations); index++ {
		for next := index + 1; next < len(locations); next++ {
			if locations[index].start < locations[next].start {
				locations[index], locations[next] = locations[next], locations[index]
			}
		}
	}
	for _, location := range locations {
		content = append(append(append([]rune{}, content[:location.start]...), location.replacement...), content[location.end:]...)
	}
	newContent := string(content)
	if len([]byte(newContent)) > maxContentBytes {
		return nil, mcpDocumentMutationOutput{}, fmt.Errorf("content exceeds %d bytes", maxContentBytes)
	}
	updated, err := a.updateDocument(ctx, updateDocumentParams{User: principal.User, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme, Content: newContent, ExpectedRevision: input.ExpectedRevision, Source: documentSourceMCP, SourceTokenID: &principal.TokenID})
	if err != nil {
		return nil, mcpDocumentMutationOutput{}, mapMCPDocumentError(err)
	}
	result = "success"
	return nil, mutationOutput(updated), nil
}

func equalRunes(left, right []rune) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func locateUniqueRuneMatch(content, find []rune) (int, int) {
	start := -1
	count := 0
	for index := 0; index+len(find) <= len(content); index++ {
		if !equalRunes(content[index:index+len(find)], find) {
			continue
		}
		start = index
		count++
		if count > 1 {
			break
		}
	}
	return start, count
}

func (a *App) folderDepthTx(ctx context.Context, tx pgx.Tx, id int) (int, error) {
	var depth int
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE up AS (
			SELECT id, parent_id, 1 AS d FROM folders WHERE id = $1
			UNION ALL SELECT f.id, f.parent_id, up.d + 1 FROM folders f JOIN up ON f.id = up.parent_id
		)
		SELECT COALESCE(MAX(d), 0) FROM up
	`, id).Scan(&depth)
	return depth, err
}
