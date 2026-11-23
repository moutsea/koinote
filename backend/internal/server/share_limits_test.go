package server

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/config"
)

func TestShareAdmissionBeforeDatabase(t *testing.T) {
	token := strings.Repeat("a", 32)
	paths := []struct{ method, path string }{
		{"GET", "/api/share/" + token}, {"HEAD", "/api/share/" + token},
		{"GET", "/api/share/" + token + "/meta"}, {"POST", "/api/share/" + token + "/verify"},
	}
	for _, scope := range []string{"global", "ip"} {
		t.Run(scope, func(t *testing.T) {
			a := newTestApp(config.Config{InternalToken: "trusted-worker"}) // nil database
			key, limit := "share-read:global", shareReadGlobalLimit
			if scope == "ip" {
				key, limit = "share-read:ip:192.0.2.1", shareReadIPLimit
			}
			a.rateLimit().entries[key] = &rateEntry{count: limit, expiresAt: time.Now().Add(time.Minute)}
			for _, path := range paths {
				r := httptest.NewRequest(path.method, path.path, strings.NewReader(`{"password":"test"}`))
				r.RemoteAddr = "192.0.2.1:1234"
				r.Header.Set("X-Forwarded-For", "198.51.100.20") // untrusted headers cannot escape an IP bucket
				w := httptest.NewRecorder()
				a.Routes().ServeHTTP(w, r)
				if w.Code != 429 || w.Header().Get("Retry-After") != "60" || w.Header().Get("Cache-Control") != "private, no-store" {
					t.Fatalf("%s %s: %d %s", path.method, path.path, w.Code, w.Body.String())
				}
			}
		})
	}
	for _, invalid := range []string{"bad-token", strings.Repeat("a", 33), strings.Repeat("G", 32)} {
		a := newTestApp(config.Config{})
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/api/share/"+invalid+"/meta", nil))
		if w.Code != 404 {
			t.Fatalf("invalid token status=%d", w.Code)
		}
	}
}

func TestShareGlobalBudgetBoundsIPBuckets(t *testing.T) {
	a := newTestApp(config.Config{})
	a.rateLimit().entries["share-read:global"] = &rateEntry{count: shareReadGlobalLimit, expiresAt: time.Now().Add(time.Minute)}
	for i := 0; i < 100; i++ {
		r := httptest.NewRequest("GET", "/api/share/"+strings.Repeat("b", 32), nil)
		r.RemoteAddr = fmt.Sprintf("192.0.2.%d:1234", i)
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, r)
		if w.Code != 429 {
			t.Fatal(w.Code)
		}
	}
	if len(a.rateLimit().entries) != 1 {
		t.Fatal("rejected traffic grew the limiter map")
	}
}

func TestShareDeniedIPCannotExhaustGlobalBudget(t *testing.T) {
	a := newTestApp(config.Config{})
	a.rateLimit().entries["share-read:ip:192.0.2.1"] = &rateEntry{count: shareReadIPLimit, expiresAt: time.Now().Add(time.Minute)}
	routes := a.Routes()
	for i := 0; i < shareReadGlobalLimit; i++ {
		r := httptest.NewRequest("GET", "/api/share/"+strings.Repeat("a", 32), nil)
		r.RemoteAddr = "192.0.2.1:1234"
		w := httptest.NewRecorder()
		routes.ServeHTTP(w, r)
		if w.Code != 429 {
			t.Fatal(w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "192.0.2.2:1234"
	r.SetPathValue("token", strings.Repeat("a", 32))
	_, finish, ok := a.beginShareRead(httptest.NewRecorder(), r)
	if !ok {
		t.Fatal("a blocked source consumed other readers' global budget")
	}
	finish()
}

func TestShareConcurrencyAdmissionAndRelease(t *testing.T) {
	a := newTestApp(config.Config{})
	for cycle := 0; cycle < 2; cycle++ {
		var releases []func()
		for i := 0; i < shareReadConcurrency; i++ {
			r := httptest.NewRequest("GET", "/", nil)
			r.SetPathValue("token", strings.Repeat("c", 32))
			bounded, release, ok := a.beginShareRead(httptest.NewRecorder(), r)
			if !ok {
				t.Fatal("healthy read denied")
			}
			if deadline, ok := bounded.Context().Deadline(); !ok || time.Until(deadline) > shareReadTimeout {
				t.Fatal("share read has no bounded deadline")
			}
			releases = append(releases, release)
		}
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/api/share/"+strings.Repeat("c", 32), nil))
		if w.Code != 429 || w.Header().Get("Retry-After") != "1" {
			t.Fatalf("excess concurrent read reached database: %d", w.Code)
		}
		for _, release := range releases {
			release()
		}
	}
}

func TestShareReadSkipsContendedViewCounter(t *testing.T) {
	a, pool, _, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "share-lock-test"})
	token := strings.Repeat("d", 32)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE documents SET share_token=$1 WHERE doc_id=$2`, token, doc.DocID); err != nil {
		t.Fatal(err)
	}
	lock, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(ctx)
	if _, err := lock.Exec(ctx, `SELECT id FROM documents WHERE doc_id=$1 FOR UPDATE`, doc.DocID); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/api/share/"+token, nil)
	readCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	w := httptest.NewRecorder()
	a.Routes().ServeHTTP(w, r.WithContext(readCtx))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"viewCount":0`) {
		t.Fatalf("view counter blocked a readable document: %d %s", w.Code, w.Body.String())
	}
	if _, err := pool.Exec(ctx, `SELECT 1`); err != nil {
		t.Fatal("share work occupied the remaining pool", err)
	}
	if err := lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	head := httptest.NewRecorder()
	a.Routes().ServeHTTP(head, httptest.NewRequest("HEAD", "/api/share/"+token, nil))
	w = httptest.NewRecorder()
	a.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/api/share/"+token, nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"viewCount":1`) {
		t.Fatalf("HEAD counted as a view or normal counting failed: %s", w.Body.String())
	}
}

func TestShareDatabaseWaitHonorsRequestDeadline(t *testing.T) {
	pool, _ := newCreditTestUser(t)
	cfg := pool.Config()
	cfg.MaxConns = 1
	limited, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer limited.Close()
	a := New(config.Config{}, limited)
	held, err := limited.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	request := httptest.NewRequest("GET", "/api/share/"+strings.Repeat("f", 32)+"/meta", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	a.Routes().ServeHTTP(w, request)
	if w.Code != 503 || len(a.shareReadSlots) != 0 || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("database wait did not release admission: %d %s", w.Code, w.Body.String())
	}
	held.Release()
	w = httptest.NewRecorder()
	a.Routes().ServeHTTP(w, httptest.NewRequest("GET", request.URL.String(), nil))
	if w.Code != 404 {
		t.Fatalf("healthy retry failed: %d", w.Code)
	}
}

func TestSharePasswordSlowBodyHasReadDeadline(t *testing.T) {
	server := httptest.NewServer(newTestApp(config.Config{}).Routes())
	defer server.Close()
	conn, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(shareReadTimeout + 2*time.Second))
	_, err = fmt.Fprintf(conn, "POST /api/share/%s/verify HTTP/1.1\r\nHost: test\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n1\r\n{\r\n", strings.Repeat("e", 32))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal("slow body kept a share slot indefinitely:", err)
	}
	defer response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatal(response.StatusCode)
	}
}
