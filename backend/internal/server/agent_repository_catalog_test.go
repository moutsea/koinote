package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

// Opt-in release-data check: uses downloaded, pinned upstream archives, the
// production importer/publisher and a real disposable PostgreSQL database.
// No upstream code or skill instructions are executed.
func TestCuratedAgentRepositories(t *testing.T) {
	archiveDir := os.Getenv("KOINOTE_CATALOG_ARCHIVES")
	if archiveDir == "" {
		t.Skip("set KOINOTE_CATALOG_ARCHIVES to the reviewed archive directory")
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "data/agent-repositories/catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Repositories []struct {
			Name          string `json:"name"`
			CommitSHA     string `json:"commitSha"`
			RepositoryURL string `json:"repositoryUrl"`
			SizeBytes     int64  `json:"sizeBytes"`
		} `json:"repositories"`
	}
	if err = json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "catalog-release-test"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	recipient := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err = pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, owner.ID); err != nil {
		t.Fatal(err)
	}
	var totalBytes int64
	for _, item := range catalog.Repositories {
		totalBytes += item.SizeBytes
	}
	for _, user := range []model.User{owner, recipient} {
		userID := user.ID
		if _, err = pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, userID); err != nil {
			t.Fatal(err)
		}
		// The catalog owner receives system capacity from the seeding script.
		// An ordinary user who forks the catalog still uses their own quota.
		if userID == recipient.ID {
			if _, err = app.allocateAgentWorkspaceStorage(ctx, user, max(0, totalBytes-agentWorkspaceDefaultQuotaBytes)); err != nil {
				t.Fatal(err)
			}
		}
	}
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		for _, item := range catalog.Repositories {
			prefix := "/repos/" + item.Name
			if r.URL.Path != prefix && !strings.HasPrefix(r.URL.Path, prefix+"/") {
				continue
			}
			archiveName := filepath.Join(archiveDir, strings.ReplaceAll(item.Name, "/", "--"))
			var body io.ReadCloser
			switch r.URL.Path {
			case prefix:
				metadata, err := os.ReadFile(archiveName + ".json")
				if err != nil {
					return nil, err
				}
				var record struct {
					Metadata json.RawMessage `json:"metadata"`
				}
				if err = json.Unmarshal(metadata, &record); err != nil {
					return nil, err
				}
				body = io.NopCloser(strings.NewReader(string(record.Metadata)))
			case prefix + "/commits/" + item.CommitSHA:
				body = io.NopCloser(strings.NewReader(item.CommitSHA))
			case prefix + "/zipball/" + item.CommitSHA:
				file, err := os.Open(archiveName + ".zip")
				if err != nil {
					return nil, err
				}
				body = file
			default:
				return nil, fmt.Errorf("unexpected GitHub ref: %s", r.URL.Path)
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: body, Request: r}, nil
		}
		return nil, fmt.Errorf("unexpected GitHub repository: %s", r.URL.Path)
	})}
	// Exercise the real rate limiter at catalog scale without waiting minutes
	// per window: after a rejection, advance all limiter windows to the past.
	// Only this test's in-memory limiter is changed; production limits are intact.
	var rateLimited atomic.Int32
	routes := app.Routes()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		response := httptest.NewRecorder()
		routes.ServeHTTP(response, r)
		if response.Code == http.StatusTooManyRequests {
			rateLimited.Add(1)
			limiter := app.rateLimit()
			limiter.mu.Lock()
			for _, entry := range limiter.entries {
				entry.expiresAt = time.Now().Add(-time.Second)
			}
			limiter.mu.Unlock()
			response.Header().Set("Retry-After", "1")
		}
		for key, values := range response.Header() {
			w.Header()[key] = values
		}
		w.WriteHeader(response.Code)
		_, _ = io.Copy(w, response.Body)
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	cookiePath := filepath.Join(t.TempDir(), "session")
	if err = os.WriteFile(cookiePath, []byte(mcpSessionCookie(app, owner.AuthUserID).String()), 0600); err != nil {
		t.Fatal(err)
	}
	for run := range 2 {
		cmd := exec.Command("python3", filepath.Join(root, "scripts/seed_agent_repositories.py"), "--apply", "--base-url", server.URL, "--owner-email", owner.Email, "--cookie-file", cookiePath)
		cmd.Env = append(os.Environ(), "KOINOTE_DESKTOP_TOKEN=")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("catalog run %d: %v\n%s", run, err, output)
		}
		t.Logf("catalog run %d completed", run+1)
		storage, err := app.loadAgentWorkspaceStorage(ctx, pool, owner)
		if err != nil || storage.BonusBytes != totalBytes || storage.AllocatedBytes != 0 || storage.PersonalUsedBytes != 0 {
			t.Fatalf("catalog must be system-funded without repeat grants or personal allocation: %+v, %v", storage, err)
		}
	}
	var imports, publications int
	if err = pool.QueryRow(ctx, `SELECT count(*),count(p.workspace_id) FROM agent_workspaces w LEFT JOIN agent_repository_publications p ON p.workspace_id=w.id WHERE user_id=$1`, owner.ID).Scan(&imports, &publications); err != nil || imports != len(catalog.Repositories) || publications != imports {
		t.Fatalf("duplicate or missing catalog records: %d/%d, %v", imports, publications, err)
	}
	// The catalog spans multiple real directory pages. Check completeness, order
	// and provenance as an anonymous reader, including after the repeated seed.
	listed := 0
	next := "/api/agent/repositories"
	for next != "" {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", next, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("directory page: HTTP %d", response.Code)
		}
		var page struct {
			Repositories []agentRepositoryPublication `json:"repositories"`
			NextCursor   *string                      `json:"nextCursor"`
		}
		decodeJSONResponse(t, response, &page)
		if len(page.Repositories) == 0 {
			t.Fatal("unexpected empty catalog page")
		}
		for _, repository := range page.Repositories {
			if listed >= len(catalog.Repositories) || repository.GitHubSource == nil || repository.GitHubSource.RepositoryURL != catalog.Repositories[listed].RepositoryURL {
				t.Fatal("directory pagination lost catalog order, attribution or duplicated a repository")
			}
			listed++
		}
		next = ""
		if page.NextCursor != nil {
			next = "/api/agent/repositories?cursor=" + url.QueryEscape(*page.NextCursor)
		}
	}
	if listed != len(catalog.Repositories) {
		t.Fatalf("directory exposed %d/%d catalog repositories", listed, len(catalog.Repositories))
	}
	for _, item := range catalog.Repositories {
		t.Run(item.Name, func(t *testing.T) {
			var id int64
			if err := pool.QueryRow(ctx, `SELECT id FROM agent_workspaces WHERE user_id=$1 AND github_source->>'repositoryUrl'=$2`, owner.ID, item.RepositoryURL).Scan(&id); err != nil {
				t.Fatal(err)
			}
			publication, err := app.loadPublicAgentRepository(ctx, id, nil)
			if err != nil {
				t.Fatal(err)
			}
			if publication.StarCount != 0 || publication.CloneCount != 0 {
				t.Fatal("upstream stars must not become Koinote engagement")
			}
			for _, file := range publication.Files {
				url := fmt.Sprintf("/api/agent/repositories/%d/files/%d?revision=%d", id, file.FileID, publication.Revision)
				var response *httptest.ResponseRecorder
				for attempt := 0; attempt < 2; attempt++ {
					response = httptest.NewRecorder()
					handler.ServeHTTP(response, httptest.NewRequest("GET", url, nil))
					if response.Code != http.StatusTooManyRequests {
						break
					}
				}
				if response.Code != http.StatusOK {
					t.Fatalf("anonymous download: HTTP %d", response.Code)
				}
				var result struct {
					File agentWorkspaceFileContentView `json:"file"`
				}
				decodeJSONResponse(t, response, &result)
				content, err := base64.StdEncoding.DecodeString(result.File.ContentBase64)
				if err != nil {
					t.Fatal(err)
				}
				digest := sha256.Sum256(content)
				if hex.EncodeToString(digest[:]) != file.SHA256 {
					t.Fatalf("anonymous download corrupted: %s", file.Path)
				}
			}
			requestID, _ := randomUUID()
			fork, err := app.forkAgentRepository(ctx, recipient.ID, id, publication.Revision, requestID)
			if err != nil {
				t.Fatal(err)
			}
			if len(fork.Files) != len(publication.Files) || fork.GitHubSource.RepositoryURL != item.RepositoryURL || fork.GitHubSource.CommitSHA != item.CommitSHA {
				t.Fatal("Fork lost content or provenance")
			}
			t.Logf("%d anonymous files verified; Fork preserved origin", len(publication.Files))
		})
	}
	if len(catalog.Repositories) > 5 && rateLimited.Load() == 0 {
		t.Fatal("large catalog did not exercise rate limit recovery")
	}
	t.Logf("%d repositories verified; %d rate-limit windows recovered", len(catalog.Repositories), rateLimited.Load())
}
