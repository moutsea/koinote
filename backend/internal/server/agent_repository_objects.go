package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

var errAgentRepositoryStorage = errors.New("repository file storage is unavailable; retry later")
var agentRepositoryObjectKey = regexp.MustCompile(`^objects/[0-9a-f]{32}/[0-9a-f]{64}$`)

type agentRepositoryObjectStore interface {
	Put(context.Context, string, []byte) error
	Read(context.Context, string, int64, int64, string) ([]byte, error)
	Delete(context.Context, string) error
}

type workerAgentRepositoryObjects struct {
	baseURL, token string
	client         *http.Client
}

func (s *workerAgentRepositoryObjects) request(ctx context.Context, method, key string, body []byte, query url.Values) (*http.Response, error) {
	if s.baseURL == "" || s.token == "" || !agentRepositoryObjectKey.MatchString(key) {
		return nil, errAgentRepositoryStorage
	}
	endpoint := strings.TrimRight(s.baseURL, "/") + "/api/internal/agent-repository-objects/" + key
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, errAgentRepositoryStorage
	}
	req.Header.Set("X-Koinote-Internal-Token", s.token)
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, errAgentRepositoryStorage
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		res.Body.Close()
		return nil, fmt.Errorf("%w (object %s: HTTP %d)", errAgentRepositoryStorage, method, res.StatusCode)
	}
	return res, nil
}

func (s *workerAgentRepositoryObjects) Put(ctx context.Context, key string, content []byte) error {
	res, err := s.request(ctx, http.MethodPut, key, content, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, err = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	if err != nil {
		return errAgentRepositoryStorage
	}
	return nil
}

func (s *workerAgentRepositoryObjects) Read(ctx context.Context, key string, offset, length int64, hash string) ([]byte, error) {
	res, err := s.request(ctx, http.MethodGet, key, nil, url.Values{"offset": {strconv.FormatInt(offset, 10)}, "length": {strconv.FormatInt(length, 10)}})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.Header.Get("X-Koinote-Object-Sha256") != hash {
		return nil, errAgentRepositoryStorage
	}
	content, err := io.ReadAll(io.LimitReader(res.Body, length+1))
	if err != nil || int64(len(content)) != length {
		return nil, errAgentRepositoryStorage
	}
	return content, nil
}

func (s *workerAgentRepositoryObjects) Delete(ctx context.Context, key string) error {
	res, err := s.request(ctx, http.MethodDelete, key, nil, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

// Reads are invoked only after the owning account or public revision has been
// checked by the caller's query. No object key is exposed to clients.
func (a *App) readAgentRepositoryContent(ctx context.Context, legacy []byte, key *string, hash string, size, offset int64, limit int) ([]byte, error) {
	if offset < 0 || offset > size || limit < 1 || limit > agentWorkspaceMaxFileBytes || size < 0 || size > agentWorkspaceMaxFileBytes {
		return nil, errAgentWorkspaceFileRange
	}
	length := int64(min(limit, int(size-offset)))
	if key == nil {
		// Legacy range queries already select only the requested bytes.
		if int64(len(legacy)) != length {
			return nil, errAgentRepositoryStorage
		}
		if offset == 0 && length == size {
			digest := sha256.Sum256(legacy)
			if hex.EncodeToString(digest[:]) != hash {
				return nil, errAgentRepositoryStorage
			}
		}
		return legacy, nil
	}
	if a.agentObjectStore == nil {
		return nil, errAgentRepositoryStorage
	}
	if length == 0 && size != 0 {
		return []byte{}, nil
	}
	content, err := a.agentObjectStore.Read(ctx, *key, offset, length, hash)
	if err != nil {
		return nil, err
	}
	if offset == 0 && length == size {
		digest := sha256.Sum256(content)
		if hex.EncodeToString(digest[:]) != hash {
			return nil, errAgentRepositoryStorage
		}
	}
	return content, nil
}

type agentRepositoryStagedObject struct {
	key, hash string
	content   []byte
}

// Register uploads before sending bytes to R2. Failed uploads and rolled-back
// mutations leave durable, reclaimable reservations, never untracked objects.
// Network I/O finishes before callers acquire their account/workspace locks.
func (a *App) stageAgentRepositoryFiles(ctx context.Context, userID int, files []agentWorkspaceFile) (map[string]string, error) {
	if a.agentObjectStore == nil || len(files) == 0 {
		return nil, nil
	}
	var budget int64
	if err := a.db.QueryRow(ctx, `SELECT GREATEST(agent_workspace_quota_bytes($1),agent_workspace_storage_bytes($1))`, userID).Scan(&budget); err != nil {
		return nil, err
	}
	var bytes int64
	for _, file := range files {
		bytes += int64(len(file.Content))
	}
	if bytes > budget {
		return nil, errAgentWorkspaceQuota
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	objects := make([]agentRepositoryStagedObject, 0, len(files))
	keys, hashes, sizes := []string{}, []string{}, []int64{}
	byHash := make(map[string]string, len(files))
	for _, file := range files {
		digest := sha256.Sum256(file.Content)
		if len(file.Content) > agentWorkspaceMaxFileBytes || hex.EncodeToString(digest[:]) != file.SHA256 {
			return nil, errAgentRepositoryStorage
		}
		if _, exists := byHash[file.SHA256]; exists {
			continue
		}
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, err
		}
		key := "objects/" + hex.EncodeToString(random[:]) + "/" + file.SHA256
		byHash[file.SHA256] = key
		objects = append(objects, agentRepositoryStagedObject{key: key, hash: file.SHA256, content: file.Content})
		keys, hashes, sizes = append(keys, key), append(hashes, file.SHA256), append(sizes, int64(len(file.Content)))
	}
	if _, err := a.db.Exec(ctx, `INSERT INTO agent_repository_objects(object_key,sha256,size_bytes)
 SELECT * FROM unnest($1::text[],$2::text[],$3::bigint[])`, keys, hashes, sizes); err != nil {
		return nil, err
	}
	complete := false
	defer func() {
		if !complete {
			a.expireAgentRepositoryStaging(ctx, byHash)
		}
	}()
	// Bound concurrent R2 requests even for a large GitHub repository.
	jobs := make(chan agentRepositoryStagedObject)
	var wg sync.WaitGroup
	var once sync.Once
	var firstErr error
	for range min(8, len(objects)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for object := range jobs {
				if err := a.agentObjectStore.Put(ctx, object.key, object.content); err != nil {
					once.Do(func() { firstErr = err; cancel() })
				}
			}
		}()
	}
	for _, object := range objects {
		if ctx.Err() != nil {
			break
		}
		select {
		case jobs <- object:
		case <-ctx.Done():
		}
	}
	close(jobs)
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%w: %v", errAgentRepositoryStorage, ctx.Err())
	}
	complete = true
	return byHash, nil
}

func insertAgentRepositoryFile(ctx context.Context, tx pgx.Tx, workspaceID int64, file agentWorkspaceFile, staged map[string]string) error {
	content := file.Content
	if key := staged[file.SHA256]; key != "" {
		// The FK also locks the object reservation against garbage collection.
		if _, err := tx.Exec(ctx, `INSERT INTO agent_workspace_blobs(workspace_id,sha256,content,size_bytes,r2_object_key)
 VALUES($1,$2,NULL,$3,$4) ON CONFLICT(workspace_id,sha256) DO UPDATE
 SET content=NULL,size_bytes=EXCLUDED.size_bytes,r2_object_key=EXCLUDED.r2_object_key
 WHERE agent_workspace_blobs.r2_object_key IS NULL`, workspaceID, file.SHA256, len(file.Content), key); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_workspace_files SET content=NULL WHERE workspace_id=$1 AND sha256=$2 AND content IS NOT NULL`, workspaceID, file.SHA256); err != nil {
			return err
		}
		content = nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO agent_workspace_files(workspace_id,path,content,mime_type,size_bytes,sha256)
 VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(workspace_id,path) DO UPDATE SET content=EXCLUDED.content,
 mime_type=EXCLUDED.mime_type,size_bytes=EXCLUDED.size_bytes,sha256=EXCLUDED.sha256
 WHERE agent_workspace_files.sha256<>EXCLUDED.sha256 OR agent_workspace_files.mime_type<>EXCLUDED.mime_type
 OR agent_workspace_files.content IS DISTINCT FROM EXCLUDED.content`, workspaceID, file.Path, content, file.MimeType, len(file.Content), file.SHA256)
	return err
}

// Called after the caller's transaction has finished. A committed object keeps
// its backup retention even if another request deleted its last live reference.
func (a *App) expireAgentRepositoryStaging(parent context.Context, staged map[string]string) {
	if len(staged) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 5*time.Second)
	defer cancel()
	keys := make([]string, 0, len(staged))
	for _, key := range staged {
		keys = append(keys, key)
	}
	// Short grace also covers an uncertain in-flight R2 upload after cancellation.
	_, _ = a.db.Exec(ctx, `UPDATE agent_repository_objects SET delete_after=LEAST(delete_after,now()+interval '5 minutes')
 WHERE object_key=ANY($1::text[]) AND NOT committed`, keys)
}
