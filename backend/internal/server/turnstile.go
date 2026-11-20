package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"koinote/backend/internal/httpx"
)

const (
	turnstileEmailAction = "email_verification"
	turnstileResetAction = "password_reset"
	turnstileVerifyURL   = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
)

// Production must fail closed even if both keys are accidentally removed.
// An entirely unconfigured development environment keeps its local mock flow.
func (a *App) emailHumanVerificationRequired() bool {
	return a.cfg.IsProduction() || a.cfg.TurnstileSiteKey != "" || a.cfg.TurnstileSecretKey != ""
}

func (a *App) authTurnstileConfig(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{
		"required": a.emailHumanVerificationRequired(),
		"siteKey":  a.cfg.TurnstileSiteKey,
	})
}

func (a *App) requireEmailHumanVerification(w http.ResponseWriter, r *http.Request, token, action string) bool {
	if !a.emailHumanVerificationRequired() {
		return true
	}
	unavailable := func() bool {
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "human_verification_unavailable", "Human verification is temporarily unavailable; please try again later")
		return false
	}
	failed := func() bool {
		httpx.ErrorCode(w, http.StatusForbidden, "human_verification_failed", "Please complete human verification again")
		return false
	}
	origin, err := url.Parse(a.cfg.AppURL)
	if err != nil || a.cfg.TurnstileSiteKey == "" || a.cfg.TurnstileSecretKey == "" || origin.Hostname() == "" {
		return unavailable()
	}
	hostname := strings.ToLower(origin.Hostname())
	if a.cfg.IsProduction() && (origin.Scheme != "https" || hostname == "localhost" || strings.HasSuffix(hostname, ".localhost") || net.ParseIP(hostname).IsLoopback()) {
		return unavailable()
	}
	if token == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "human_verification_required", "Refresh this page and complete human verification before requesting an email code")
		return false
	}
	if len(token) > 2048 {
		return failed()
	}
	form := url.Values{"secret": {a.cfg.TurnstileSecretKey}, "response": {token}}
	if ip := requestIP(r); net.ParseIP(ip) != nil {
		form.Set("remoteip", ip)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, turnstileVerifyURL, strings.NewReader(form.Encode()))
	if err != nil {
		return unavailable()
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := a.turnstileHTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(request)
	if err != nil {
		return unavailable()
	}
	defer response.Body.Close()
	var result struct {
		Success    bool     `json:"success"`
		Hostname   string   `json:"hostname"`
		Action     string   `json:"action"`
		ErrorCodes []string `json:"error-codes"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&result) != nil {
		return unavailable()
	}
	for _, code := range result.ErrorCodes {
		if code == "missing-input-secret" || code == "invalid-input-secret" || code == "internal-error" {
			return unavailable()
		}
	}
	if !result.Success || !strings.EqualFold(result.Hostname, hostname) || result.Action != action {
		return failed()
	}
	return true
}
