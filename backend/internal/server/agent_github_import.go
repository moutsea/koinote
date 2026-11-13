package server

import (
	"archive/zip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

const (
	githubAPIBaseURL            = "https://api.github.com"
	githubCodeLoadHost          = "codeload.github.com"
	githubRequestTimeout        = 45 * time.Second
	githubImportBodyReadTimeout = 30 * time.Second
	githubResponseMaxBytes      = 2 << 20
	githubArchiveMaxBytes       = 128 << 20
	githubImportMaxFiles        = 5000
	githubImportMaxBytes        = 64 << 20
)

var (
	errAgentGitHubCredentialRequired = errors.New("a GitHub token is required for this repository")
	errAgentGitHubCredentialInvalid  = errors.New("GitHub token is invalid")
	errAgentGitHubCredentialCrypto   = errors.New("GitHub token encryption is unavailable")
	errAgentGitHubAlreadyCollected   = errors.New("this GitHub repository is already collected")
	errAgentGitHubRepositoryInvalid  = errors.New("GitHub repository URL is invalid")
	errAgentGitHubRepositoryMissing  = errors.New("GitHub repository is unavailable or requires a valid token")
	errAgentGitHubArchiveInvalid     = errors.New("GitHub repository archive is invalid")
	githubRepositorySegmentPattern   = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
)

type agentGitHubCredentialView struct {
	Configured bool      `json:"configured"`
	TokenHint  string    `json:"tokenHint,omitempty"`
	UpdatedAt  time.Time `json:"updatedAt,omitempty"`
}

type agentGitHubImportInput struct {
	RepositoryURL string `json:"repositoryUrl"`
	Ref           string `json:"ref,omitempty"`
	Name          string `json:"name,omitempty"`
	Description   string `json:"description,omitempty"`
	RequestID     string `json:"requestId"`
	LinkOnly      bool   `json:"linkOnly,omitempty"`
}

type agentGitHubSource struct {
	RepositoryID  int64  `json:"repositoryId,omitempty"`
	RepositoryURL string `json:"repositoryUrl"`
	Author        string `json:"author"`
	AuthorURL     string `json:"authorUrl"`
	Ref           string `json:"ref"`
	CommitSHA     string `json:"commitSha"`
	License       string `json:"license"`
	Private       bool   `json:"private,omitempty"`
	LinkOnly      bool   `json:"linkOnly,omitempty"`
	// UpstreamStatus records a permanent upstream state discovered by a refresh
	// (archived, disabled, unavailable, private). It never changes the snapshot
	// bytes; a later successful refresh clears it.
	UpstreamStatus string `json:"upstreamStatus,omitempty"`
}

type githubRepositoryMetadata struct {
	ID            int64  `json:"id"`
	Stars         int    `json:"stargazers_count"`
	Fork          bool   `json:"fork"`
	Archived      bool   `json:"archived"`
	Disabled      bool   `json:"disabled"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	Description   string `json:"description"`
	DefaultBranch string `json:"default_branch"`
	Private       bool   `json:"private"`
	Owner         struct {
		Login string `json:"login"`
	} `json:"owner"`
	License *struct {
		SPDXID string `json:"spdx_id"`
	} `json:"license"`
}

type plainGitHubRepositoryMetadata githubRepositoryMetadata

// UnmarshalJSON reads a repository as public only when "private" is explicitly
// false and "visibility", if present, is exactly "public". A missing or null
// "private", or any other visibility (internal, private, null or unknown),
// reads as private, so system import, sync and discovery never publish it.
// When "visibility" is absent, "private" alone decides.
func (m *githubRepositoryMetadata) UnmarshalJSON(data []byte) error {
	var decoded struct {
		plainGitHubRepositoryMetadata
		Private    *bool           `json:"private"`
		Visibility json.RawMessage `json:"visibility"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*m = githubRepositoryMetadata(decoded.plainGitHubRepositoryMetadata)
	public := decoded.Private != nil && !*decoded.Private
	if public && decoded.Visibility != nil {
		var visibility *string
		public = json.Unmarshal(decoded.Visibility, &visibility) == nil && visibility != nil && *visibility == "public"
	}
	m.Private = !public
	return nil
}

func (a *App) githubCredentialCipher() (cipher.AEAD, error) {
	// Domain-separated key derivation reuses the deployed encryption root,
	// never the MCP ciphertext format or token identifier.
	secret := strings.TrimSpace(a.cfg.MCPTokenEncryptionKey)
	if secret == "" && !a.cfg.IsProduction() {
		secret = a.cfg.SessionSecret
	}
	if secret == "" {
		return nil, errAgentGitHubCredentialCrypto
	}
	key := sha256.Sum256([]byte("koinote:github-credential:v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (a *App) encryptGitHubToken(userID int, token string) ([]byte, error) {
	aead, err := a.githubCredentialCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	aad := []byte(fmt.Sprintf("%d:github-token", userID))
	return aead.Seal(nonce, nonce, []byte(token), aad), nil
}

func (a *App) decryptGitHubToken(userID int, ciphertext []byte) (string, error) {
	aead, err := a.githubCredentialCipher()
	if err != nil {
		return "", err
	}
	if len(ciphertext) < aead.NonceSize() {
		return "", errAgentGitHubCredentialCrypto
	}
	nonce, payload := ciphertext[:aead.NonceSize()], ciphertext[aead.NonceSize():]
	plaintext, err := aead.Open(nil, nonce, payload, []byte(fmt.Sprintf("%d:github-token", userID)))
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func validateGitHubToken(token string) (string, string, error) {
	if strings.ContainsAny(token, "\r\n\t") {
		return "", "", errAgentGitHubCredentialInvalid
	}
	token = strings.TrimSpace(token)
	if len(token) < 12 || len(token) > 512 || !utf8.ValidString(token) {
		return "", "", errAgentGitHubCredentialInvalid
	}
	for _, character := range token {
		if character < 0x21 || character == 0x7f || character > 0x7e {
			return "", "", errAgentGitHubCredentialInvalid
		}
	}
	runes := []rune(token)
	hint := string(runes)
	if len(runes) > 4 {
		hint = string(runes[len(runes)-4:])
	}
	return token, hint, nil
}

func (a *App) loadGitHubToken(ctx context.Context, userID int) (string, error) {
	var ciphertext []byte
	err := a.db.QueryRow(ctx, `SELECT token_ciphertext FROM agent_github_credentials WHERE user_id = $1`, userID).Scan(&ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	token, err := a.decryptGitHubToken(userID, ciphertext)
	if err != nil {
		return "", errors.Join(errAgentGitHubCredentialCrypto, err)
	}
	return token, nil
}

func (a *App) agentGitHubCredentialGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var view agentGitHubCredentialView
	err := a.db.QueryRow(r.Context(), `
		SELECT true, token_hint, updated_at FROM agent_github_credentials WHERE user_id = $1
	`, user.ID).Scan(&view.Configured, &view.TokenHint, &view.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		view.Configured = false
	} else if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"credential": view})
}

func (a *App) agentGitHubCredentialPut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow(fmt.Sprintf("agent-github-credential:%d", user.ID), 20, time.Minute) {
		tooManyAttempts(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if !user.IsAdmin && user.MembershipTier != membershipTierLifetime {
		httpx.ErrorCode(w, http.StatusForbidden, "membership_required", "Lifetime membership is required")
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "token is required")
		return
	}
	token, hint, err := validateGitHubToken(input.Token)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	ciphertext, err := a.encryptGitHubToken(user.ID, token)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	_, err = a.db.Exec(r.Context(), `
		INSERT INTO agent_github_credentials (user_id, token_ciphertext, token_hint)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET token_ciphertext = EXCLUDED.token_ciphertext,
			token_hint = EXCLUDED.token_hint, updated_at = now()
	`, user.ID, ciphertext, hint)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"credential": agentGitHubCredentialView{Configured: true, TokenHint: hint, UpdatedAt: time.Now().UTC()}})
}

func (a *App) agentGitHubCredentialDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if _, err := a.db.Exec(r.Context(), `DELETE FROM agent_github_credentials WHERE user_id = $1`, user.ID); err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func parseGitHubRepositoryURL(raw string) (string, string, string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if len(raw) > 500 || err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || (strings.ToLower(parsed.Hostname()) != "github.com" && strings.ToLower(parsed.Hostname()) != "www.github.com") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", "", errAgentGitHubRepositoryInvalid
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 2 || len(parts) > 2 && parts[2] != "tree" {
		return "", "", "", errAgentGitHubRepositoryInvalid
	}
	owner, repo := parts[0], strings.TrimSuffix(parts[1], ".git")
	if !githubRepositorySegmentPattern.MatchString(owner) || !githubRepositorySegmentPattern.MatchString(repo) || owner == "." || owner == ".." || repo == "." || repo == ".." {
		return "", "", "", errAgentGitHubRepositoryInvalid
	}
	ref := ""
	if len(parts) > 2 {
		if len(parts) == 3 || parts[3] == "" {
			return "", "", "", errAgentGitHubRepositoryInvalid
		}
		ref = strings.Join(parts[3:], "/")
	}
	if err := validateGitHubRef(ref); err != nil {
		return "", "", "", errAgentGitHubRepositoryInvalid
	}
	return owner, repo, ref, nil
}

func validateGitHubRef(ref string) error {
	if !utf8.ValidString(ref) || len([]rune(ref)) > 200 || strings.ContainsAny(ref, "\\~^:?*[") || strings.Contains(ref, "..") || strings.Contains(ref, "@{") {
		return errAgentGitHubRepositoryInvalid
	}
	for _, character := range ref {
		if unicode.IsControl(character) || unicode.IsSpace(character) {
			return errAgentGitHubRepositoryInvalid
		}
	}
	if ref != "" {
		for _, part := range strings.Split(ref, "/") {
			if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, ".lock") {
				return errAgentGitHubRepositoryInvalid
			}
		}
	}
	return nil
}

func (a *App) githubRequest(ctx context.Context, endpoint, token string, accept string) (*http.Response, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errAgentGitHubRepositoryInvalid
	}
	if parsed.Host != "api.github.com" {
		// Public archives bypass the REST API's shared anonymous quota. Only an
		// unsigned URL pinned to a full SHA is allowed, and it never receives a
		// credential or follows a redirect to a signed/private download URL.
		parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
		if parsed.Host != githubCodeLoadHost || token != "" || parsed.RawQuery != "" || parsed.ForceQuery || len(parts) != 4 ||
			!githubRepositorySegmentPattern.MatchString(parts[0]) || parts[0] == "." || parts[0] == ".." ||
			!githubRepositorySegmentPattern.MatchString(parts[1]) || parts[1] == "." || parts[1] == ".." ||
			parts[2] != "zip" || !githubCommitPattern.MatchString(parts[3]) {
			return nil, errAgentGitHubRepositoryInvalid
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "Koinote-Agent-Repository")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := http.Client{}
	if a.githubHTTPClient != nil {
		client = *a.githubHTTPClient
	}
	client.Jar = nil
	client.Timeout = githubRequestTimeout
	client.CheckRedirect = func(request *http.Request, previous []*http.Request) error {
		if len(previous) > 3 || request.URL.Scheme != "https" || request.URL.User != nil || request.URL.Fragment != "" {
			return errors.New("unexpected GitHub redirect")
		}
		last := previous[len(previous)-1]
		request.Header.Del("Cookie")
		if request.URL.Host == "api.github.com" && last.URL.Host == "api.github.com" {
			return nil // GitHub redirects renamed repositories to their canonical API URL.
		}
		if request.URL.Host == githubCodeLoadHost && last.URL.Host == "api.github.com" && strings.Contains(last.URL.Path, "/zipball/") {
			request.Header.Del("Authorization")
			return nil
		}
		return errors.New("unexpected GitHub redirect")
	}
	return client.Do(req)
}

var (
	errAgentGitHubRateLimited     = errors.New("GitHub rate limit reached; try again later")
	errAgentGitHubTransient       = errors.New("GitHub API is temporarily unavailable; try again later")
	errAgentGitHubRequestInvalid  = errors.New("GitHub rejected the repository request")
	errAgentGitHubResponseInvalid = errors.New("GitHub returned an invalid response")
	errAgentGitHubAccessDenied    = errors.New("the GitHub token cannot access this repository; check its repository permissions")
	errAgentGitHubDownloadFailed  = errors.New("GitHub repository download failed; try again")
	errAgentGitHubImportBusy      = errors.New("GitHub imports are busy; try again later")
	errAgentGitHubLicense         = errors.New("choose a supported license or retain the original GitHub license")
	githubCommitPattern           = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
	githubLicensePattern          = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+-]{0,99}$`)
)

type githubRequestStage uint8

const (
	githubRequestMetadata githubRequestStage = iota
	githubRequestCommit
	githubRequestArchive
	githubRequestSearch
)

func githubResponseError(response *http.Response, stage githubRequestStage) error {
	if response.StatusCode == http.StatusTooManyRequests || (response.StatusCode == http.StatusForbidden && (response.Header.Get("X-RateLimit-Remaining") == "0" || response.Header.Get("Retry-After") != "")) {
		return errAgentGitHubRateLimited
	}
	if response.StatusCode == http.StatusUnauthorized {
		return errAgentGitHubCredentialRequired
	}
	if response.StatusCode == http.StatusForbidden {
		// A valid token can lack access to just one repository. Batch jobs must
		// continue past that repository rather than treating the token as expired.
		return errAgentGitHubAccessDenied
	}
	// Request timeouts and upstream gateway/server faults say nothing about this
	// repository, so keep them retryable rather than treating them as deleted.
	if response.StatusCode == http.StatusRequestTimeout || response.StatusCode >= http.StatusInternalServerError {
		return errAgentGitHubTransient
	}
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone || response.StatusCode == http.StatusUnavailableForLegalReasons {
		switch stage {
		case githubRequestMetadata:
			// A missing repository metadata endpoint is the only 404/410 that
			// proves the recorded repository is no longer available. A 451 (for
			// example a DMCA takedown) is the same permanent state.
			return errAgentGitHubRepositoryMissing
		case githubRequestArchive:
			// The repository was already resolved successfully; a missing archive
			// endpoint is an upstream download failure, not a deleted repository.
			return errAgentGitHubDownloadFailed
		case githubRequestSearch:
			// A search endpoint failure describes GitHub's search service, not a
			// candidate repository. Keep it on the retryable upstream path.
			return errAgentGitHubTransient
		default:
			// A branch/tag/commit can disappear while the repository remains.
			return errAgentGitHubRequestInvalid
		}
	}
	// Any non-4xx status left over here is an invalid upstream protocol response
	// (for example 204, 206, 304 or an unexpected redirect), not a caller error.
	if response.StatusCode < http.StatusBadRequest {
		return errAgentGitHubResponseInvalid
	}
	// Other 4xx responses are rejected requests (for example an invalid ref),
	// not evidence that the repository disappeared.
	return errAgentGitHubRequestInvalid
}

func (a *App) githubRead(ctx context.Context, endpoint, token string, accept string, stage githubRequestStage) ([]byte, error) {
	response, err := a.githubRequest(ctx, endpoint, token, accept)
	if err != nil {
		if errors.Is(err, errAgentGitHubRepositoryInvalid) {
			return nil, err
		}
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, errAgentGitHubTransient
			}
			return nil, ctx.Err()
		}
		// Never surface the transport error itself: a redirected URL can carry a
		// signed token. A dropped connection is retryable, unlike a 404.
		return nil, errAgentGitHubTransient
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, githubResponseError(response, stage)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, githubResponseMaxBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, errAgentGitHubTransient
			}
			return nil, ctx.Err()
		}
		return nil, errAgentGitHubTransient
	}
	if len(data) > githubResponseMaxBytes {
		return nil, errAgentGitHubResponseInvalid
	}
	return data, nil
}

func (a *App) fetchGitHubRepository(ctx context.Context, owner, repo, requestedRef, token string, publicOnly bool) (githubRepositoryMetadata, []agentWorkspaceFile, *agentGitHubSource, error) {
	metadata, files, source, err := a.fetchGitHubRepositoryWithToken(ctx, owner, repo, requestedRef, token, publicOnly)
	if token != "" && (errors.Is(err, errAgentGitHubCredentialRequired) || errors.Is(err, errAgentGitHubAccessDenied)) {
		publicMetadata, publicFiles, publicSource, publicErr := a.fetchGitHubRepositoryWithToken(ctx, owner, repo, requestedRef, "", publicOnly)
		if publicErr == nil {
			return publicMetadata, publicFiles, publicSource, nil
		}
		// Preserve actionable credential guidance for private repositories.
		if !errors.Is(publicErr, errAgentGitHubRepositoryMissing) && !errors.Is(publicErr, errAgentGitHubCredentialRequired) && !errors.Is(publicErr, errAgentGitHubAccessDenied) {
			return publicMetadata, nil, nil, publicErr
		}
	}
	return metadata, files, source, err
}

func (a *App) fetchGitHubRepositoryWithToken(ctx context.Context, owner, repo, requestedRef, token string, publicOnly bool) (githubRepositoryMetadata, []agentWorkspaceFile, *agentGitHubSource, error) {
	metadata, source, err := a.resolveGitHubRepository(ctx, owner, repo, requestedRef, token, publicOnly)
	if err != nil {
		return metadata, nil, nil, err
	}
	archiveToken := token
	if publicOnly {
		// A catalog import must prove the pinned contents remain public even if
		// visibility changed after the authenticated metadata request.
		archiveToken = ""
	}
	files, err := a.downloadGitHubRepository(ctx, metadata.Owner.Login, metadata.Name, source.CommitSHA, archiveToken)
	return metadata, files, source, err
}

// Resolve separately so refreshes can inspect archived/disabled state and skip
// downloading an unchanged archive.
func (a *App) resolveGitHubRepository(ctx context.Context, owner, repo, requestedRef, token string, publicOnly bool) (githubRepositoryMetadata, *agentGitHubSource, error) {
	metadata, err := a.resolveGitHubRepositoryMetadata(ctx, owner, repo, token, publicOnly)
	if err != nil {
		return metadata, nil, err
	}
	source, err := a.resolveGitHubRepositoryCommit(ctx, metadata, requestedRef, token)
	return metadata, source, err
}

// Only the repository metadata request. Callers that must classify archived,
// disabled or private state before spending a commit or archive request use
// this, then resolve the commit themselves.
func (a *App) resolveGitHubRepositoryMetadata(ctx context.Context, owner, repo, token string, publicOnly bool) (githubRepositoryMetadata, error) {
	var metadata githubRepositoryMetadata
	data, err := a.githubRead(ctx, fmt.Sprintf("%s/repos/%s/%s", githubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo)), token, "application/vnd.github+json", githubRequestMetadata)
	if err != nil {
		return metadata, err
	}
	if json.Unmarshal(data, &metadata) != nil || metadata.ID <= 0 || !githubRepositorySegmentPattern.MatchString(metadata.Owner.Login) || !githubRepositorySegmentPattern.MatchString(metadata.Name) || metadata.Owner.Login == "." || metadata.Owner.Login == ".." || metadata.Name == "." || metadata.Name == ".." || !strings.EqualFold(metadata.FullName, metadata.Owner.Login+"/"+metadata.Name) {
		return metadata, errAgentGitHubResponseInvalid
	}
	// Catalog entries must be public. Reject before resolving a commit or reading
	// archive contents, even when the caller's token can access them.
	if publicOnly && metadata.Private {
		return metadata, errAgentGitHubRepositoryInvalid
	}
	return metadata, nil
}

// Resolve the commit for the requested ref, defaulting to the current default
// branch. Attribution comes from the canonical API owner, never caller-supplied
// fields or the author of the most recent commit (who may only be a contributor).
func (a *App) resolveGitHubRepositoryCommit(ctx context.Context, metadata githubRepositoryMetadata, requestedRef, token string) (*agentGitHubSource, error) {
	owner, repo := metadata.Owner.Login, metadata.Name
	ref := requestedRef
	if ref == "" {
		ref = metadata.DefaultBranch
		if ref == "" || validateGitHubRef(ref) != nil {
			return nil, errAgentGitHubResponseInvalid
		}
	} else if validateGitHubRef(ref) != nil {
		return nil, errAgentGitHubRepositoryInvalid
	}
	apiURL := fmt.Sprintf("%s/repos/%s/%s", githubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo))
	data, err := a.githubRead(ctx, apiURL+"/commits/"+url.PathEscape(ref), token, "application/vnd.github.sha", githubRequestCommit)
	if err != nil {
		// Preserve the commit-stage classification for implicit and explicit
		// refs alike. A rejected commit request (including 400/422), or a ref
		// changing after metadata was fetched, does not prove the repo is gone.
		return nil, err
	}
	commit := strings.TrimSpace(string(data))
	if !githubCommitPattern.MatchString(commit) {
		return nil, errAgentGitHubResponseInvalid
	}
	license := "UNLICENSED"
	if metadata.License != nil && metadata.License.SPDXID != "NOASSERTION" && githubLicensePattern.MatchString(metadata.License.SPDXID) {
		license = metadata.License.SPDXID
	}
	return &agentGitHubSource{RepositoryID: metadata.ID, RepositoryURL: "https://github.com/" + owner + "/" + repo, Author: owner, AuthorURL: "https://github.com/" + owner, Ref: ref, CommitSHA: commit, License: license, Private: metadata.Private}, nil
}

func (a *App) downloadGitHubRepository(ctx context.Context, owner, repo, commit, token string) ([]agentWorkspaceFile, error) {
	var files []agentWorkspaceFile
	err := a.readGitHubRepositoryArchive(ctx, owner, repo, commit, token, func(reader io.ReaderAt, size int64) error {
		var err error
		files, err = readGitHubArchive(ctx, reader, size)
		return err
	})
	return files, err
}

// Share the bounded, pinned download without forcing Skill imports through the
// whole-repository content limits. Readers still validate every archive path.
func (a *App) readGitHubRepositoryArchive(ctx context.Context, owner, repo, commit, token string, readArchive func(io.ReaderAt, int64) error) error {
	apiURL := fmt.Sprintf("%s/repos/%s/%s", githubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo))
	// Download by resolved commit, so a moving branch cannot falsify provenance.
	endpoint := apiURL + "/zipball/" + commit
	accept := "application/vnd.github+json"
	if token == "" {
		endpoint = fmt.Sprintf("https://%s/%s/%s/zip/%s", githubCodeLoadHost, url.PathEscape(owner), url.PathEscape(repo), commit)
		accept = "application/zip"
	}
	response, err := a.githubRequest(ctx, endpoint, token, accept)
	if err != nil {
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return errAgentGitHubTransient
			}
			return ctx.Err()
		}
		// A dropped connection is retryable and says nothing about the repository.
		return errAgentGitHubTransient
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		err = githubResponseError(response, githubRequestArchive)
		if agentGitHubTokenRejected(err) && (token == "" || response.Request != nil && response.Request.URL.Host == githubCodeLoadHost) {
			// The archive host receives no Authorization header, including after
			// a private API download redirect. Its rejection cannot establish that
			// a saved token is invalid, nor trigger another anonymous resolution.
			err = errAgentGitHubDownloadFailed
		}
		return err
	}
	if response.ContentLength > githubArchiveMaxBytes {
		return errAgentGitHubArchiveInvalid
	}
	// Keep the compressed archive off the heap and private even for private repos.
	archiveFile, err := os.CreateTemp("", "koinote-github-*.zip")
	if err != nil {
		return err
	}
	defer func() { _ = archiveFile.Close(); _ = os.Remove(archiveFile.Name()) }()
	size, err := io.Copy(archiveFile, io.LimitReader(response.Body, githubArchiveMaxBytes+1))
	if size > githubArchiveMaxBytes {
		return errAgentGitHubArchiveInvalid
	}
	if err != nil {
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return errAgentGitHubTransient
			}
			return ctx.Err()
		}
		// Transport/local I/O failures are retryable. Treating them as malformed
		// archives would put otherwise eligible discovery candidates on cooldown.
		// Do not expose the raw error: redirected URLs may contain signed tokens.
		return errAgentGitHubDownloadFailed
	}
	return readArchive(archiveFile, size)
}

func githubArchiveContextError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return errAgentGitHubTransient
		}
		return err
	}
	return nil
}

// Read and validate archive metadata before opening any member. Both complete
// repository imports and Skill imports enforce the same path/type boundaries.
type githubArchiveMember struct {
	Path string
	File *zip.File
}

func githubArchiveMembers(ctx context.Context, reader io.ReaderAt, size int64) ([]githubArchiveMember, error) {
	if err := githubArchiveContextError(ctx); err != nil {
		return nil, err
	}
	archive, err := zip.NewReader(reader, size)
	if err != nil {
		if contextErr := githubArchiveContextError(ctx); contextErr != nil {
			return nil, contextErr
		}
		return nil, errAgentGitHubArchiveInvalid
	}
	if len(archive.File) > githubImportMaxFiles*2 {
		return nil, errAgentGitHubArchiveInvalid
	}
	members := make([]githubArchiveMember, 0, len(archive.File))
	paths := make(map[string]bool) // true for regular files, false for directories
	root := ""
	for _, entry := range archive.File {
		if err := githubArchiveContextError(ctx); err != nil {
			return nil, err
		}
		isDir := entry.FileInfo().IsDir()
		if !entry.Mode().IsRegular() && !isDir || strings.Contains(entry.Name, "\\") {
			return nil, errAgentGitHubArchiveInvalid
		}
		name := strings.TrimSuffix(entry.Name, "/")
		parts := strings.Split(name, "/")
		if parts[0] == "" || parts[0] == "." || parts[0] == ".." {
			return nil, errAgentGitHubArchiveInvalid
		}
		if root == "" {
			root = parts[0]
		} else if root != parts[0] {
			return nil, errAgentGitHubArchiveInvalid
		}
		if len(parts) == 1 {
			if isDir {
				continue
			}
			return nil, errAgentGitHubArchiveInvalid
		}
		relative := strings.Join(parts[1:], "/")
		clean, err := normalizeAgentWorkspacePath(relative)
		if err != nil || clean != relative {
			return nil, errAgentGitHubArchiveInvalid
		}
		if _, exists := paths[clean]; exists {
			return nil, errAgentGitHubArchiveInvalid
		}
		paths[clean] = !isDir
		if !isDir {
			members = append(members, githubArchiveMember{Path: clean, File: entry})
		}
	}
	for entry := range paths {
		parts := strings.Split(entry, "/")
		for i := 1; i < len(parts); i++ {
			if paths[strings.Join(parts[:i], "/")] {
				return nil, errAgentGitHubArchiveInvalid
			}
		}
	}
	if len(members) == 0 {
		return nil, errAgentGitHubArchiveInvalid
	}
	if err := githubArchiveContextError(ctx); err != nil {
		return nil, err
	}
	return members, nil
}

func readGitHubArchiveMember(ctx context.Context, member githubArchiveMember, limit int64) ([]byte, error) {
	if err := githubArchiveContextError(ctx); err != nil {
		return nil, err
	}
	if member.File.UncompressedSize64 > uint64(limit) {
		return nil, errAgentGitHubArchiveInvalid
	}
	stream, err := member.File.Open()
	if err != nil {
		return nil, errAgentGitHubArchiveInvalid
	}
	content, err := io.ReadAll(io.LimitReader(stream, limit+1))
	_ = stream.Close()
	if contextErr := githubArchiveContextError(ctx); contextErr != nil {
		return nil, contextErr
	}
	if err != nil || int64(len(content)) > limit || uint64(len(content)) != member.File.UncompressedSize64 {
		return nil, errAgentGitHubArchiveInvalid
	}
	return content, nil
}

func readGitHubArchive(ctx context.Context, reader io.ReaderAt, size int64) ([]agentWorkspaceFile, error) {
	members, err := githubArchiveMembers(ctx, reader, size)
	if err != nil {
		return nil, err
	}
	if len(members) > githubImportMaxFiles {
		return nil, errAgentGitHubArchiveInvalid
	}
	files := make([]agentWorkspaceFile, 0, len(members))
	totalBytes := 0
	for _, member := range members {
		if member.File.UncompressedSize64 > uint64(githubImportMaxBytes-totalBytes) {
			return nil, errAgentGitHubArchiveInvalid
		}
		content, err := readGitHubArchiveMember(ctx, member, agentWorkspaceMaxFileBytes)
		if err != nil {
			return nil, err
		}
		totalBytes += len(content)
		if agentWorkspaceSensitiveContent(content) {
			return nil, &agentWorkspaceSensitiveError{Path: member.Path}
		}
		digest := sha256.Sum256(content)
		mimeType := mime.TypeByExtension(filepath.Ext(member.Path))
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		files = append(files, agentWorkspaceFile{Path: member.Path, Content: content, MimeType: mimeType, SHA256: hex.EncodeToString(digest[:])})
	}
	if err := githubArchiveContextError(ctx); err != nil {
		return nil, err
	}
	return files, nil
}

func githubImportFingerprint(input agentGitHubImportInput) string {
	input.RequestID = ""
	data, _ := json.Marshal(input)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func completedGitHubImportForOwner(ctx context.Context, queries agentWorkspaceQuerier, ownerID *int, requestID, fingerprint string) (*agentWorkspaceView, error) {
	var id int64
	var previous string
	err := queries.QueryRow(ctx, `SELECT id,github_import_fingerprint FROM agent_workspaces WHERE user_id IS NOT DISTINCT FROM $1::integer AND github_import_request_id=$2::uuid AND deleted_at IS NULL`, ownerID, requestID).Scan(&id, &previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if previous != fingerprint {
		return nil, errAgentWorkspaceConflict
	}
	view, err := loadAgentWorkspaceForOwner(ctx, queries, ownerID, id)
	return &view, err
}

func (a *App) agentGitHubImportPost(w http.ResponseWriter, r *http.Request) {
	a.agentGitHubImport(w, r, false)
}

func (a *App) agentSystemGitHubImportPost(w http.ResponseWriter, r *http.Request) {
	a.agentGitHubImport(w, r, true)
}

// The import deadline covers both GitHub I/O and the final database transaction.
// Keep database/lock timeouts on the same retryable 503 path as upstream timeouts.
// Classify the returned error itself: deferred staging cleanup runs on a
// WithoutCancel context and can cross the deadline after a business error
// (quota/conflict/limit) has already been determined, and that error must not
// be rewritten into a retryable 503. pgx propagates context cancellation causes
// into the returned query/transaction error.
func writeAgentGitHubImportError(w http.ResponseWriter, err error) {
	if errors.Is(err, context.Canceled) {
		// The client disconnected; writing a response is no longer useful.
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		w.Header().Set("Retry-After", "30")
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "github_temporarily_unavailable", "GitHub import timed out; try again later")
		return
	}
	writeAgentWorkspaceError(w, err)
}

func (a *App) agentGitHubImport(w http.ResponseWriter, r *http.Request, system bool) {
	a.agentGitHubImportWithTimeouts(w, r, system, 2*githubRequestTimeout, githubImportBodyReadTimeout)
}

func (a *App) agentGitHubImportWithTimeouts(w http.ResponseWriter, r *http.Request, system bool, timeout, bodyReadTimeout time.Duration) {
	w.Header().Set("Cache-Control", "no-store")
	// Authentication, settings, body reads and idempotency queries share the
	// same budget as the subsequent GitHub calls and database transaction.
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	r = r.WithContext(ctx)
	controller := http.NewResponseController(w)
	readDeadline := time.Now().Add(bodyReadTimeout)
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(readDeadline) {
		readDeadline = deadline
	}
	_ = controller.SetReadDeadline(readDeadline)
	user, ok := a.requireUserWithErrorHandler(w, r, writeAgentGitHubImportError)
	if !ok {
		return
	}
	if system {
		if !user.IsAdmin {
			httpx.ErrorCode(w, http.StatusForbidden, "admin_required", "Administrator access required")
			return
		}
	} else {
		if user.MembershipTier != membershipTierLifetime {
			httpx.ErrorCode(w, http.StatusForbidden, "membership_required", "Lifetime membership is required")
			return
		}
		enabled, err := a.agentWorkspaceEnabled(ctx, user.ID)
		if err != nil {
			writeAgentGitHubImportError(w, err)
			return
		}
		if !enabled {
			writeAgentWorkspaceError(w, errAgentWorkspaceDisabled)
			return
		}
	}
	var ownerID *int
	if !system {
		ownerID = &user.ID
	}
	// Context cancellation alone does not interrupt a blocked socket Read.
	// The deadline is already active across auth/settings early returns; clear it
	// only after the full body has been consumed below.
	var input agentGitHubImportInput
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	decoder := json.NewDecoder(r.Body)
	decodeErr := decoder.Decode(&input)
	if decodeErr == nil {
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			decodeErr = err
			if decodeErr == nil {
				decodeErr = errors.New("request body must contain one JSON object")
			}
		}
	}
	if decodeErr != nil {
		// A socket read deadline returns a net.Error, and HTTP/1 may cancel the
		// request context as a side effect. Check the read error first so this
		// server-imposed timeout is not mistaken for a client disconnect.
		var networkErr net.Error
		if errors.Is(decodeErr, os.ErrDeadlineExceeded) || (errors.As(decodeErr, &networkErr) && networkErr.Timeout()) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			writeAgentGitHubImportError(w, context.DeadlineExceeded)
			return
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return
		}
		httpx.ErrorCode(w, 400, "bad_request", "repositoryUrl and a UUID v4 requestId are required")
		return
	}
	_ = controller.SetReadDeadline(time.Time{})
	if input.LinkOnly && !system {
		httpx.ErrorCode(w, 400, "bad_request", "Link collection is only available for the system directory")
		return
	}
	if !validUUID(input.RequestID) {
		httpx.ErrorCode(w, 400, "bad_request", "repositoryUrl and a UUID v4 requestId are required")
		return
	}
	input.RepositoryURL = strings.TrimSpace(input.RepositoryURL)
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.Ref = strings.TrimSpace(input.Ref)
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	owner, repo, ref, err := parseGitHubRepositoryURL(input.RepositoryURL)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	if input.Ref != "" {
		ref = input.Ref
	}
	if validateGitHubRef(ref) != nil {
		writeAgentWorkspaceError(w, errAgentGitHubRepositoryInvalid)
		return
	}
	fingerprint := githubImportFingerprint(input)
	existing, err := completedGitHubImportForOwner(ctx, a.db, ownerID, input.RequestID, fingerprint)
	if err != nil {
		writeAgentGitHubImportError(w, err)
		return
	}
	if existing != nil {
		httpx.JSON(w, 201, map[string]any{"workspace": existing})
		return
	}
	if !a.rateLimit().allow("agent-github-import:"+strconv.Itoa(user.ID), 5, time.Minute) {
		w.Header().Set("Retry-After", "60")
		tooManyAttempts(w)
		return
	}
	if !a.acquireGitHubImportSlot() {
		writeAgentWorkspaceError(w, errAgentGitHubImportBusy)
		return
	}
	defer a.releaseGitHubImportSlot()
	token := ""
	if !input.LinkOnly {
		token, err = a.loadGitHubToken(ctx, user.ID)
		if err != nil {
			writeAgentGitHubImportError(w, err)
			return
		}
	}
	var metadata githubRepositoryMetadata
	var source *agentGitHubSource
	var files []agentWorkspaceFile
	if input.LinkOnly {
		// Resolve publicly, without credentials, and never fetch repository bytes.
		metadata, source, err = a.resolveGitHubRepository(ctx, owner, repo, ref, "", true)
		if source != nil {
			source.LinkOnly = true
		}
	} else {
		metadata, files, source, err = a.fetchGitHubRepository(ctx, owner, repo, ref, token, system)
	}
	if err != nil {
		writeAgentGitHubImportError(w, err)
		return
	}
	name, description := input.Name, input.Description
	if name == "" && input.LinkOnly {
		name = string([]rune(metadata.FullName)[:min(80, utf8.RuneCountInString(metadata.FullName))])
	}
	if name == "" {
		name = string([]rune(metadata.Name)[:min(80, utf8.RuneCountInString(metadata.Name))])
	}
	if description == "" {
		description = string([]rune(metadata.Description)[:min(500, utf8.RuneCountInString(metadata.Description))])
	}
	view, err := a.importGitHubRepositoryForOwner(ctx, ownerID, user.ID, input.RequestID, fingerprint, name, description, files, source)
	if err != nil {
		writeAgentGitHubImportError(w, err)
		return
	}
	httpx.JSON(w, 201, map[string]any{"workspace": view})
}

func (a *App) importGitHubRepository(ctx context.Context, userID int, requestID, fingerprint, name, description string, files []agentWorkspaceFile, source *agentGitHubSource) (agentWorkspaceView, error) {
	return a.importGitHubRepositoryForOwner(ctx, &userID, userID, requestID, fingerprint, name, description, files, source)
}

func (a *App) importGitHubRepositoryForOwner(ctx context.Context, ownerID *int, actorID int, requestID, fingerprint, name, description string, files []agentWorkspaceFile, source *agentGitHubSource) (agentWorkspaceView, error) {
	var empty agentWorkspaceView
	if ownerID == nil && (source == nil || source.Private) {
		return empty, errAgentGitHubRepositoryInvalid
	}
	if source != nil && source.LinkOnly && (ownerID != nil || len(files) != 0) {
		return empty, errAgentGitHubRepositoryInvalid
	}
	name, description, err := validateAgentWorkspaceMetadata(name, description)
	if err != nil {
		return empty, err
	}
	// Retry an acknowledged import without creating any R2 objects.
	if existing, err := completedGitHubImportForOwner(ctx, a.db, ownerID, requestID, fingerprint); err != nil {
		return empty, err
	} else if existing != nil {
		return *existing, nil
	}
	staged, err := a.stageAgentRepositoryFilesForOwner(ctx, ownerID, files)
	if err != nil {
		return empty, err
	}
	defer a.expireAgentRepositoryStaging(ctx, staged)

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, agentRepositoryOwnerLock(ownerID)); err != nil {
		return empty, err
	}
	existing, err := completedGitHubImportForOwner(ctx, tx, ownerID, requestID, fingerprint)
	if err != nil {
		return empty, err
	}
	if existing != nil {
		return *existing, nil
	}
	if source.LinkOnly {
		known, err := systemRepositoryDiscoveryKnown(ctx, tx, source.RepositoryID, source.RepositoryURL, true)
		if err != nil {
			return empty, err
		}
		if known {
			return empty, errAgentGitHubAlreadyCollected
		}
	}
	previous, err := checkAgentRepositoryImportCapacity(ctx, tx, ownerID)
	if err != nil {
		return empty, err
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description,github_source,github_import_request_id,github_import_fingerprint,is_system) VALUES($1,$2,$3,$4,$5::uuid,$6,$1::integer IS NULL) RETURNING id`, ownerID, name, description, source, requestID, fingerprint).Scan(&id)
	if err != nil {
		return empty, err
	}
	for _, file := range files {
		if err := insertAgentRepositoryFile(ctx, tx, id, file, staged); err != nil {
			return empty, err
		}
	}

	if _, err = tx.Exec(ctx, `SELECT record_agent_workspace_commit($1,'import',NULL,$2)`, id, "Imported from GitHub: "+source.RepositoryURL+" @ "+source.CommitSHA); err != nil {
		return empty, err
	}
	if err = checkAgentRepositoryOwnerQuota(ctx, tx, ownerID, previous); err != nil {
		return empty, err
	}
	view, err := loadAgentWorkspaceForOwner(ctx, tx, ownerID, id)
	if err != nil {
		return empty, err
	}
	if err = recordAgentRepositorySystemEvent(ctx, tx, ownerID, actorID, id, "import", view.Revision); err != nil {
		return empty, err
	}
	if err = tx.Commit(ctx); err != nil {
		return empty, err
	}
	return view, nil
}
