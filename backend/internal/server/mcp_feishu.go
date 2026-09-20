package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpSyncDocumentToFeishuInput struct {
	DocID string `json:"docId" jsonschema:"Koinote document ID to create or update in Feishu."`
}

func (a *App) mcpSyncDocumentToFeishu(ctx context.Context, _ *mcp.CallToolRequest, input mcpSyncDocumentToFeishuInput) (*mcp.CallToolResult, feishuSyncResult, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "sync_document_to_feishu", input.DocID, result, started) }()

	documentID := strings.TrimSpace(input.DocID)
	if documentID == "" {
		return nil, feishuSyncResult{}, errors.New("docId must not be empty")
	}
	if !a.rateLimit().allow("feishu-sync:"+strconv.Itoa(principal.User.ID), 30, time.Hour) {
		return nil, feishuSyncResult{}, errors.New("too many Feishu sync requests; try again later")
	}
	syncContext, cancel := context.WithTimeout(ctx, feishuSyncTimeout)
	defer cancel()
	synced, err := a.syncFeishuDocument(syncContext, principal.User, documentID)
	if err != nil {
		if syncContext.Err() != nil {
			return nil, feishuSyncResult{}, errors.New("Feishu sync timed out; try again later")
		}
		return nil, feishuSyncResult{}, mapMCPFeishuError(err)
	}
	result = "success"
	return nil, synced, nil
}

func mapMCPFeishuError(err error) error {
	switch {
	case errors.Is(err, errFeishuNotConfigured):
		return errors.New("Feishu document sync is not configured on the server")
	case errors.Is(err, errFeishuNotBound):
		return errors.New("bind a Feishu account in Settings → Feishu before syncing")
	case errors.Is(err, errFeishuTokenInvalid):
		return errors.New("Feishu authorization expired; reconnect the Feishu account in Settings → Feishu")
	case errors.Is(err, errFeishuBusy):
		return errors.New("this Feishu account is busy; try again later")
	case errors.Is(err, errFeishuServerBusy):
		return errors.New("Feishu sync capacity is busy; try again later")
	case errors.Is(err, errFeishuContentLimit):
		return errors.New("the document exceeds Feishu sync limits")
	case errors.Is(err, errFeishuImage):
		return errors.New("one or more document images could not be uploaded to Feishu")
	case errors.Is(err, errFeishuDocumentMissing):
		return errors.New("the linked Feishu document is unavailable; try syncing again")
	case errors.Is(err, errDocumentNotFound):
		return errors.New("document not found")
	}
	var provider *feishuAPIError
	if errors.As(err, &provider) && (provider.Status == http.StatusForbidden || provider.Code == 1770032) {
		return errors.New("Feishu denied document access; check the app permissions")
	}
	return mcpInternalError("sync document to Feishu", err)
}
