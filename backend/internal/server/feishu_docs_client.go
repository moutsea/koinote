package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

const feishuAPIBaseURL = "https://open.feishu.cn/open-apis"
const feishuTokenURL = "https://accounts.feishu.cn/oauth/v3/token"
const feishuScope = "docx:document docx:document.block:convert docs:document.media:upload offline_access"

var errFeishuNotConfigured = errors.New("feishu_not_configured")
var errFeishuNotBound = errors.New("feishu_account_not_bound")
var errFeishuTokenInvalid = errors.New("feishu_token_invalid")
var errFeishuBusy = errors.New("feishu_busy")
var errFeishuServerBusy = errors.New("feishu_server_busy")
var errFeishuContentLimit = errors.New("feishu_content_limit")
var errFeishuImage = errors.New("feishu_image_failed")
var errFeishuDocumentMissing = errors.New("feishu_document_missing")

type feishuAPIError struct {
	Status int
	Code   int
}

func (failure *feishuAPIError) Error() string {
	return fmt.Sprintf("Feishu HTTP %d, code %d", failure.Status, failure.Code)
}

func newFeishuDocsHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("Feishu redirects are disabled")
		},
	}
}

func (a *App) feishuHTTPClient() *http.Client {
	if a.feishuDocsHTTPClient != nil {
		return a.feishuDocsHTTPClient
	}
	return newFeishuDocsHTTPClient()
}

func (a *App) feishuPace(ctx context.Context) error {
	a.feishuRequestMu.Lock()
	wait := time.Until(a.feishuNextRequest)
	if wait < 0 {
		wait = 0
	}
	a.feishuNextRequest = time.Now().Add(wait + 350*time.Millisecond)
	a.feishuRequestMu.Unlock()
	return waitFeishu(ctx, wait)
}

func waitFeishu(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (a *App) feishuJSON(ctx context.Context, token, method, path string, body, output any) error {
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	data, err := a.feishuCall(ctx, token, method, path, "application/json; charset=utf-8", payload)
	if err != nil {
		return err
	}
	if output != nil {
		if len(data) == 0 || string(data) == "null" {
			return errors.New("Feishu response data missing")
		}
		return json.Unmarshal(data, output)
	}
	return nil
}

func (a *App) feishuCall(ctx context.Context, token, method, path, contentType string, payload []byte) (json.RawMessage, error) {
	for attempt := 0; attempt < 4; attempt++ {
		if err := a.feishuPace(ctx); err != nil {
			return nil, err
		}
		request, err := http.NewRequestWithContext(ctx, method, feishuAPIBaseURL+path, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", contentType)
		response, err := a.feishuHTTPClient().Do(request)
		if err != nil {
			return nil, errors.New("Feishu request failed")
		}
		raw, readErr := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
		response.Body.Close()
		if readErr != nil || len(raw) > 16<<20 {
			return nil, errors.New("Feishu response unavailable or too large")
		}
		var envelope struct {
			Code *int            `json:"code"`
			Data json.RawMessage `json:"data"`
		}
		decodeErr := json.Unmarshal(raw, &envelope)
		code := -1
		if envelope.Code != nil {
			code = *envelope.Code
		}
		if (response.StatusCode == 429 || code == 99991400) && attempt < 3 {
			delay := time.Second * time.Duration(1<<attempt)
			if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 && seconds <= 30 {
				delay = time.Duration(seconds) * time.Second
			}
			if err := waitFeishu(ctx, delay); err != nil {
				return nil, err
			}
			continue
		}
		if response.StatusCode == 401 || code == 99991668 || code == 99991663 {
			return nil, errFeishuTokenInvalid
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 || code != 0 || decodeErr != nil {
			return nil, &feishuAPIError{Status: response.StatusCode, Code: code}
		}
		return envelope.Data, nil
	}
	return nil, errors.New("Feishu retry limit reached")
}

type feishuTokenResponse struct {
	Code         int    `json:"code"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
}

func (a *App) feishuTokenRequest(ctx context.Context, values map[string]string) (feishuTokenResponse, error) {
	values["client_id"] = a.cfg.FeishuClientID
	values["client_secret"] = a.cfg.FeishuClientSecret
	payload, err := json.Marshal(values)
	if err != nil {
		return feishuTokenResponse{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, feishuTokenURL, bytes.NewReader(payload))
	if err != nil {
		return feishuTokenResponse{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := a.feishuHTTPClient().Do(request)
	if err != nil {
		return feishuTokenResponse{}, errors.New("Feishu token request failed")
	}
	defer response.Body.Close()
	var token feishuTokenResponse
	err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&token)
	if err != nil || response.StatusCode != 200 || token.Code != 0 || token.AccessToken == "" || token.RefreshToken == "" || token.ExpiresIn <= 0 {
		return feishuTokenResponse{}, errFeishuTokenInvalid
	}
	return token, nil
}
