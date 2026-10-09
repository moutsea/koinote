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
	githubAPIBaseURL       = "https://api.github.com"
	githubCodeLoadHost     = "codeload.github.com"
	githubRequestTimeout   = 45 * time.Second
	githubResponseMaxBytes = 2 << 20
	githubArchiveMaxBytes  = 128 << 20
	githubImportMaxFiles   = 2000
	githubImportMaxBytes   = 64 << 20
)

var (
	errAgentGitHubCredentialRequired = errors.New("a GitHub token is required for this repository")
	errAgentGitHubCredentialInvalid  = errors.New("GitHub token is invalid")
	errAgentGitHubCredentialCrypto   = errors.New("GitHub token encryption is unavailable")
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
}

type agentGitHubSource struct {
	RepositoryURL string `json:"repositoryUrl"`
	Author        string `json:"author"`
	AuthorURL     string `json:"authorUrl"`
	Ref           string `json:"ref"`
	CommitSHA     string `json:"commitSha"`
	License       string `json:"license"`
	Private       bool   `json:"private,omitempty"`
}

type githubRepositoryMetadata struct {
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
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow(fmt.Sprintf("agent-github-credential:%d", user.ID), 20, time.Minute) {
		tooManyAttempts(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
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
	if err != nil || parsed.Scheme != "https" || parsed.Host != "api.github.com" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errAgentGitHubRepositoryInvalid
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
	errAgentGitHubRateLimited = errors.New("GitHub rate limit reached; try again later")
	errAgentGitHubImportBusy  = errors.New("GitHub imports are busy; try again later")
	errAgentGitHubLicense     = errors.New("choose a supported license or retain the original GitHub license")
	githubCommitPattern       = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
	githubLicensePattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+-]{0,99}$`)
)

func githubResponseError(response *http.Response) error {
	if response.StatusCode == http.StatusTooManyRequests || (response.StatusCode == http.StatusForbidden && (response.Header.Get("X-RateLimit-Remaining") == "0" || response.Header.Get("Retry-After") != "")) {
		return errAgentGitHubRateLimited
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return errAgentGitHubCredentialRequired
	}
	return errAgentGitHubRepositoryMissing
}

func (a *App) githubRead(ctx context.Context, endpoint, token string, accept string) ([]byte, error) {
	response, err := a.githubRequest(ctx, endpoint, token, accept)
	if err != nil {
		return nil, errAgentGitHubRepositoryMissing
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, githubResponseError(response)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, githubResponseMaxBytes+1))
	if err != nil || len(data) > githubResponseMaxBytes {
		return nil, errAgentGitHubRepositoryMissing
	}
	return data, nil
}

func (a *App) fetchGitHubRepository(ctx context.Context, owner, repo, requestedRef, token string) (githubRepositoryMetadata, []agentWorkspaceFile, *agentGitHubSource, error) {
	metadata, files, source, err := a.fetchGitHubRepositoryWithToken(ctx, owner, repo, requestedRef, token)
	if token != "" && errors.Is(err, errAgentGitHubCredentialRequired) {
		publicMetadata, publicFiles, publicSource, publicErr := a.fetchGitHubRepositoryWithToken(ctx, owner, repo, requestedRef, "")
		if publicErr == nil {
			return publicMetadata, publicFiles, publicSource, nil
		}
		// Preserve actionable credential guidance for private repositories.
		if !errors.Is(publicErr, errAgentGitHubRepositoryMissing) && !errors.Is(publicErr, errAgentGitHubCredentialRequired) {
			return publicMetadata, nil, nil, publicErr
		}
	}
	return metadata, files, source, err
}

func (a *App) fetchGitHubRepositoryWithToken(ctx context.Context, owner, repo, requestedRef, token string) (githubRepositoryMetadata, []agentWorkspaceFile, *agentGitHubSource, error) {
	var metadata githubRepositoryMetadata
	data, err := a.githubRead(ctx, fmt.Sprintf("%s/repos/%s/%s", githubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo)), token, "application/vnd.github+json")
	if err != nil {
		return metadata, nil, nil, err
	}
	if json.Unmarshal(data, &metadata) != nil || !githubRepositorySegmentPattern.MatchString(metadata.Owner.Login) || !githubRepositorySegmentPattern.MatchString(metadata.Name) || metadata.Owner.Login == "." || metadata.Owner.Login == ".." || metadata.Name == "." || metadata.Name == ".." || !strings.EqualFold(metadata.FullName, metadata.Owner.Login+"/"+metadata.Name) {
		return metadata, nil, nil, errAgentGitHubRepositoryMissing
	}
	// Attribution comes from the canonical API owner, never caller-supplied fields
	// or the author of the most recent commit (who may only be a contributor).
	owner, repo = metadata.Owner.Login, metadata.Name
	ref := requestedRef
	if ref == "" {
		ref = metadata.DefaultBranch
	}
	if ref == "" || validateGitHubRef(ref) != nil {
		return metadata, nil, nil, errAgentGitHubRepositoryInvalid
	}
	apiURL := fmt.Sprintf("%s/repos/%s/%s", githubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo))
	data, err = a.githubRead(ctx, apiURL+"/commits/"+url.PathEscape(ref), token, "application/vnd.github.sha")
	if err != nil {
		return metadata, nil, nil, err
	}
	commit := strings.TrimSpace(string(data))
	if !githubCommitPattern.MatchString(commit) {
		return metadata, nil, nil, errAgentGitHubRepositoryMissing
	}
	// Download by resolved commit, so a moving branch cannot falsify provenance.
	response, err := a.githubRequest(ctx, apiURL+"/zipball/"+commit, token, "application/vnd.github+json")
	if err != nil {
		return metadata, nil, nil, errAgentGitHubRepositoryMissing
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return metadata, nil, nil, githubResponseError(response)
	}
	if response.ContentLength > githubArchiveMaxBytes {
		return metadata, nil, nil, errAgentGitHubArchiveInvalid
	}
	// Keep the compressed archive off the heap and private even for private repos.
	archiveFile, err := os.CreateTemp("", "koinote-github-*.zip")
	if err != nil {
		return metadata, nil, nil, err
	}
	defer func() { _ = archiveFile.Close(); _ = os.Remove(archiveFile.Name()) }()
	size, err := io.Copy(archiveFile, io.LimitReader(response.Body, githubArchiveMaxBytes+1))
	if err != nil || size > githubArchiveMaxBytes {
		return metadata, nil, nil, errAgentGitHubArchiveInvalid
	}
	files, err := readGitHubArchive(ctx, archiveFile, size)
	if err != nil {
		return metadata, nil, nil, err
	}
	license := "UNLICENSED"
	if metadata.License != nil && metadata.License.SPDXID != "NOASSERTION" && githubLicensePattern.MatchString(metadata.License.SPDXID) {
		license = metadata.License.SPDXID
	}
	source := &agentGitHubSource{RepositoryURL: "https://github.com/" + owner + "/" + repo, Author: owner, AuthorURL: "https://github.com/" + owner, Ref: ref, CommitSHA: commit, License: license, Private: metadata.Private}
	return metadata, files, source, nil
}

func readGitHubArchive(ctx context.Context, reader io.ReaderAt, size int64) ([]agentWorkspaceFile, error) {
	archive, err := zip.NewReader(reader, size)
	if err != nil || len(archive.File) > githubImportMaxFiles*2 {
		return nil, errAgentGitHubArchiveInvalid
	}
	files := make([]agentWorkspaceFile, 0, min(len(archive.File), githubImportMaxFiles))
	paths := make(map[string]bool) // value is true for regular files, false for directories
	root := ""
	totalBytes := 0
	for _, entry := range archive.File {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		isDir := entry.FileInfo().IsDir()
		if !entry.Mode().IsRegular() && !isDir {
			return nil, errAgentGitHubArchiveInvalid
		}
		if strings.Contains(entry.Name, "\\") {
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
		if isDir {
			continue
		}
		if len(files) >= githubImportMaxFiles || entry.UncompressedSize64 > uint64(agentWorkspaceMaxFileBytes) || entry.UncompressedSize64 > uint64(githubImportMaxBytes-totalBytes) {
			return nil, errAgentGitHubArchiveInvalid
		}
		stream, err := entry.Open()
		if err != nil {
			return nil, errAgentGitHubArchiveInvalid
		}
		content, err := io.ReadAll(io.LimitReader(stream, agentWorkspaceMaxFileBytes+1))
		_ = stream.Close()
		if err != nil || len(content) > agentWorkspaceMaxFileBytes {
			return nil, errAgentGitHubArchiveInvalid
		}
		totalBytes += len(content)
		if totalBytes > githubImportMaxBytes {
			return nil, errAgentGitHubArchiveInvalid
		}
		if agentWorkspaceSensitiveContent(content) {
			return nil, &agentWorkspaceSensitiveError{Path: clean}
		}
		digest := sha256.Sum256(content)
		mimeType := mime.TypeByExtension(filepath.Ext(clean))
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		files = append(files, agentWorkspaceFile{Path: clean, Content: content, MimeType: mimeType, SHA256: hex.EncodeToString(digest[:])})
	}
	for entry := range paths {
		parts := strings.Split(entry, "/")
		for i := 1; i < len(parts); i++ {
			if paths[strings.Join(parts[:i], "/")] {
				return nil, errAgentGitHubArchiveInvalid
			}
		}
	}
	if len(files) == 0 {
		return nil, errAgentGitHubArchiveInvalid
	}
	return files, nil
}

func githubImportFingerprint(input agentGitHubImportInput) string {
	input.RequestID = ""
	data, _ := json.Marshal(input)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func completedGitHubImport(ctx context.Context, queries agentWorkspaceQuerier, userID int, requestID, fingerprint string) (*agentWorkspaceView, error) {
	var id int64
	var previous string
	err := queries.QueryRow(ctx, `SELECT id,github_import_fingerprint FROM agent_workspaces WHERE user_id=$1 AND github_import_request_id=$2::uuid AND deleted_at IS NULL`, userID, requestID).Scan(&id, &previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if previous != fingerprint {
		return nil, errAgentWorkspaceConflict
	}
	view, err := loadAgentWorkspaceFrom(ctx, queries, userID, id)
	return &view, err
}

func (a *App) agentGitHubImportPost(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok || !a.requireAgentWorkspaceEnabled(w, r, user.ID) {
		return
	}
	var input agentGitHubImportInput
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if json.NewDecoder(r.Body).Decode(&input) != nil || !validUUID(input.RequestID) {
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
	existing, err := completedGitHubImport(r.Context(), a.db, user.ID, input.RequestID, fingerprint)
	if err != nil {
		writeAgentWorkspaceError(w, err)
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
	a.githubImportOnce.Do(func() { a.githubImportSlots = make(chan struct{}, 2) })
	select {
	case a.githubImportSlots <- struct{}{}:
		defer func() { <-a.githubImportSlots }()
	default:
		writeAgentWorkspaceError(w, errAgentGitHubImportBusy)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*githubRequestTimeout)
	defer cancel()
	token, err := a.loadGitHubToken(ctx, user.ID)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	metadata, files, source, err := a.fetchGitHubRepository(ctx, owner, repo, ref, token)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	name, description := input.Name, input.Description
	if name == "" {
		name = string([]rune(metadata.Name)[:min(80, utf8.RuneCountInString(metadata.Name))])
	}
	if description == "" {
		description = string([]rune(metadata.Description)[:min(500, utf8.RuneCountInString(metadata.Description))])
	}
	view, err := a.importGitHubRepository(ctx, user.ID, input.RequestID, fingerprint, name, description, files, source)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, 201, map[string]any{"workspace": view})
}

func (a *App) importGitHubRepository(ctx context.Context, userID int, requestID, fingerprint, name, description string, files []agentWorkspaceFile, source *agentGitHubSource) (agentWorkspaceView, error) {
	var empty agentWorkspaceView
	name, description, err := validateAgentWorkspaceMetadata(name, description)
	if err != nil {
		return empty, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return empty, err
	}
	existing, err := completedGitHubImport(ctx, tx, userID, requestID, fingerprint)
	if err != nil {
		return empty, err
	}
	if existing != nil {
		return *existing, nil
	}
	var enabled bool
	var count int
	var previous int64
	err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT enabled FROM agent_workspace_settings WHERE user_id=$1),false),(SELECT count(*) FROM agent_workspaces WHERE user_id=$1 AND deleted_at IS NULL),agent_workspace_storage_bytes($1)`, userID).Scan(&enabled, &count, &previous)
	if err != nil {
		return empty, err
	}
	if !enabled {
		return empty, errAgentWorkspaceDisabled
	}
	if count >= agentWorkspaceMaxRepositories {
		return empty, errAgentWorkspaceLimit
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description,github_source,github_import_request_id,github_import_fingerprint) VALUES($1,$2,$3,$4,$5::uuid,$6) RETURNING id`, userID, name, description, source, requestID, fingerprint).Scan(&id)
	if err != nil {
		return empty, err
	}
	for _, file := range files {
		if _, err = tx.Exec(ctx, `INSERT INTO agent_workspace_files(workspace_id,path,content,mime_type,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6)`, id, file.Path, file.Content, file.MimeType, len(file.Content), file.SHA256); err != nil {
			return empty, err
		}
	}
	if _, err = tx.Exec(ctx, `SELECT record_agent_workspace_commit($1,'import',NULL,$2)`, id, "Imported from GitHub: "+source.RepositoryURL+" @ "+source.CommitSHA); err != nil {
		return empty, err
	}
	if err = checkAgentWorkspaceQuota(ctx, tx, userID, previous); err != nil {
		return empty, err
	}
	view, err := loadAgentWorkspaceFrom(ctx, tx, userID, id)
	if err != nil {
		return empty, err
	}
	if err = tx.Commit(ctx); err != nil {
		return empty, err
	}
	return view, nil
}
