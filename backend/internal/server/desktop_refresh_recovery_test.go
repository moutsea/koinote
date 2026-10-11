package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/config"
)

func TestDesktopRefreshRecovery(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "desktop-recovery-test"}, pool)
	user := seedMCPUser(t, pool, app, "free")
	ctx := context.Background()
	newPair := func() desktopTokenResponse {
		t.Helper()
		pair, err := app.issueDesktopTokenPair(ctx, pool, user.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		return pair
	}
	attempt := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))
	other := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))
	alive := func(token string) bool {
		t.Helper()
		_, ok, err := app.desktopUserFromBearer(ctx, token)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	rotate := func(parent, key string) desktopTokenResponse {
		t.Helper()
		pair, err := app.rotateDesktopRefreshToken(ctx, parent, key)
		if err != nil {
			t.Fatal(err)
		}
		return pair
	}
	rejected := func(parent, key string) {
		t.Helper()
		_, err := app.rotateDesktopRefreshToken(ctx, parent, key)
		if !errors.Is(err, errDesktopTokenInvalid) {
			t.Fatalf("expected credential rejection, got %v", err)
		}
	}
	t.Run("old access grace never extends expiry and retry never resets grace", func(t *testing.T) {
		for _, ttl := range []time.Duration{15 * time.Minute, 20 * time.Second} {
			original := newPair()
			hash := sha256.Sum256([]byte(original.AccessToken))
			var before, capped, retried time.Time
			if err := pool.QueryRow(ctx, `UPDATE desktop_access_tokens SET expires_at=now()+$2::interval WHERE token_hash=$1 RETURNING expires_at`, hash[:], durationInterval(ttl)).Scan(&before); err != nil {
				t.Fatal(err)
			}
			next := rotate(original.RefreshToken, attempt)
			if err := pool.QueryRow(ctx, `SELECT expires_at FROM desktop_access_tokens WHERE token_hash=$1`, hash[:]).Scan(&capped); err != nil {
				t.Fatal(err)
			}
			if capped.After(before) || capped.After(time.Now().Add(desktopAccessRotationGrace)) || !alive(original.AccessToken) {
				t.Fatalf("incorrect access grace: before=%v capped=%v", before, capped)
			}
			if ttl < desktopAccessRotationGrace && !before.Equal(capped) {
				t.Fatal("shorter existing expiry changed")
			}
			rotate(original.RefreshToken, attempt)
			if err := pool.QueryRow(ctx, `SELECT expires_at FROM desktop_access_tokens WHERE token_hash=$1`, hash[:]).Scan(&retried); err != nil || !retried.Equal(capped) {
				t.Fatalf("retry renewed grace: %v", err)
			}
			if _, err := pool.Exec(ctx, `UPDATE desktop_access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hash[:]); err != nil {
				t.Fatal(err)
			}
			if alive(original.AccessToken) || !alive(next.AccessToken) {
				t.Fatal("expired grace accepted or new token rejected")
			}
		}
	})
	t.Run("lost response survives restart and never stores plaintext", func(t *testing.T) {
		original := newPair()
		next := rotate(original.RefreshToken, attempt)
		// Model a deployment: no application-memory cache survives.
		restarted := New(config.Config{SessionSecret: "another-cookie-key"}, pool)
		recovered, err := restarted.rotateDesktopRefreshToken(ctx, original.RefreshToken, attempt)
		if err != nil {
			t.Fatal(err)
		}
		if recovered.RefreshToken != next.RefreshToken || !alive(recovered.AccessToken) {
			t.Fatal("retry failed to recover the same successor")
		}
		if !alive(original.AccessToken) || !alive(next.AccessToken) {
			t.Fatal("normal rotation interrupted in-flight access")
		}
		parentHash := sha256.Sum256([]byte(original.RefreshToken))
		attemptHash := sha256.Sum256([]byte(attempt))
		childHash := sha256.Sum256([]byte(next.RefreshToken))
		var storedAttempt, storedChild []byte
		if err = pool.QueryRow(ctx, `SELECT refresh_request_hash,recovery_refresh_hash FROM desktop_refresh_tokens WHERE token_hash=$1`, parentHash[:]).Scan(&storedAttempt, &storedChild); err != nil {
			t.Fatal(err)
		}
		if string(storedAttempt) != string(attemptHash[:]) || string(storedChild) != string(childHash[:]) {
			t.Fatal("recovery must store hashes only")
		}
		// Recovery after an app restart beyond the access-token lifetime still works.
		if _, err = pool.Exec(ctx, `UPDATE desktop_access_tokens SET expires_at=now()-interval '1 minute' WHERE token_hash=$1`, hashToken(next.AccessToken)); err != nil {
			t.Fatal(err)
		}
		retry := rotate(original.RefreshToken, attempt)
		if retry.RefreshToken != next.RefreshToken || !alive(retry.AccessToken) {
			t.Fatal("recovery needs a fresh access token")
		}
	})
	t.Run("same attempt is safe under concurrency", func(t *testing.T) {
		cfg := pool.Config()
		cfg.MaxConns = 2
		limited, err := pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer limited.Close()
		limitedApp := New(config.Config{SessionSecret: "limited-test"}, limited)
		bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		original := newPair()
		pairs := make([]desktopTokenResponse, 6)
		errs := make([]error, 6)
		var wg sync.WaitGroup
		for i := range pairs {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				pairs[i], errs[i] = limitedApp.rotateDesktopRefreshToken(bounded, original.RefreshToken, attempt)
			}(i)
		}
		wg.Wait()
		for i, pair := range pairs {
			if errs[i] != nil {
				t.Fatal(errs[i])
			}
			if pair.RefreshToken != pairs[0].RefreshToken || !alive(pair.AccessToken) {
				t.Fatal("concurrent retry issued a different successor or revoked access")
			}
		}
	})
	t.Run("different or missing retry secret still revokes replayed family", func(t *testing.T) {
		for _, bad := range []string{"", other} {
			original := newPair()
			next := rotate(original.RefreshToken, attempt)
			rejected(original.RefreshToken, bad)
			if alive(next.AccessToken) || alive(original.AccessToken) {
				t.Fatal("replay protection lost")
			}
			rejected(original.RefreshToken, attempt)
		}
	})
	t.Run("late retry cannot revoke a newer generation", func(t *testing.T) {
		original := newPair()
		next := rotate(original.RefreshToken, attempt)
		newest := rotate(next.RefreshToken, other)
		rejected(original.RefreshToken, attempt)
		if !alive(newest.AccessToken) {
			t.Fatal("recognized old attempt revoked a healthy successor")
		}
	})
	t.Run("logout through old in-flight access revokes all successors", func(t *testing.T) {
		original := newPair()
		next := rotate(original.RefreshToken, attempt)
		if err := app.revokeDesktopSession(ctx, original.AccessToken); err != nil {
			t.Fatal(err)
		}
		if alive(next.AccessToken) {
			t.Fatal("logout left successor active")
		}
		rejected(original.RefreshToken, attempt)
		rejected(next.RefreshToken, other)
	})
	t.Run("password change and expiration cannot be recovered", func(t *testing.T) {
		original := newPair()
		rotate(original.RefreshToken, attempt)
		if _, err := pool.Exec(ctx, `UPDATE users SET session_version=session_version+1 WHERE id=$1`, user.ID); err != nil {
			t.Fatal(err)
		}
		rejected(original.RefreshToken, attempt)
		original = newPair()
		rotate(original.RefreshToken, attempt)
		if _, err := pool.Exec(ctx, `UPDATE desktop_refresh_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hashToken(original.RefreshToken)); err != nil {
			t.Fatal(err)
		}
		rejected(original.RefreshToken, attempt)
	})
	t.Run("HTTP contract supports new and legacy clients", func(t *testing.T) {
		original := newPair()
		handler := app.Routes()
		request := func(key string) *httptest.ResponseRecorder {
			body := `{"grantType":"refresh_token","clientId":"koinote-desktop","refreshToken":"` + original.RefreshToken + `","refreshRequestId":"` + key + `"}`
			req := httptest.NewRequest(http.MethodPost, "/api/auth/desktop/token", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			return rec
		}
		for i := 0; i < 2; i++ {
			rec := request(attempt)
			if rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("recovery status=%d", rec.Code)
			}
		}
		original = newPair()
		if rec := request("not-a-retry-secret"); rec.Code != 401 {
			t.Fatal(rec.Code)
		}
		if rec := request(""); rec.Code != 200 {
			t.Fatal("legacy client rejected", rec.Code)
		}
	})
}

func hashToken(token string) []byte { hash := sha256.Sum256([]byte(token)); return hash[:] }
