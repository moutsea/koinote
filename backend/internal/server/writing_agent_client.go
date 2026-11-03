package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type writingRemoteError struct {
	Status                      int
	Method, Path, Message, Code string
}

func (e *writingRemoteError) Error() string {
	return fmt.Sprintf("agent-gpt %s %s returned HTTP %d: %s", e.Method, e.Path, e.Status, e.Message)
}

func (e *writingRemoteError) inputValidationFailure() bool {
	switch e.Code {
	case "invalid_task_context", "task_context_too_large", "task_state_too_large", "invalid_focus_snapshot", "invalid_message_sources", "current_message_mismatch":
		return true
	default:
		return e.Message == "Invalid systemPrompt" || strings.HasPrefix(e.Message, "Initial message history exceeds") || strings.HasPrefix(e.Message, "Initial message content must")
	}
}

// encodeURIComponent, not QueryEscape: the signature contract uses %20 for spaces.
func agentEncode(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(s))
}

func agentRequestSignature(secret, method string, u *url.URL, body []byte, timestamp, nonce string) string {
	query := []string{}
	for k, values := range u.Query() {
		for _, v := range values {
			query = append(query, agentEncode(k)+"="+agentEncode(v))
		}
	}
	sort.Strings(query)
	digest := sha256.Sum256(body)
	message := strings.Join([]string{"agts-v1", method, u.EscapedPath(), strings.Join(query, "&"), timestamp, nonce, hex.EncodeToString(digest[:])}, "\n")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))
	return "t=" + timestamp + ",n=" + nonce + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func (a *App) agentGPTRequest(ctx context.Context, method, path, externalID, idempotency string, input, output any) error {
	var body []byte
	var err error
	if input != nil {
		body, err = json.Marshal(input)
		if err != nil {
			return err
		}
	}
	u, err := url.Parse(a.cfg.AgentGPTBaseURL + path)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && !a.cfg.IsProduction() && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost"))) {
		return fmt.Errorf("invalid agent-gpt endpoint")
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.AgentGPTAPIKey)
	req.Header.Set("User-Agent", "Koinote-Writing-Agent/1.0")
	req.Header.Set("Content-Type", "application/json")
	if externalID != "" {
		req.Header.Set("X-App-User", externalID)
	}
	if idempotency != "" {
		req.Header.Set("Idempotency-Key", idempotency)
	}
	if a.cfg.AgentGPTSignRequests {
		if a.cfg.AgentGPTSigningSecret == "" {
			return fmt.Errorf("agent-gpt request signing enabled without secret")
		}
		nonce, err := randomUUID()
		if err != nil {
			return err
		}
		req.Header.Set("X-Agent-Signature", agentRequestSignature(a.cfg.AgentGPTSigningSecret, method, u, body, strconv.FormatInt(time.Now().Unix(), 10), nonce))
	}
	client := &http.Client{Timeout: 35 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("agent-gpt request failed: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4<<20+1))
	if err != nil {
		return err
	}
	if len(data) > 4<<20 {
		return fmt.Errorf("agent-gpt response exceeds limit")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Error json.RawMessage `json:"error"`
			Code  string          `json:"code"`
		}
		message := ""
		if json.Unmarshal(data, &failure) == nil {
			if json.Unmarshal(failure.Error, &message) != nil {
				var nested struct {
					Message string `json:"message"`
				}
				_ = json.Unmarshal(failure.Error, &nested)
				message = nested.Message
			}
		}
		for _, secret := range []string{a.cfg.AgentGPTAPIKey, a.cfg.AgentGPTSigningSecret, a.cfg.SessionSecret} {
			if secret != "" {
				message = strings.ReplaceAll(message, secret, "[redacted]")
			}
		}
		if len(message) > 400 {
			message = message[:400]
		}
		return &writingRemoteError{Status: response.StatusCode, Method: method, Path: u.Path, Message: message, Code: failure.Code}
	}
	if output != nil && len(data) > 0 {
		return json.Unmarshal(data, output)
	}
	return nil
}

func (a *App) writingSecret(taskID, purpose string) string {
	mac := hmac.New(sha256.New, []byte(a.cfg.SessionSecret))
	mac.Write([]byte("koinote-writing-agent-v1\n" + purpose + "\n" + taskID))
	return hex.EncodeToString(mac.Sum(nil))
}

func (a *App) writingPublicURL() string {
	if a.cfg.AgentGPTPublicURL != "" {
		return a.cfg.AgentGPTPublicURL
	}
	return strings.TrimRight(a.cfg.AppURL, "/")
}

func (a *App) writingEnabled() bool {
	return a.cfg.AgentGPTAPIKey != "" && a.cfg.AgentGPTAppID != "" && a.cfg.SessionSecret != ""
}
