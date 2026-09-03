package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"image"
	"image/color"
	stddraw "image/draw"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"koinote/backend/internal/httpx"
)

const (
	wechatCoverPromptMaxRunes       = 1200
	wechatCoverGenerateRequestBytes = 8 << 10
	wechatCoverProviderMaxBytes     = 30 << 20
	wechatGeneratedCoverMaxBytes    = 20 << 20
	wechatThumbMaxBytes             = 64 << 10
	wechatDraftRequestMaxBytes      = 12 << 20
	wechatDraftHTMLMaxBytes         = 2 << 20
	wechatDraftMaxImages            = 20
	wechatDraftImagePrepareWorkers  = 2
	wechatRemoteImageMaxBytes       = 5 << 20
	wechatContentImageMaxBytes      = 1 << 20
	wechatImageMaxPixels            = 36_000_000
	wechatCoverGenerateLimit        = 8
	wechatCoverGenerateWindow       = time.Hour
	wechatCoverGenerationCredits    = int64(20)
	wechatCoverGenerationRunLimit   = llmRequestTimeout
	wechatCoverReservationTTL       = wechatCoverGenerationRunLimit + 2*time.Minute
	wechatDraftCreateLimit          = 30
	wechatDraftCreateWindow         = time.Hour
	wechatDraftSyncCredits          = int64(20)
	wechatDraftReservationTTL       = 30 * time.Minute
)

const (
	wechatCoverRatioWide   = "2.35:1"
	wechatCoverRatioSquare = "1:1"
	wechatCoverModeDefault = "default"
	wechatCoverModeArticle = "article"
	wechatCoverModeAI      = "ai"
)

var (
	wechatImageSourcePattern       = regexp.MustCompile(`(?i)(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	errWechatCoverModelUnavailable = errors.New("wechat cover image model is unavailable")
	errWechatCoverGenerationFailed = errors.New("wechat cover image generation failed")
	errWechatCoverUploadFailed     = errors.New("wechat cover upload failed")
	errWechatContentImageFailed    = errors.New("wechat content image transfer failed")
	errWechatDraftCreateFailed     = errors.New("wechat draft creation failed")
	errWechatImageUnreachable      = errors.New("wechat article image is unreachable")
)

type wechatCoverImage struct {
	Data     []byte
	Ratio    string
	Width    int
	Height   int
	MimeType string
}

type wechatDraftImagePreparation struct {
	Source   string
	Raw      []byte
	Prepared []byte
	Err      error
}

type wechatArticleImageError struct {
	Index int
	Host  string
	Stage string
	Err   error
}

func (e *wechatArticleImageError) Error() string {
	location := fmt.Sprintf("article image %d", e.Index+1)
	if e.Host != "" {
		location += " from " + e.Host
	}
	return location + " failed during " + e.Stage
}

func (e *wechatArticleImageError) Unwrap() error {
	return e.Err
}

func (a *App) wechatCoverGenerate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	if !a.cfg.WechatCoverImageEnabled() {
		writeWechatPublishError(w, errWechatCoverModelUnavailable)
		return
	}
	var input struct {
		Prompt string `json:"prompt"`
		Ratio  string `json:"ratio"`
	}
	if !decodeWechatJSONBody(w, r, wechatCoverGenerateRequestBytes, &input) {
		return
	}
	input.Prompt = strings.TrimSpace(input.Prompt)
	if input.Ratio == "" {
		input.Ratio = wechatCoverRatioWide
	}
	if input.Prompt == "" || utf8.RuneCountInString(input.Prompt) > wechatCoverPromptMaxRunes ||
		!validWechatCoverRatio(input.Ratio) {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Invalid cover prompt or ratio")
		return
	}
	if !a.rateLimit().allow("wechat-cover:"+strconv.Itoa(user.ID), wechatCoverGenerateLimit, wechatCoverGenerateWindow) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests", "Too many cover generation requests")
		return
	}
	reservation, err := a.reserveStandaloneCredits(
		r.Context(),
		user.ID,
		wechatCoverGenerationCredits,
		wechatCoverReservationTTL,
	)
	if errors.Is(err, errInsufficientCredits) {
		httpx.ErrorCode(w, http.StatusPaymentRequired, "insufficient_credits", "Not enough credits for cover generation")
		return
	}
	if err != nil {
		log.Printf("wechat cover reserve credits: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, releaseErr := a.releaseCreditReservation(cleanupCtx, user.ID, reservation.ReservationID); releaseErr != nil &&
			!errors.Is(releaseErr, errCreditReservationNotFound) {
			log.Printf("wechat cover release credits: %v", releaseErr)
		}
	}()
	generationContext, cancelGeneration := context.WithTimeout(r.Context(), wechatCoverGenerationRunLimit)
	defer cancelGeneration()
	cover, err := a.generateWechatCover(generationContext, input.Prompt, input.Ratio)
	if err != nil {
		log.Printf("wechat cover generate: %v", err)
		writeWechatPublishError(w, err)
		return
	}
	if _, _, err := a.commitCreditReservation(
		r.Context(),
		user.ID,
		reservation.ReservationID,
		int(wechatCoverGenerationCredits*creditTokensPerCredit),
		map[string]any{
			"feature": "wechat_cover_generation",
			"ratio":   input.Ratio,
			"model":   a.cfg.WechatCoverImageModel,
		},
	); err != nil {
		if errors.Is(err, errInsufficientCredits) {
			httpx.ErrorCode(w, http.StatusPaymentRequired, "insufficient_credits", "Not enough credits for cover generation")
			return
		}
		log.Printf("wechat cover commit credits: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	committed = true
	httpx.JSON(w, http.StatusOK, map[string]any{
		"cover": map[string]any{
			"base64":   base64.StdEncoding.EncodeToString(cover.Data),
			"mimeType": cover.MimeType,
			"ratio":    cover.Ratio,
			"width":    cover.Width,
			"height":   cover.Height,
		},
	})
}

func (a *App) generateWechatCover(ctx context.Context, prompt, ratio string) (wechatCoverImage, error) {
	endpoint, err := wechatCoverGenerationEndpoint(a.cfg.WechatCoverImageBaseURL)
	if err != nil {
		return wechatCoverImage{}, errors.Join(errWechatCoverGenerationFailed, err)
	}
	size := "1536x1024"
	if ratio == wechatCoverRatioSquare {
		size = "1024x1024"
	}
	composition := "Target aspect ratio: 2.35:1 (ultra-wide banner). Keep the subject and every essential detail inside the central safe area because the result will be prepared for WeChat's wide thumbnail."
	if ratio == wechatCoverRatioSquare {
		composition = "Target aspect ratio: 1:1 (square). Keep the subject and every essential detail comfortably inside the frame."
	}
	payload, err := json.Marshal(map[string]any{
		"model":  a.cfg.WechatCoverImageModel,
		"prompt": "Create a polished WeChat Official Account article cover. No logos, watermarks, QR codes, or unreadable text. " + composition + " User brief: " + prompt,
		"n":      1,
		"size":   size,
	})
	if err != nil {
		return wechatCoverImage{}, errors.Join(errWechatCoverGenerationFailed, err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return wechatCoverImage{}, errors.Join(errWechatCoverGenerationFailed, err)
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.WechatCoverImageAPIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	client := a.wechatCoverHTTPClient
	if client == nil {
		client = newTrustedLLMHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return wechatCoverImage{}, errors.Join(errWechatCoverGenerationFailed, err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, wechatCoverProviderMaxBytes+1))
	if err != nil || len(responseBody) > wechatCoverProviderMaxBytes {
		return wechatCoverImage{}, errWechatCoverGenerationFailed
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return wechatCoverImage{}, fmt.Errorf("%w: provider HTTP %d", errWechatCoverGenerationFailed, response.StatusCode)
	}
	var result struct {
		Data []struct {
			Base64 string `json:"b64_json"`
			URL    string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(responseBody, &result); err != nil || len(result.Data) != 1 {
		return wechatCoverImage{}, errWechatCoverGenerationFailed
	}
	raw, err := a.readGeneratedCover(ctx, result.Data[0].Base64, result.Data[0].URL)
	if err != nil {
		return wechatCoverImage{}, errors.Join(errWechatCoverGenerationFailed, err)
	}
	data, width, height, err := prepareWechatThumb(raw, ratio)
	if err != nil {
		return wechatCoverImage{}, errors.Join(errWechatCoverGenerationFailed, err)
	}
	return wechatCoverImage{Data: data, Ratio: ratio, Width: width, Height: height, MimeType: "image/jpeg"}, nil
}

func wechatCoverGenerationEndpoint(baseURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("invalid cover image base URL")
	}
	path := strings.TrimRight(parsed.Path, "/")
	switch {
	case strings.HasSuffix(path, "/images/generations"):
		parsed.Path = path
	case strings.HasSuffix(path, "/v1"):
		parsed.Path = path + "/images/generations"
	default:
		parsed.Path = path + "/v1/images/generations"
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func (a *App) readGeneratedCover(ctx context.Context, encoded, remoteURL string) ([]byte, error) {
	encoded = strings.TrimSpace(encoded)
	if comma := strings.IndexByte(encoded, ','); strings.HasPrefix(encoded, "data:") && comma >= 0 {
		encoded = encoded[comma+1:]
	}
	if encoded != "" {
		decoder := base64.NewDecoder(base64.StdEncoding, strings.NewReader(encoded))
		data, err := io.ReadAll(io.LimitReader(decoder, wechatGeneratedCoverMaxBytes+1))
		if err != nil || len(data) == 0 || len(data) > wechatGeneratedCoverMaxBytes {
			return nil, errors.New("invalid generated cover data")
		}
		return data, nil
	}
	if strings.TrimSpace(remoteURL) == "" {
		return nil, errors.New("cover provider returned no image")
	}
	return a.downloadWechatImage(ctx, remoteURL, wechatGeneratedCoverMaxBytes)
}

func (a *App) wechatDraftCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireWechatMember(w, r)
	if !ok {
		return
	}
	var input struct {
		AccountID        string `json:"accountId"`
		Title            string `json:"title"`
		Author           string `json:"author"`
		Digest           string `json:"digest"`
		HTML             string `json:"html"`
		CoverMode        string `json:"coverMode"`
		CoverBase64      string `json:"coverBase64"`
		CoverRatio       string `json:"coverRatio"`
		CoverImageSource string `json:"coverImageSource"`
	}
	if !decodeWechatJSONBody(w, r, wechatDraftRequestMaxBytes, &input) {
		return
	}
	input.Title = strings.TrimSpace(input.Title)
	input.AccountID = strings.TrimSpace(input.AccountID)
	input.Author = strings.TrimSpace(input.Author)
	input.Digest = strings.TrimSpace(input.Digest)
	input.HTML = strings.TrimSpace(input.HTML)
	input.CoverMode = strings.TrimSpace(input.CoverMode)
	input.CoverImageSource = strings.TrimSpace(input.CoverImageSource)
	if input.CoverMode == "" && strings.TrimSpace(input.CoverBase64) != "" {
		input.CoverMode = wechatCoverModeAI
	}
	if input.Title == "" || utf8.RuneCountInString(input.Title) > 64 {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_title_invalid", "WeChat draft title must contain 1 to 64 characters")
		return
	}
	if utf8.RuneCountInString(input.Author) > 16 || utf8.RuneCountInString(input.Digest) > 128 {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_draft_input_invalid", "Invalid WeChat draft metadata")
		return
	}
	if input.HTML == "" || len(input.HTML) > wechatDraftHTMLMaxBytes {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_draft_input_invalid", "Invalid WeChat draft content")
		return
	}
	if input.CoverMode != "" && !validWechatCoverMode(input.CoverMode) {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Invalid cover source")
		return
	}
	if input.CoverMode == wechatCoverModeArticle && input.CoverImageSource == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Article cover image is required")
		return
	}
	if input.CoverMode != wechatCoverModeArticle && input.CoverImageSource != "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Unexpected article cover image")
		return
	}
	if input.CoverMode == wechatCoverModeAI && strings.TrimSpace(input.CoverBase64) == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "AI cover image is required")
		return
	}
	if input.CoverMode != wechatCoverModeAI && input.CoverMode != wechatCoverModeDefault && strings.TrimSpace(input.CoverBase64) != "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Unexpected cover image")
		return
	}
	if input.CoverMode != "" {
		if input.CoverRatio == "" {
			input.CoverRatio = wechatCoverRatioWide
		}
		if !validWechatCoverRatio(input.CoverRatio) {
			httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Invalid cover ratio")
			return
		}
	}
	if !a.rateLimit().allow("wechat-draft:"+strconv.Itoa(user.ID), wechatDraftCreateLimit, wechatDraftCreateWindow) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests", "Too many WeChat draft requests")
		return
	}
	var owned bool
	if err := a.db.QueryRow(r.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM documents
			WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
		)
	`, strings.TrimSpace(r.PathValue("docId")), user.ID).Scan(&owned); err != nil {
		log.Printf("wechat draft document ownership: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if !owned {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	account, err := a.resolveWechatOfficialAccountRef(r.Context(), user.ID, input.AccountID)
	if err != nil {
		writeWechatOfficialError(w, err)
		return
	}
	draftReservation, err := a.reserveStandaloneCredits(
		r.Context(),
		user.ID,
		wechatDraftSyncCredits,
		wechatDraftReservationTTL,
	)
	if errors.Is(err, errInsufficientCredits) {
		httpx.ErrorCode(w, http.StatusPaymentRequired, "insufficient_credits", "Not enough credits for WeChat draft synchronization")
		return
	}
	if err != nil {
		log.Printf("wechat draft reserve credits: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	draftCreditsCommitted := false
	defer func() {
		if draftCreditsCommitted {
			return
		}
		cleanupContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, releaseErr := a.releaseCreditReservation(cleanupContext, user.ID, draftReservation.ReservationID); releaseErr != nil &&
			!errors.Is(releaseErr, errCreditReservationNotFound) {
			log.Printf("wechat draft release credits: %v", releaseErr)
		}
	}()
	var cover []byte
	if strings.TrimSpace(input.CoverBase64) != "" {
		coverRaw, decodeErr := decodeWechatCoverInput(input.CoverBase64)
		if decodeErr != nil {
			httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Invalid cover image")
			return
		}
		cover, _, _, err = prepareWechatThumb(coverRaw, input.CoverRatio)
		if err != nil {
			httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Invalid cover image")
			return
		}
	}
	if input.CoverMode == wechatCoverModeArticle && !wechatHTMLHasImageSource(input.HTML, input.CoverImageSource) {
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Article cover image is not in the article")
		return
	}
	content, selectedImage, err := a.transferWechatDraftImagesWithCoverImage(
		r.Context(),
		account,
		input.HTML,
		input.CoverMode == wechatCoverModeArticle,
		input.CoverImageSource,
	)
	if err != nil {
		log.Printf("wechat draft image transfer: %v", err)
		writeWechatPublishError(w, err)
		return
	}
	if len(cover) == 0 && input.CoverMode == wechatCoverModeArticle {
		if len(selectedImage) == 0 {
			httpx.ErrorCode(w, http.StatusBadRequest, "wechat_cover_input_invalid", "Article cover image could not be loaded")
			return
		}
		cover, _, _, err = prepareWechatThumb(selectedImage, input.CoverRatio)
	} else if len(cover) == 0 && input.CoverMode == "" && len(selectedImage) > 0 {
		cover, _, _, err = prepareWechatThumb(selectedImage, wechatCoverRatioWide)
	} else if len(cover) == 0 {
		cover, err = defaultWechatCover(input.Title, input.CoverRatio)
	}
	if err != nil {
		log.Printf("wechat fallback cover: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	thumbMediaID, err := a.uploadWechatThumb(r.Context(), account, cover)
	if err != nil {
		writeWechatPublishError(w, errors.Join(errWechatCoverUploadFailed, err))
		return
	}
	mediaID, err := a.createWechatDraft(r.Context(), account, input.Title, input.Author, input.Digest, content, thumbMediaID)
	if err != nil {
		a.deleteWechatMaterialBestEffort(r.Context(), account, thumbMediaID)
		writeWechatPublishError(w, errors.Join(errWechatDraftCreateFailed, err))
		return
	}
	if _, _, err := a.commitCreditReservation(
		r.Context(),
		user.ID,
		draftReservation.ReservationID,
		int(wechatDraftSyncCredits*creditTokensPerCredit),
		map[string]any{"feature": "wechat_draft_sync", "source": "http"},
	); err != nil {
		log.Printf("wechat draft commit credits: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Draft was created, but usage could not be recorded")
		return
	}
	draftCreditsCommitted = true
	httpx.JSON(w, http.StatusOK, map[string]any{
		"draft": map[string]string{"mediaId": mediaID},
	})
}

func validWechatCoverRatio(ratio string) bool {
	return ratio == wechatCoverRatioWide || ratio == wechatCoverRatioSquare
}

func validWechatCoverMode(mode string) bool {
	return mode == wechatCoverModeDefault || mode == wechatCoverModeArticle || mode == wechatCoverModeAI
}

func wechatHTMLHasImageSource(content, source string) bool {
	for _, match := range wechatImageSourcePattern.FindAllStringSubmatchIndex(content, -1) {
		if imageSourceFromMatch(content, match) == source {
			return true
		}
	}
	return false
}

func decodeWechatCoverInput(encoded string) ([]byte, error) {
	encoded = strings.TrimSpace(encoded)
	if comma := strings.IndexByte(encoded, ','); strings.HasPrefix(encoded, "data:") && comma >= 0 {
		encoded = encoded[comma+1:]
	}
	decoder := base64.NewDecoder(base64.StdEncoding, strings.NewReader(encoded))
	data, err := io.ReadAll(io.LimitReader(decoder, wechatGeneratedCoverMaxBytes+1))
	if err != nil || len(data) == 0 || len(data) > wechatGeneratedCoverMaxBytes {
		return nil, errors.New("invalid cover image")
	}
	return data, nil
}

func prepareWechatThumb(raw []byte, ratio string) ([]byte, int, int, error) {
	if !validWechatCoverRatio(ratio) {
		return nil, 0, 0, errors.New("invalid cover ratio")
	}
	configuration, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || configuration.Width <= 0 || configuration.Height <= 0 ||
		int64(configuration.Width)*int64(configuration.Height) > wechatImageMaxPixels {
		return nil, 0, 0, errors.New("invalid or oversized cover image")
	}
	source, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, err
	}
	targetRatio := 2.35
	targetWidth, targetHeight := 940, 400
	if ratio == wechatCoverRatioSquare {
		targetRatio = 1
		targetWidth, targetHeight = 560, 560
	}
	cropped := centerCropImage(source, targetRatio)
	for targetWidth >= 320 && targetHeight >= 136 {
		resized := resizeImageOnWhite(cropped, targetWidth, targetHeight)
		for quality := 88; quality >= 38; quality -= 5 {
			var output bytes.Buffer
			if err := jpeg.Encode(&output, resized, &jpeg.Options{Quality: quality}); err != nil {
				return nil, 0, 0, err
			}
			if output.Len() <= wechatThumbMaxBytes {
				return output.Bytes(), targetWidth, targetHeight, nil
			}
		}
		targetWidth = targetWidth * 4 / 5
		targetHeight = targetHeight * 4 / 5
	}
	return nil, 0, 0, errors.New("cover image cannot fit WeChat thumbnail limit")
}

func defaultWechatCover(title string, ratios ...string) ([]byte, error) {
	width, height := 940, 400
	if len(ratios) > 0 && ratios[0] == wechatCoverRatioSquare {
		width, height = 560, 560
	}
	seed := sha256.Sum256([]byte(title))
	cover := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			position := uint8((x*19 + y*31) % 32)
			cover.SetRGBA(x, y, color.RGBA{
				R: 24 + seed[0]%24 + position/4,
				G: 92 + seed[1]%52 + position,
				B: 82 + seed[2]%58 + position/2,
				A: 255,
			})
		}
	}
	var output bytes.Buffer
	if err := jpeg.Encode(&output, cover, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func centerCropImage(source image.Image, targetRatio float64) image.Image {
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	currentRatio := float64(width) / float64(height)
	if currentRatio > targetRatio {
		cropWidth := int(float64(height) * targetRatio)
		left := bounds.Min.X + (width-cropWidth)/2
		return cropImage(source, image.Rect(left, bounds.Min.Y, left+cropWidth, bounds.Max.Y))
	}
	if currentRatio < targetRatio {
		cropHeight := int(float64(width) / targetRatio)
		top := bounds.Min.Y + (height-cropHeight)/2
		return cropImage(source, image.Rect(bounds.Min.X, top, bounds.Max.X, top+cropHeight))
	}
	return cropImage(source, bounds)
}

func cropImage(source image.Image, rectangle image.Rectangle) image.Image {
	output := image.NewRGBA(image.Rect(0, 0, rectangle.Dx(), rectangle.Dy()))
	stddraw.Draw(output, output.Bounds(), source, rectangle.Min, stddraw.Src)
	return output
}

func resizeImageOnWhite(source image.Image, width, height int) *image.RGBA {
	output := image.NewRGBA(image.Rect(0, 0, width, height))
	stddraw.Draw(output, output.Bounds(), &image.Uniform{C: color.White}, image.Point{}, stddraw.Src)
	xdraw.CatmullRom.Scale(output, output.Bounds(), source, source.Bounds(), stddraw.Over, nil)
	return output
}

func (a *App) uploadWechatThumb(ctx context.Context, account wechatOfficialAccountRef, data []byte) (string, error) {
	var mediaID string
	err := a.withWechatAccessToken(ctx, account, func(token string) error {
		var response struct {
			MediaID string `json:"media_id"`
		}
		err := a.wechatPostMultipart(ctx, "/cgi-bin/material/add_material?type=thumb", token, "cover.jpg", "image/jpeg", data, &response)
		if err == nil && strings.TrimSpace(response.MediaID) == "" {
			return errWechatCoverUploadFailed
		}
		mediaID = response.MediaID
		return err
	})
	return mediaID, err
}

func (a *App) transferWechatDraftImages(ctx context.Context, account wechatOfficialAccountRef, content string) (string, error) {
	transferred, _, err := a.transferWechatDraftImagesWithFirstImage(ctx, account, content)
	return transferred, err
}

func (a *App) transferWechatDraftImagesWithFirstImage(ctx context.Context, account wechatOfficialAccountRef, content string) (string, []byte, error) {
	return a.transferWechatDraftImagesWithCoverImage(ctx, account, content, false, "")
}

func (a *App) transferWechatDraftImagesWithCoverImage(ctx context.Context, account wechatOfficialAccountRef, content string, selectCover bool, coverSource string) (string, []byte, error) {
	matches := wechatImageSourcePattern.FindAllStringSubmatchIndex(content, -1)
	if len(matches) == 0 {
		return content, nil, nil
	}
	sources := make([]string, 0, len(matches))
	uniqueSources := make([]string, 0, len(matches))
	unique := make(map[string]string)
	for _, match := range matches {
		source := imageSourceFromMatch(content, match)
		sources = append(sources, source)
		if _, found := unique[source]; !found {
			if len(unique) >= wechatDraftMaxImages {
				return "", nil, errors.Join(errWechatContentImageFailed, errors.New("too many article images"))
			}
			unique[source] = ""
			uniqueSources = append(uniqueSources, source)
		}
	}
	preserveRaw := make([]bool, len(uniqueSources))
	for index, source := range uniqueSources {
		preserveRaw[index] = index == 0 || selectCover && source == coverSource
	}
	preparations := a.prepareWechatDraftImages(ctx, uniqueSources, preserveRaw)
	var firstImage []byte
	var selectedImage []byte
	for index, preparation := range preparations {
		if preparation.Err != nil {
			return "", nil, preparation.Err
		}
		if firstImage == nil && preparation.Raw != nil {
			firstImage = preparation.Raw
		}
		if selectCover && preparation.Source == coverSource {
			selectedImage = preparation.Raw
		}
		var uploadedURL string
		err := a.withWechatAccessToken(ctx, account, func(token string) error {
			var response struct {
				URL string `json:"url"`
			}
			err := a.wechatPostMultipart(ctx, "/cgi-bin/media/uploadimg", token, "article.jpg", "image/jpeg", preparation.Prepared, &response)
			if err == nil && strings.TrimSpace(response.URL) == "" {
				return errWechatContentImageFailed
			}
			uploadedURL = response.URL
			return err
		})
		if err != nil {
			return "", nil, errors.Join(
				errWechatContentImageFailed,
				wechatArticleImageContext(index, preparation.Source, "upload", err),
			)
		}
		unique[preparation.Source] = uploadedURL
	}

	rewritten, err := rewriteWechatImageSources(content, matches, sources, unique)
	if err != nil {
		return "", nil, err
	}
	if selectCover {
		return rewritten, selectedImage, nil
	}
	return rewritten, firstImage, nil
}

func rewriteWechatImageSources(
	content string,
	matches [][]int,
	sources []string,
	replacements map[string]string,
) (string, error) {
	if len(matches) != len(sources) {
		return "", errors.Join(errWechatContentImageFailed, errors.New("article image source count mismatch"))
	}
	var output strings.Builder
	last := 0
	for index, match := range matches {
		sourceStart, sourceEnd := imageSourceIndexes(match)
		if sourceStart < last || sourceEnd < sourceStart || sourceEnd > len(content) {
			return "", errors.Join(errWechatContentImageFailed, errors.New("invalid article image source"))
		}
		replacement, found := replacements[sources[index]]
		if !found || strings.TrimSpace(replacement) == "" {
			return "", errors.Join(errWechatContentImageFailed, errors.New("missing uploaded article image"))
		}
		output.WriteString(content[last:sourceStart])
		quoted := sourceStart > 0 && (content[sourceStart-1] == '"' || content[sourceStart-1] == '\'')
		if !quoted {
			output.WriteByte('"')
		}
		output.WriteString(html.EscapeString(replacement))
		if !quoted {
			output.WriteByte('"')
		}
		last = sourceEnd
	}
	output.WriteString(content[last:])
	return output.String(), nil
}

func (a *App) prepareWechatDraftImages(
	ctx context.Context,
	sources []string,
	preserveRaw []bool,
) []wechatDraftImagePreparation {
	results := make([]wechatDraftImagePreparation, len(sources))
	jobs := make(chan int, len(sources))
	for index := range sources {
		jobs <- index
	}
	close(jobs)

	var workers sync.WaitGroup
	for worker := 0; worker < min(wechatDraftImagePrepareWorkers, len(sources)); worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				source := sources[index]
				result := wechatDraftImagePreparation{Source: source}
				raw, err := a.readWechatArticleImage(ctx, source)
				if err != nil {
					result.Err = errors.Join(
						errWechatImageUnreachable,
						wechatArticleImageContext(index, source, "download", err),
					)
					results[index] = result
					continue
				}
				prepared, err := prepareWechatContentImage(raw)
				if err != nil {
					result.Err = errors.Join(
						errWechatContentImageFailed,
						wechatArticleImageContext(index, source, "prepare", err),
					)
					results[index] = result
					continue
				}
				result.Prepared = prepared
				if index < len(preserveRaw) && preserveRaw[index] {
					result.Raw = raw
				}
				results[index] = result
			}
		}()
	}
	workers.Wait()
	return results
}

func wechatArticleImageContext(index int, source, stage string, err error) error {
	host := ""
	if parsed, parseErr := url.Parse(strings.TrimSpace(source)); parseErr == nil {
		host = strings.ToLower(parsed.Hostname())
	}
	return &wechatArticleImageError{Index: index, Host: host, Stage: stage, Err: err}
}

func imageSourceFromMatch(content string, match []int) string {
	start, end := imageSourceIndexes(match)
	if start >= 0 && end >= start {
		return strings.TrimSpace(html.UnescapeString(content[start:end]))
	}
	return ""
}

func imageSourceIndexes(match []int) (int, int) {
	for group := 2; group <= 4; group++ {
		start, end := match[group*2], match[group*2+1]
		if start >= 0 && end >= start {
			return start, end
		}
	}
	return -1, -1
}

func (a *App) readWechatArticleImage(ctx context.Context, source string) ([]byte, error) {
	if strings.HasPrefix(strings.ToLower(source), "data:") {
		comma := strings.IndexByte(source, ',')
		if comma < 0 || !strings.Contains(strings.ToLower(source[:comma]), ";base64") {
			return nil, errWechatImageUnreachable
		}
		decoder := base64.NewDecoder(base64.StdEncoding, strings.NewReader(source[comma+1:]))
		data, err := io.ReadAll(io.LimitReader(decoder, wechatRemoteImageMaxBytes+1))
		if err != nil || len(data) == 0 || len(data) > wechatRemoteImageMaxBytes {
			return nil, errWechatImageUnreachable
		}
		return data, nil
	}
	return a.downloadWechatImage(ctx, source, wechatRemoteImageMaxBytes)
}

func (a *App) downloadWechatImage(ctx context.Context, source string, maxBytes int64) ([]byte, error) {
	parsed, err := url.Parse(strings.TrimSpace(source))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return nil, errWechatImageUnreachable
	}
	parsed.Fragment = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, errWechatImageUnreachable
	}
	request.Header.Set("Accept", "image/webp,image/png,image/jpeg,image/gif")
	client := a.wechatImageHTTPClient
	if client == nil {
		client = newSafeLLMHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errWechatImageUnreachable
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("image returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil || len(data) == 0 || int64(len(data)) > maxBytes {
		return nil, errWechatImageUnreachable
	}
	return data, nil
}

func prepareWechatContentImage(raw []byte) ([]byte, error) {
	configuration, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || configuration.Width <= 0 || configuration.Height <= 0 ||
		int64(configuration.Width)*int64(configuration.Height) > wechatImageMaxPixels {
		return nil, errors.New("invalid or oversized article image")
	}
	source, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	width, height := configuration.Width, configuration.Height
	if longest := max(width, height); longest > 2000 {
		width = width * 2000 / longest
		height = height * 2000 / longest
	}
	for attempt := 0; attempt < 8; attempt++ {
		resized := resizeImageOnWhite(source, width, height)
		for quality := 88; quality >= 45; quality -= 7 {
			var output bytes.Buffer
			if err := jpeg.Encode(&output, resized, &jpeg.Options{Quality: quality}); err != nil {
				return nil, err
			}
			if output.Len() <= wechatContentImageMaxBytes {
				return output.Bytes(), nil
			}
		}
		width = max(1, width*4/5)
		height = max(1, height*4/5)
	}
	return nil, errors.New("article image cannot fit WeChat limit")
}

func (a *App) createWechatDraft(ctx context.Context, account wechatOfficialAccountRef, title, author, digest, content, thumbMediaID string) (string, error) {
	var mediaID string
	err := a.withWechatAccessToken(ctx, account, func(token string) error {
		var response struct {
			MediaID string `json:"media_id"`
		}
		article := map[string]any{
			"title":                 title,
			"content":               content,
			"thumb_media_id":        thumbMediaID,
			"need_open_comment":     0,
			"only_fans_can_comment": 0,
		}
		if author != "" {
			article["author"] = author
		}
		if digest != "" {
			article["digest"] = digest
		}
		err := a.wechatPostJSON(ctx, "/cgi-bin/draft/add", token, map[string]any{
			"articles": []map[string]any{article},
		}, &response)
		if err == nil && strings.TrimSpace(response.MediaID) == "" {
			return errWechatDraftCreateFailed
		}
		mediaID = response.MediaID
		return err
	})
	return mediaID, err
}

func (a *App) deleteWechatMaterialBestEffort(ctx context.Context, account wechatOfficialAccountRef, mediaID string) {
	if strings.TrimSpace(mediaID) == "" {
		return
	}
	cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	if err := a.withWechatAccessToken(cleanupContext, account, func(token string) error {
		return a.wechatPostJSON(cleanupContext, "/cgi-bin/material/del_material", token, map[string]string{
			"media_id": mediaID,
		}, nil)
	}); err != nil {
		log.Printf("wechat orphan cover cleanup: %v", err)
	}
}

func (a *App) withWechatAccessToken(ctx context.Context, account wechatOfficialAccountRef, action func(string) error) error {
	token, err := a.wechatAccessTokenForAccount(ctx, account, false)
	if err != nil {
		return err
	}
	err = action(token)
	if !isWechatAccessTokenError(err) {
		return err
	}
	token, refreshErr := a.wechatAccessTokenForAccountAfterFailure(ctx, account, token)
	if refreshErr != nil {
		return refreshErr
	}
	return action(token)
}

func (a *App) wechatPostMultipart(
	ctx context.Context,
	path, accessToken, filename, contentType string,
	data []byte,
	output any,
) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="media"; filename="%s"`, filename))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	if _, err := part.Write(data); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	endpoint := wechatAPIBaseURL + path + separator + "access_token=" + url.QueryEscape(accessToken)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Accept", "application/json")
	client := a.wechatAPIHTTPClient
	if client == nil {
		client = newWechatAPIHTTPClient(a.cfg.WechatAPIProxyURL)
	}
	response, err := client.Do(request)
	if err != nil {
		return wechatProviderRequestError(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, wechatProviderResponseBytes+1))
	if err != nil || len(responseBody) > wechatProviderResponseBytes || response.StatusCode < 200 || response.StatusCode >= 300 {
		return errWechatProviderUnavailable
	}
	var providerStatus struct {
		ErrCode int    `json:"errcode"`
		ErrMsg  string `json:"errmsg"`
	}
	if err := json.Unmarshal(responseBody, &providerStatus); err != nil {
		return errWechatProviderUnavailable
	}
	if providerStatus.ErrCode != 0 {
		return &wechatProviderError{Code: providerStatus.ErrCode, Message: providerStatus.ErrMsg}
	}
	if err := json.Unmarshal(responseBody, output); err != nil {
		return errWechatProviderUnavailable
	}
	return nil
}

func writeWechatPublishError(w http.ResponseWriter, err error) {
	var providerError *wechatProviderError
	if errors.As(err, &providerError) {
		switch providerError.Code {
		case 40013, 40125, 40164, 48001, 48004, 48005, 45009:
			writeWechatOfficialError(w, err)
			return
		}
	}
	switch {
	case errors.Is(err, errWechatAccountNotBound),
		errors.Is(err, errWechatCredentialCrypto),
		errors.Is(err, errWechatPersistence):
		writeWechatOfficialError(w, err)
	case errors.Is(err, errWechatCoverModelUnavailable):
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "wechat_cover_model_unavailable", "Cover image generation is not configured")
	case errors.Is(err, errWechatCoverGenerationFailed):
		httpx.ErrorCode(w, http.StatusBadGateway, "wechat_cover_generation_failed", "Cover image generation failed")
	case errors.Is(err, errWechatCoverUploadFailed):
		httpx.ErrorCode(w, http.StatusBadGateway, "wechat_cover_upload_failed", "WeChat rejected the cover image")
	case errors.Is(err, errWechatImageUnreachable):
		httpx.ErrorCode(w, http.StatusBadRequest, "wechat_image_unreachable", "An article image cannot be downloaded")
	case errors.Is(err, errWechatContentImageFailed):
		httpx.ErrorCode(w, http.StatusBadGateway, "wechat_content_image_failed", "An article image could not be transferred to WeChat")
	case errors.Is(err, errWechatDraftCreateFailed):
		httpx.ErrorCode(w, http.StatusBadGateway, "wechat_draft_create_failed", "WeChat could not create the draft")
	default:
		writeWechatOfficialError(w, err)
	}
}
