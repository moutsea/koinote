package server

import (
	"context"
	"sort"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpDocumentTheme struct {
	ID      string `json:"id"`
	Default bool   `json:"default"`
}

type mcpDocumentThemesOutput struct {
	Themes []mcpDocumentTheme `json:"themes"`
}

func (a *App) mcpListDocumentThemes(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, mcpDocumentThemesOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "list_document_themes", "", result, started) }()

	ids := make([]string, 0, len(documentThemes))
	for id := range documentThemes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	themes := make([]mcpDocumentTheme, 0, len(ids))
	for _, id := range ids {
		themes = append(themes, mcpDocumentTheme{ID: id, Default: id == defaultDocumentTheme})
	}
	result = "success"
	return nil, mcpDocumentThemesOutput{Themes: themes}, nil
}

type mcpAgentCreditsOutput struct {
	Balance         int64 `json:"balance"`
	Reserved        int64 `json:"reserved"`
	Available       int64 `json:"available"`
	TokensPerCredit int64 `json:"tokensPerCredit"`
}

func (a *App) mcpGetAgentCredits(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, mcpAgentCreditsOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_agent_credits", "", result, started) }()

	balance, err := a.loadCreditBalance(ctx, principal.User.ID)
	if err != nil {
		return nil, mcpAgentCreditsOutput{}, mcpInternalError("get agent credits", err)
	}
	result = "success"
	return nil, mcpAgentCreditsOutput{
		Balance: balance.Balance, Reserved: balance.Reserved, Available: balance.Available,
		TokensPerCredit: creditTokensPerCredit,
	}, nil
}
