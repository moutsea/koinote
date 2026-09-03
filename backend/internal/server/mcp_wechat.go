package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/yuin/goldmark"
	goldmarkHTML "github.com/yuin/goldmark/renderer/html"
)

type mcpPushWechatDraftInput struct {
	DocID            string `json:"docId" jsonschema:"Koinote document ID."`
	AccountID        string `json:"accountId,omitempty" jsonschema:"Optional bound Official Account ID. Omit to use the default account."`
	Author           string `json:"author,omitempty" jsonschema:"Optional WeChat draft author, up to 16 characters."`
	Digest           string `json:"digest,omitempty" jsonschema:"Optional WeChat draft digest, up to 128 characters."`
	CoverMode        string `json:"coverMode,omitempty" jsonschema:"Cover source: default, article, or ai. Defaults to default."`
	CoverRatio       string `json:"coverRatio,omitempty" jsonschema:"Cover ratio: 2.35:1 or 1:1. Defaults to 2.35:1."`
	CoverImageSource string `json:"coverImageSource,omitempty" jsonschema:"Existing article image URL to use when coverMode is article."`
	CoverPrompt      string `json:"coverPrompt,omitempty" jsonschema:"Prompt used when coverMode is ai. AI generation consumes 20 credits."`
	IncludeGeo       bool   `json:"includeGeo,omitempty" jsonschema:"Whether to include the current non-stale, enabled WeChat GEO summary in the draft. Defaults to false."`
}

var errMCPWechatDraftInsufficientCredits = errors.New("not enough credits for a WeChat draft")

type mcpWechatAccountSummary struct {
	AccountID  string `json:"accountId"`
	Label      string `json:"label"`
	AppID      string `json:"appId"`
	IsDefault  bool   `json:"isDefault"`
	VerifiedAt string `json:"verifiedAt"`
	UpdatedAt  string `json:"updatedAt"`
}

type mcpWechatAccountsOutput struct {
	Accounts []mcpWechatAccountSummary `json:"accounts"`
	MaxCount int                       `json:"maxCount"`
}

func (a *App) mcpListWechatAccounts(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, mcpWechatAccountsOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "list_wechat_accounts", "", result, started) }()
	accounts, err := a.listWechatOfficialAccounts(ctx, principal.User.ID)
	if err != nil {
		return nil, mcpWechatAccountsOutput{}, mcpInternalError("list WeChat accounts", err)
	}
	output := mcpWechatAccountsOutput{
		Accounts: make([]mcpWechatAccountSummary, 0, len(accounts)),
		MaxCount: wechatOfficialAccountMaxCount,
	}
	for _, account := range accounts {
		output.Accounts = append(output.Accounts, mcpWechatAccountSummary{
			AccountID: account.AccountID, Label: account.Label, AppID: account.AppID,
			IsDefault:  account.IsDefault,
			VerifiedAt: account.VerifiedAt.UTC().Format(time.RFC3339),
			UpdatedAt:  account.UpdatedAt.UTC().Format(time.RFC3339),
		})
	}
	result = "success"
	return nil, output, nil
}

type mcpWechatDraftOutput struct {
	MediaID     string `json:"mediaId"`
	AccountID   string `json:"accountId"`
	DocID       string `json:"docId"`
	Title       string `json:"title"`
	CoverMode   string `json:"coverMode"`
	CoverRatio  string `json:"coverRatio"`
	GeoIncluded bool   `json:"geoIncluded"`
}

func (a *App) mcpPushWechatDraft(ctx context.Context, _ *mcp.CallToolRequest, input mcpPushWechatDraftInput) (*mcp.CallToolResult, mcpWechatDraftOutput, error) {
	principal := mcpPrincipalFromContext(ctx)
	started := time.Now()
	result := "error"
	defer func() { a.auditMCPCall(principal, "push_wechat_draft", input.DocID, result, started) }()
	doc, err := a.loadMCPDocument(ctx, principal.User.ID, input.DocID)
	if err != nil {
		return nil, mcpWechatDraftOutput{}, err
	}
	if utf8.RuneCountInString(doc.Title) == 0 || utf8.RuneCountInString(doc.Title) > 64 {
		return nil, mcpWechatDraftOutput{}, errors.New("document title must contain 1 to 64 characters for a WeChat draft")
	}
	if utf8.RuneCountInString(strings.TrimSpace(input.Author)) > 16 || utf8.RuneCountInString(strings.TrimSpace(input.Digest)) > 128 {
		return nil, mcpWechatDraftOutput{}, errors.New("author or digest is too long")
	}
	ratio := strings.TrimSpace(input.CoverRatio)
	if ratio == "" {
		ratio = wechatCoverRatioWide
	}
	if !validWechatCoverRatio(ratio) {
		return nil, mcpWechatDraftOutput{}, errors.New("coverRatio must be 2.35:1 or 1:1")
	}
	coverMode := strings.TrimSpace(input.CoverMode)
	if coverMode == "" {
		coverMode = wechatCoverModeDefault
	}
	if !validWechatCoverMode(coverMode) {
		return nil, mcpWechatDraftOutput{}, errors.New("coverMode must be default, article, or ai")
	}
	if coverMode == wechatCoverModeAI {
		if strings.TrimSpace(input.CoverPrompt) == "" || utf8.RuneCountInString(input.CoverPrompt) > wechatCoverPromptMaxRunes {
			return nil, mcpWechatDraftOutput{}, errors.New("coverPrompt must contain 1 to 1200 characters")
		}
	} else if strings.TrimSpace(input.CoverPrompt) != "" {
		return nil, mcpWechatDraftOutput{}, errors.New("coverPrompt is only valid with coverMode ai")
	}
	if coverMode != wechatCoverModeArticle && strings.TrimSpace(input.CoverImageSource) != "" {
		return nil, mcpWechatDraftOutput{}, errors.New("coverImageSource is only valid with coverMode article")
	}
	account, err := a.resolveWechatOfficialAccountRef(ctx, principal.User.ID, strings.TrimSpace(input.AccountID))
	if err != nil {
		return nil, mcpWechatDraftOutput{}, mapMCPWechatPublishError(err)
	}
	htmlContent, err := renderMCPWechatHTML(doc.Content)
	if err != nil {
		return nil, mcpWechatDraftOutput{}, err
	}
	htmlContent, err = a.normalizeMCPWechatImageSources(htmlContent)
	if err != nil {
		return nil, mcpWechatDraftOutput{}, err
	}
	if input.IncludeGeo {
		documentID, geoErr := a.loadWechatGeoDocumentID(ctx, principal.User.ID, doc.DocID)
		if geoErr != nil {
			return nil, mcpWechatDraftOutput{}, mapMCPWechatGeoError(geoErr)
		}
		geo, geoErr := a.loadWechatGeoSummary(ctx, documentID)
		if errors.Is(geoErr, pgx.ErrNoRows) {
			return nil, mcpWechatDraftOutput{}, errors.New("no saved WeChat GEO summary; generate one first")
		}
		if geoErr != nil {
			return nil, mcpWechatDraftOutput{}, mcpInternalError("load WeChat GEO summary", geoErr)
		}
		if geo.SourceHash != wechatGeoSummaryFingerprint(doc.Title, doc.Content) {
			return nil, mcpWechatDraftOutput{}, errors.New("WeChat GEO summary is stale; generate a new one first")
		}
		htmlContent, geoErr = applyMCPWechatGeoSummary(htmlContent, geo)
		if geoErr != nil {
			return nil, mcpWechatDraftOutput{}, geoErr
		}
	}
	if len(htmlContent) > wechatDraftHTMLMaxBytes {
		return nil, mcpWechatDraftOutput{}, errors.New("rendered WeChat draft content is too large")
	}
	coverSource := normalizeMCPWechatImageSource(strings.TrimSpace(input.CoverImageSource), a.cfg.WorkerURL, a.cfg.AppURL)
	if coverMode == wechatCoverModeArticle && !wechatHTMLHasImageSource(htmlContent, coverSource) {
		return nil, mcpWechatDraftOutput{}, errors.New("coverImageSource is not present in the document")
	}
	if !a.rateLimit().allow("wechat-draft:"+fmt.Sprint(principal.User.ID), wechatDraftCreateLimit, wechatDraftCreateWindow) {
		return nil, mcpWechatDraftOutput{}, errors.New("too many WeChat draft requests; try again later")
	}
	draftReservation, err := a.reserveStandaloneCredits(
		ctx,
		principal.User.ID,
		wechatDraftSyncCredits,
		wechatDraftReservationTTL,
	)
	if errors.Is(err, errInsufficientCredits) {
		return nil, mcpWechatDraftOutput{}, errMCPWechatDraftInsufficientCredits
	}
	if err != nil {
		return nil, mcpWechatDraftOutput{}, mapMCPWechatPublishError(err)
	}
	draftCreditsCommitted := false
	defer func() {
		if draftCreditsCommitted {
			return
		}
		cleanupContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, releaseErr := a.releaseCreditReservation(cleanupContext, principal.User.ID, draftReservation.ReservationID); releaseErr != nil &&
			!errors.Is(releaseErr, errCreditReservationNotFound) {
			log.Printf("mcp wechat draft release credits: %v", releaseErr)
		}
	}()
	var cover []byte
	if coverMode == wechatCoverModeAI {
		cover, err = a.generateWechatCoverForMCP(ctx, principal.User.ID, input.CoverPrompt, ratio)
		if err != nil {
			return nil, mcpWechatDraftOutput{}, mapMCPWechatPublishError(err)
		}
	}
	content, selectedImage, err := a.transferWechatDraftImagesWithCoverImage(ctx, account, htmlContent, coverMode == wechatCoverModeArticle, coverSource)
	if err != nil {
		return nil, mcpWechatDraftOutput{}, mapMCPWechatPublishError(err)
	}
	if len(cover) == 0 && coverMode == wechatCoverModeArticle {
		if len(selectedImage) == 0 {
			return nil, mcpWechatDraftOutput{}, errors.New("article cover image could not be loaded")
		}
		cover, _, _, err = prepareWechatThumb(selectedImage, ratio)
	} else if len(cover) == 0 {
		cover, err = defaultWechatCover(doc.Title, ratio)
	}
	if err != nil {
		return nil, mcpWechatDraftOutput{}, mapMCPWechatPublishError(err)
	}
	thumbMediaID, err := a.uploadWechatThumb(ctx, account, cover)
	if err != nil {
		return nil, mcpWechatDraftOutput{}, mapMCPWechatPublishError(errors.Join(errWechatCoverUploadFailed, err))
	}
	mediaID, err := a.createWechatDraft(ctx, account, doc.Title, strings.TrimSpace(input.Author), strings.TrimSpace(input.Digest), content, thumbMediaID)
	if err != nil {
		a.deleteWechatMaterialBestEffort(ctx, account, thumbMediaID)
		return nil, mcpWechatDraftOutput{}, mapMCPWechatPublishError(errors.Join(errWechatDraftCreateFailed, err))
	}
	if _, _, err := a.commitCreditReservation(
		ctx,
		principal.User.ID,
		draftReservation.ReservationID,
		int(wechatDraftSyncCredits*creditTokensPerCredit),
		map[string]any{"feature": "wechat_draft_sync", "source": "mcp"},
	); err != nil {
		return nil, mcpWechatDraftOutput{}, mapMCPWechatPublishError(err)
	}
	draftCreditsCommitted = true
	result = "success"
	return nil, mcpWechatDraftOutput{
		MediaID: mediaID, AccountID: account.AccountID, DocID: doc.DocID, Title: doc.Title,
		CoverMode: coverMode, CoverRatio: ratio, GeoIncluded: input.IncludeGeo,
	}, nil
}

func normalizeMCPWechatImageSource(source, workerURL, appURL string) string {
	value := strings.TrimSpace(source)
	if !strings.HasPrefix(value, "/images/") {
		return value
	}
	base := strings.TrimRight(strings.TrimSpace(workerURL), "/")
	if base == "" {
		base = strings.TrimRight(strings.TrimSpace(appURL), "/")
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return value
	}
	return base + value
}

func (a *App) normalizeMCPWechatImageSources(content string) (string, error) {
	matches := wechatImageSourcePattern.FindAllStringSubmatchIndex(content, -1)
	if len(matches) == 0 {
		return content, nil
	}
	sources := make([]string, 0, len(matches))
	replacements := make(map[string]string, len(matches))
	for _, match := range matches {
		source := imageSourceFromMatch(content, match)
		sources = append(sources, source)
		replacements[source] = normalizeMCPWechatImageSource(source, a.cfg.WorkerURL, a.cfg.AppURL)
	}
	return rewriteWechatImageSources(content, matches, sources, replacements)
}

func renderMCPWechatHTML(markdown string) (string, error) {
	var rendered bytes.Buffer
	parser := goldmark.New(goldmark.WithRendererOptions(goldmarkHTML.WithHardWraps(), goldmarkHTML.WithUnsafe()))
	if err := parser.Convert([]byte(markdown), &rendered); err != nil {
		return "", fmt.Errorf("render document for WeChat: %w", err)
	}
	content := strings.TrimSpace(rendered.String())
	if content == "" {
		return "", errors.New("document content is empty")
	}
	return `<section style="font-size:16px;line-height:1.75;color:#222;word-break:break-word;">` + content + `</section>`, nil
}

func (a *App) generateWechatCoverForMCP(ctx context.Context, userID int, prompt, ratio string) ([]byte, error) {
	reservation, err := a.reserveStandaloneCredits(ctx, userID, wechatCoverGenerationCredits, wechatCoverReservationTTL)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = a.releaseCreditReservation(cleanupCtx, userID, reservation.ReservationID)
	}()
	generationContext, cancel := context.WithTimeout(ctx, wechatCoverGenerationRunLimit)
	defer cancel()
	cover, err := a.generateWechatCover(generationContext, prompt, ratio)
	if err != nil {
		return nil, err
	}
	if _, _, err := a.commitCreditReservation(ctx, userID, reservation.ReservationID, int(wechatCoverGenerationCredits*creditTokensPerCredit), map[string]any{
		"feature": "wechat_cover_generation",
		"ratio":   ratio,
		"model":   a.cfg.WechatCoverImageModel,
		"source":  "mcp",
	}); err != nil {
		return nil, err
	}
	committed = true
	return cover.Data, nil
}

func mapMCPWechatPublishError(err error) error {
	switch {
	case errors.Is(err, errMCPWechatDraftInsufficientCredits):
		return errMCPWechatDraftInsufficientCredits
	case errors.Is(err, errInsufficientCredits):
		return errors.New("not enough credits for an AI cover")
	case errors.Is(err, errWechatPersistence), errors.Is(err, errWechatCredentialCrypto), errors.Is(err, errCreditReservationNotFound), errors.Is(err, errCreditReservationReleased):
		return errors.New("WeChat publishing is temporarily unavailable")
	case errors.Is(err, errWechatAccountNotBound):
		return errors.New("WeChat Official Account is not bound")
	case errors.Is(err, errWechatProviderUnavailable):
		return errors.New("WeChat is temporarily unavailable")
	case errors.Is(err, errWechatCoverUploadFailed):
		return errors.New("WeChat cover upload failed")
	case errors.Is(err, errWechatContentImageFailed), errors.Is(err, errWechatImageUnreachable):
		return errors.New("an article image could not be transferred to WeChat")
	case errors.Is(err, errWechatDraftCreateFailed):
		return errors.New("WeChat could not create the draft")
	case errors.Is(err, errWechatCoverGenerationFailed), errors.Is(err, errWechatCoverModelUnavailable):
		return errors.New("WeChat cover generation failed")
	default:
		var providerError *wechatProviderError
		if errors.As(err, &providerError) {
			switch providerError.Code {
			case 40013, 40125:
				return errors.New("WeChat Official Account credentials were rejected")
			case 40164:
				return errors.New("the server is not allowed by the WeChat IP allowlist")
			case 48001, 48004, 48005:
				return errors.New("the bound WeChat account cannot use this API")
			case 45009:
				return errors.New("WeChat API daily limit reached")
			default:
				return errors.New("WeChat rejected the request")
			}
		}
		if strings.Contains(err.Error(), "too many WeChat") {
			return err
		}
		return err
	}
}
