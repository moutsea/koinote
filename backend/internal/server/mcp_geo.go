package server

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"koinote/backend/internal/model"
)

type mcpWechatGeoSummaryInput struct {
	DocID string `json:"docId" jsonschema:"Koinote document ID."`
}

type mcpWechatGeoSummaryUpdateInput struct {
	DocID   string  `json:"docId" jsonschema:"Koinote document ID."`
	Text    *string `json:"text,omitempty" jsonschema:"Optional replacement GEO summary text, up to 2400 characters."`
	Enabled *bool   `json:"enabled,omitempty" jsonschema:"Optional whether the saved GEO summary should be included in exports."`
}

type mcpWechatGeoSummaryOutput struct {
	DocID    string                `json:"docId"`
	Revision int64                 `json:"revision"`
	Geo      *wechatGeoSummaryView `json:"geo"`
	Stale    bool                  `json:"stale"`
}

func (a *App) mcpGetWechatGeoSummary(
	ctx context.Context,
	_ *mcp.CallToolRequest,
	input mcpWechatGeoSummaryInput,
) (*mcp.CallToolResult, mcpWechatGeoSummaryOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "get_wechat_geo_summary", input.DocID, result, started) }()

	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, mcpWechatGeoSummaryOutput{}, err
	}
	documentID, err := a.loadWechatGeoDocumentID(ctx, principal.User.ID, doc.DocID)
	if err != nil {
		return nil, mcpWechatGeoSummaryOutput{}, mapMCPWechatGeoError(err)
	}
	view, err := a.loadWechatGeoSummary(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		result = "success"
		return nil, mcpWechatGeoSummaryOutput{DocID: doc.DocID, Revision: doc.Revision}, nil
	}
	if err != nil {
		return nil, mcpWechatGeoSummaryOutput{}, mcpInternalError("get WeChat GEO summary", err)
	}
	result = "success"
	return nil, mcpWechatGeoSummaryOutput{
		DocID: doc.DocID, Revision: doc.Revision, Geo: &view,
		Stale: view.SourceHash != wechatGeoSummaryFingerprint(doc.Title, doc.Content),
	}, nil
}

func (a *App) mcpGenerateWechatGeoSummary(
	ctx context.Context,
	_ *mcp.CallToolRequest,
	input mcpWechatGeoSummaryInput,
) (*mcp.CallToolResult, mcpWechatGeoSummaryOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "generate_wechat_geo_summary", input.DocID, result, started) }()

	if principal.User.MembershipTier != membershipTierLifetime {
		return nil, mcpWechatGeoSummaryOutput{}, errors.New("AI GEO summary requires lifetime membership")
	}
	if !a.rateLimit().allow(
		fmt.Sprintf("wechat-geo-summary:user:%d", principal.User.ID),
		wechatGeoSummaryRateLimit,
		wechatGeoSummaryRateWindow,
	) {
		return nil, mcpWechatGeoSummaryOutput{}, errors.New("too many GEO summary requests; try again later")
	}
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, mcpWechatGeoSummaryOutput{}, err
	}
	view, err := a.generateMCPWechatGeoSummary(ctx, principal.User, doc)
	if err != nil {
		return nil, mcpWechatGeoSummaryOutput{}, mapMCPWechatGeoError(err)
	}
	currentDoc, err := a.loadMCPDocument(ctx, principal.User.ID, doc.DocID)
	if err != nil {
		return nil, mcpWechatGeoSummaryOutput{}, mcpInternalError("reload document after GEO summary generation", err)
	}
	result = "success"
	return nil, mcpWechatGeoSummaryOutput{
		DocID: currentDoc.DocID, Revision: currentDoc.Revision, Geo: &view,
		Stale: view.SourceHash != wechatGeoSummaryFingerprint(currentDoc.Title, currentDoc.Content),
	}, nil
}

func (a *App) mcpUpdateWechatGeoSummary(
	ctx context.Context,
	_ *mcp.CallToolRequest,
	input mcpWechatGeoSummaryUpdateInput,
) (*mcp.CallToolResult, mcpWechatGeoSummaryOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "update_wechat_geo_summary", input.DocID, result, started) }()

	if principal.User.MembershipTier != membershipTierLifetime {
		return nil, mcpWechatGeoSummaryOutput{}, errors.New("AI GEO summary requires lifetime membership")
	}
	if input.Text == nil && input.Enabled == nil {
		return nil, mcpWechatGeoSummaryOutput{}, errors.New("text or enabled must be provided")
	}
	if input.Text != nil {
		normalized := strings.TrimSpace(*input.Text)
		if normalized == "" || utf8.RuneCountInString(normalized) > 2400 {
			return nil, mcpWechatGeoSummaryOutput{}, errors.New("text must contain 1 to 2400 characters")
		}
		input.Text = &normalized
	}
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, mcpWechatGeoSummaryOutput{}, err
	}
	view, err := a.updateWechatGeoSummaryText(ctx, principal.User.ID, doc.DocID, input.Text, input.Enabled)
	if errors.Is(err, errDocumentNotFound) {
		return nil, mcpWechatGeoSummaryOutput{}, errors.New("document or GEO summary not found")
	}
	if err != nil {
		return nil, mcpWechatGeoSummaryOutput{}, mcpInternalError("update WeChat GEO summary", err)
	}
	result = "success"
	return nil, mcpWechatGeoSummaryOutput{
		DocID: doc.DocID, Revision: doc.Revision, Geo: &view,
		Stale: view.SourceHash != wechatGeoSummaryFingerprint(doc.Title, doc.Content),
	}, nil
}

func (a *App) generateMCPWechatGeoSummary(
	ctx context.Context,
	user model.User,
	doc model.Document,
) (wechatGeoSummaryView, error) {
	mode, err := a.loadAgentProviderMode(ctx, user.ID)
	if err != nil {
		return wechatGeoSummaryView{}, err
	}
	provider, _, err := a.resolveAgentLLMProvider(ctx, user, mode, "")
	if err != nil {
		return wechatGeoSummaryView{}, err
	}
	prompt, err := buildWechatGeoSummaryPrompt(doc.Title, doc.Content)
	if err != nil {
		return wechatGeoSummaryView{}, err
	}

	reservationID := ""
	committed := false
	if provider.Mode == "builtin" {
		reservation, err := a.reserveStandaloneCredits(
			ctx, user.ID, estimateAgentReviewReservation(prompt), wechatGeoSummaryReservation,
		)
		if err != nil {
			return wechatGeoSummaryView{}, err
		}
		reservationID = reservation.ReservationID
		defer func() {
			if committed {
				return
			}
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if _, releaseErr := a.releaseCreditReservation(cleanupCtx, user.ID, reservationID); releaseErr != nil {
				log.Printf("mcp GEO release credits: %v", releaseErr)
			}
		}()
	}

	callContext, cancel := context.WithTimeout(ctx, wechatGeoSummaryRunLimit)
	defer cancel()
	llmResult, err := callAgentLLM(callContext, a.agentLLMHTTPClient, provider, prompt)
	if err == nil {
		err = requireAgentLLMUsage(provider, llmResult)
	}
	if err != nil {
		return wechatGeoSummaryView{}, err
	}
	generation, err := parseWechatGeoSummary(llmResult.JSON)
	if err != nil {
		return wechatGeoSummaryView{}, err
	}
	documentID, err := a.loadWechatGeoDocumentID(ctx, user.ID, doc.DocID)
	if err != nil {
		return wechatGeoSummaryView{}, err
	}
	view, err := a.storeWechatGeoSummary(
		ctx, user.ID, documentID, doc.DocID,
		wechatGeoSummaryFingerprint(doc.Title, doc.Content), generation, provider,
		reservationID, llmResult.TotalTokens,
	)
	if err != nil {
		return wechatGeoSummaryView{}, err
	}
	if provider.Mode == "builtin" {
		committed = true
	}
	return view, nil
}

func mapMCPWechatGeoError(err error) error {
	switch {
	case errors.Is(err, errDocumentNotFound):
		return errors.New("document not found")
	case errors.Is(err, errInsufficientCredits):
		return errors.New("not enough credits for an AI GEO summary")
	case errors.Is(err, context.DeadlineExceeded):
		return errors.New("AI GEO summary provider timed out")
	case errors.Is(err, pgx.ErrNoRows):
		return errors.New("configured LLM channel was not found")
	case errors.Is(err, errAgentLLMInvalidResponse), errors.Is(err, errAgentLLMUsageMissing), errors.Is(err, errAgentLLMUsageInvalid):
		return errors.New("AI GEO summary provider returned an invalid response")
	default:
		var providerError *agentLLMHTTPError
		if errors.As(err, &providerError) {
			return errors.New("AI GEO summary provider is temporarily unavailable")
		}
		if strings.Contains(err.Error(), "not configured") {
			return errors.New("AI GEO summary provider is not configured")
		}
		return mcpInternalError("generate WeChat GEO summary", err)
	}
}

func applyMCPWechatGeoSummary(htmlContent string, view wechatGeoSummaryView) (string, error) {
	if !view.Enabled {
		return "", errors.New("WeChat GEO summary is disabled")
	}
	corpus := normalizeMCPWechatGeoCorpus(view.Text)
	if corpus == "" {
		return "", errors.New("WeChat GEO summary is empty")
	}
	section := `<section style="height:0!important;margin:0!important;padding:0!important;overflow:hidden!important;width:100%;position:absolute!important;visibility:hidden!important;"><p style="margin:0!important;padding:0!important;">` + html.EscapeString(corpus) + `</p></section>`
	divider := `<hr style="border:none;border-top:1px solid #e0e0e0;margin:32px 0;">`
	if index := strings.Index(htmlContent, "</h1>"); index >= 0 {
		index += len("</h1>")
		return htmlContent[:index] + divider + section + htmlContent[index:], nil
	}
	return divider + section + htmlContent, nil
}

func normalizeMCPWechatGeoCorpus(value string) string {
	lines := strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
	parts := make([]string, 0, len(lines))
	for _, line := range lines {
		if normalized := strings.Join(strings.Fields(line), " "); normalized != "" {
			parts = append(parts, normalized)
		}
	}
	result := strings.Join(parts, "\n")
	runes := []rune(result)
	if len(runes) > 2400 {
		return string(runes[:2400])
	}
	return result
}
