package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

type turnstileRoundTripFunc func(*http.Request) (*http.Response, error)

func (f turnstileRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func turnstileResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}
}

func turnstileTestConfig() config.Config {
	return config.Config{NodeEnv: "production", AppURL: "https://koinote.app", TurnstileSiteKey: "unit-test-site-key", TurnstileSecretKey: "unit-test-secret"}
}

func TestTurnstileRejectsBeforeIssuingEmailCodes(t *testing.T) {
	for _, action := range []string{turnstileEmailAction, turnstileResetAction} {
		t.Run(action, func(t *testing.T) {
			for _, test := range []struct {
				name, token, response string
				status, wantStatus    int
				providerError         error
			}{
				{name: "missing", wantStatus: 400},
				{name: "oversized", token: strings.Repeat("x", 2049), wantStatus: 403},
				{name: "invalid", token: "invalid", response: `{"success":false,"error-codes":["invalid-input-response"]}`, status: 200, wantStatus: 403},
				{name: "replayed", token: "used", response: `{"success":false,"error-codes":["timeout-or-duplicate"]}`, status: 200, wantStatus: 403},
				{name: "wrong-host", token: "token", response: `{"success":true,"hostname":"localhost","action":"` + action + `"}`, status: 200, wantStatus: 403},
				{name: "wrong-action", token: "token", response: `{"success":true,"hostname":"koinote.app","action":"login"}`, status: 200, wantStatus: 403},
				{name: "missing-host", token: "token", response: `{"success":true,"action":"` + action + `"}`, status: 200, wantStatus: 403},
				{name: "bad-secret", token: "token", response: `{"success":false,"error-codes":["invalid-input-secret"]}`, status: 200, wantStatus: 503},
				{name: "invalid-json", token: "token", response: `<html>Unavailable</html>`, status: 200, wantStatus: 503},
				{name: "upstream-error", token: "token", response: `{}`, status: 502, wantStatus: 503},
				{name: "timeout", token: "token", providerError: context.DeadlineExceeded, wantStatus: 503},
			} {
				t.Run(test.name, func(t *testing.T) {
					a := &App{cfg: turnstileTestConfig()}
					calls := 0
					a.turnstileHTTPClient = &http.Client{Transport: turnstileRoundTripFunc(func(r *http.Request) (*http.Response, error) {
						calls++
						if err := r.ParseForm(); err != nil {
							t.Fatal(err)
						}
						if r.Method != "POST" || r.URL.String() != turnstileVerifyURL || r.Form.Get("secret") != a.cfg.TurnstileSecretKey || r.Form.Get("response") != test.token {
							t.Fatal("incorrect Siteverify request")
						}
						if test.providerError != nil {
							return nil, test.providerError
						}
						return turnstileResponse(test.status, test.response), nil
					})}
					body, _ := json.Marshal(map[string]string{"email": "protected@example.test", "turnstileToken": test.token})
					request := httptest.NewRequest("POST", "/", strings.NewReader(string(body)))
					recorder := httptest.NewRecorder()
					// No database or sender exists: any fall-through would panic or issue mail.
					if action == turnstileEmailAction {
						a.authVerificationCode(recorder, request)
					} else {
						a.authPasswordResetCode(recorder, request)
					}
					if recorder.Code != test.wantStatus {
						t.Fatalf("HTTP %d: %s", recorder.Code, recorder.Body.String())
					}
					if (test.name == "missing" || test.name == "oversized") && calls != 0 {
						t.Fatal("invalid input contacted Siteverify")
					}
					if strings.Contains(recorder.Body.String(), a.cfg.TurnstileSecretKey) {
						t.Fatal("secret leaked into response")
					}
				})
			}
		})
	}
}

func TestTurnstileConfigurationAndDevelopment(t *testing.T) {
	for _, test := range []struct {
		name     string
		cfg      config.Config
		required bool
	}{
		{"local", config.Config{}, false},
		{"production-missing", config.Config{NodeEnv: "production"}, true},
		{"partial", config.Config{TurnstileSiteKey: "public"}, true},
		{"production-localhost", config.Config{NodeEnv: "production", AppURL: "https://localhost", TurnstileSiteKey: "public", TurnstileSecretKey: "private"}, true},
		{"production-loopback", config.Config{NodeEnv: "production", AppURL: "https://127.0.0.1", TurnstileSiteKey: "public", TurnstileSecretKey: "private"}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := &App{cfg: test.cfg}
			request := httptest.NewRequest("GET", "/api/auth/turnstile", nil)
			recorder := httptest.NewRecorder()
			a.authTurnstileConfig(recorder, request)
			var result struct {
				Required bool   `json:"required"`
				SiteKey  string `json:"siteKey"`
			}
			if json.Unmarshal(recorder.Body.Bytes(), &result) != nil || result.Required != test.required || result.SiteKey != test.cfg.TurnstileSiteKey || recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatal(recorder.Body.String())
			}
			if strings.Contains(recorder.Body.String(), "secret") || strings.Contains(recorder.Body.String(), "private") {
				t.Fatal("public configuration exposed a secret")
			}
			recorder = httptest.NewRecorder()
			passed := a.requireEmailHumanVerification(recorder, request, "unused", turnstileEmailAction)
			if test.required && (passed || recorder.Code != 503) {
				t.Fatal("missing/unsafe configuration must fail closed")
			}
			if !test.required && !passed {
				t.Fatal("unconfigured local development should retain its existing flow")
			}
		})
	}
}

func TestTurnstileAllowsOneEmailSendPerToken(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	suffix := itoa64(time.Now().UnixNano())
	email, resetEmail := "captcha-"+suffix+"@example.test", "captcha-reset-"+suffix+"@example.test"
	_, err := pool.Exec(ctx, `INSERT INTO users(auth_user_id,email,password_hash,is_verified) VALUES ($1,$2,'test-password-hash',true)`, "captcha-"+suffix, resetEmail)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE email=$1`, resetEmail)
		_, _ = pool.Exec(ctx, `DELETE FROM email_verification_codes WHERE email=$1`, email)
		_, _ = pool.Exec(ctx, `DELETE FROM email_verification_sends WHERE email=$1`, email)
		_, _ = pool.Exec(ctx, `DELETE FROM password_reset_codes WHERE email=$1`, resetEmail)
		_, _ = pool.Exec(ctx, `DELETE FROM password_reset_sends WHERE email_hash=$1`, (&App{cfg: config.Config{SessionSecret: "test"}}).passwordResetEmailHash(resetEmail))
	})
	cfg := turnstileTestConfig()
	cfg.NodeEnv, cfg.AppURL, cfg.EnableMockEmail, cfg.SessionSecret = "development", "http://localhost:5273", true, "test"
	a := New(cfg, pool)
	var calls atomic.Int32
	seen := map[string]bool{}
	a.turnstileHTTPClient = &http.Client{Transport: turnstileRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if err := r.ParseForm(); err != nil {
			return nil, err
		}
		token := r.Form.Get("response")
		if seen[token] {
			return turnstileResponse(200, `{"success":false,"error-codes":["timeout-or-duplicate"]}`), nil
		}
		seen[token] = true
		action := turnstileEmailAction
		if token == "password-token" {
			action = turnstileResetAction
		}
		return turnstileResponse(200, `{"success":true,"hostname":"localhost","action":"`+action+`"}`), nil
	})}
	for _, test := range []struct {
		email, token string
		handler      http.HandlerFunc
	}{
		{email, "email-token", a.authVerificationCode},
		{resetEmail, "password-token", a.authPasswordResetCode},
	} {
		body := `{"email":"` + test.email + `","turnstileToken":"` + test.token + `"}`
		first := postJSON(test.handler, body)
		if first.Code != 200 || !strings.Contains(first.Body.String(), "devCode") {
			t.Fatalf("first request: %d %s", first.Code, first.Body.String())
		}
		replay := postJSON(test.handler, body)
		if replay.Code != 403 || decodeErrorCode(t, replay) != "human_verification_failed" {
			t.Fatalf("replay: %d %s", replay.Code, replay.Body.String())
		}
	}
	var registrationSends, resetSends int
	if err = pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM email_verification_sends WHERE email=$1),(SELECT count(*) FROM password_reset_sends WHERE email_hash=$2)`, email, a.passwordResetEmailHash(resetEmail)).Scan(&registrationSends, &resetSends); err != nil || registrationSends != 1 || resetSends != 1 || calls.Load() != 4 {
		t.Fatalf("send accounting: registration=%d reset=%d calls=%d err=%v", registrationSends, resetSends, calls.Load(), err)
	}
}

func TestTurnstileTransportErrorDoesNotExposeCredentials(t *testing.T) {
	a := &App{cfg: turnstileTestConfig(), turnstileHTTPClient: &http.Client{Transport: turnstileRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("unit-test-secret internal diagnostic")
	})}}
	recorder := httptest.NewRecorder()
	if a.requireEmailHumanVerification(recorder, httptest.NewRequest("POST", "/", nil), "token", turnstileEmailAction) || recorder.Code != 503 || strings.Contains(recorder.Body.String(), "unit-test-secret") {
		t.Fatal(recorder.Body.String())
	}
}
