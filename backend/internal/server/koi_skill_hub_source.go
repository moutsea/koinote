package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

type koiHubSourceInput struct {
	WorkspaceID   int64
	PublicationID string
	Revision      *int64
	Path          string
	ExactSkill    bool
}

type koiHubSource struct {
	Publication *agentRepositoryPublication
	Path        string
	ExactSkill  bool
	Files       []koiSkillFile
}

// Read a live, fixed Hub publication without creating a workspace or installing
// anything. Candidate validation remains the caller's responsibility. A later
// installation must independently recheck the publication at commit time.
func (a *App) readKoiHubSource(ctx context.Context, input koiHubSourceInput) (koiHubSource, error) {
	if input.WorkspaceID <= 0 || input.Revision != nil && *input.Revision < 0 {
		return koiHubSource{}, errAgentInput
	}
	dir := strings.Trim(strings.TrimSpace(input.Path), "/")
	if dir != "" {
		clean, err := normalizeAgentWorkspacePath(dir)
		if err != nil {
			return koiHubSource{}, fmt.Errorf("%w: invalid directory", errKoiSkillPackage)
		}
		dir = clean
	}
	publication, err := a.loadPublicAgentRepository(ctx, input.WorkspaceID, nil)
	if err != nil {
		return koiHubSource{}, err
	}
	if input.PublicationID != "" && input.PublicationID != publication.PublicationID ||
		input.Revision != nil && *input.Revision != publication.Revision {
		return koiHubSource{}, errAgentWorkspaceConflict
	}
	if publication.GitHubSource != nil && publication.GitHubSource.LinkOnly {
		return koiHubSource{}, errAgentGitHubRepositoryInvalid
	}
	files, err := a.loadKoiHubFiles(ctx, publication, dir, input.ExactSkill)
	if err != nil {
		return koiHubSource{}, err
	}
	// Network reads hold no database locks. Recheck after reading, including
	// empty selections, so withdrawal or republication cannot look successful.
	if err = a.checkKoiHubPublication(ctx, publication); err != nil {
		return koiHubSource{}, err
	}
	return koiHubSource{Publication: publication, Path: dir, ExactSkill: input.ExactSkill, Files: files}, nil
}

// Select package members from the published manifest before fetching bytes.
// Every blob lookup is bound to the same publication, never workspace files.
func (a *App) loadKoiHubFiles(ctx context.Context, publication *agentRepositoryPublication, dir string, exact bool) ([]koiSkillFile, error) {
	byPath := make(map[string]koiSkillFile, len(publication.Files))
	for _, file := range publication.Files {
		byPath[file.Path] = koiSkillFile{Path: file.Path, MimeType: file.MimeType, SizeBytes: file.SizeBytes, SHA256: file.SHA256}
	}
	needed := koiSkillNeededPaths(byPath, dir, exact)
	if len(needed) > koiSkillImportFiles {
		return nil, errKoiSkillTooLarge
	}
	var total int64
	for filePath := range needed {
		if size := byPath[filePath].SizeBytes; size <= koiSkillFileBytes {
			total += size
		}
	}
	if total > koiSkillImportBytes {
		return nil, errKoiSkillTooLarge
	}
	files := make([]koiSkillFile, 0, len(needed))
	paths := []string{}
	seen := map[string]bool{}
	for _, member := range publication.Files {
		if !needed[member.Path] {
			continue
		}
		file := byPath[member.Path]
		files = append(files, file)
		// Retain oversized metadata for candidate rejection without reading it.
		if file.SizeBytes <= koiSkillFileBytes && !seen[file.SHA256] {
			seen[file.SHA256] = true
			paths = append(paths, file.Path)
		}
	}
	if len(paths) == 0 {
		return files, nil
	}
	// Read one representative per content hash, bound to the exact publication.
	// Release the database connection before starting any object-store requests.
	type download struct {
		file koiSkillFile
		key  *string
	}
	rows, err := a.db.Query(ctx, `SELECT f.path,f.sha256,f.size_bytes,b.content,b.r2_object_key
 FROM agent_repository_publications p JOIN agent_workspaces w ON w.id=p.workspace_id
 JOIN agent_repository_publication_files f ON f.workspace_id=p.workspace_id
 JOIN agent_workspace_blobs b ON b.workspace_id=f.workspace_id AND b.sha256=f.sha256
 WHERE p.workspace_id=$1 AND p.published_at=$2::timestamptz AND p.revision=$3
 AND f.path=ANY($4::text[]) AND w.deleted_at IS NULL ORDER BY f.path`, publication.WorkspaceID, publication.PublicationID, publication.Revision, paths)
	if err != nil {
		return nil, err
	}
	downloads := make([]download, 0, len(paths))
	byHash := map[string]int{}
	for rows.Next() {
		var item download
		if err = rows.Scan(&item.file.Path, &item.file.SHA256, &item.file.SizeBytes, &item.file.Content, &item.key); err != nil {
			rows.Close()
			return nil, err
		}
		expected, exists := byPath[item.file.Path]
		if !exists || expected.SHA256 != item.file.SHA256 || expected.SizeBytes != item.file.SizeBytes {
			rows.Close()
			return nil, errAgentRepositoryStorage
		}
		byHash[item.file.SHA256] = len(downloads)
		downloads = append(downloads, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(downloads) != len(paths) {
		if err = a.checkKoiHubPublication(ctx, publication); err != nil {
			return nil, err
		}
		return nil, errAgentRepositoryStorage
	}
	work, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan int)
	var wg sync.WaitGroup
	var once sync.Once
	var firstErr error
	for range min(8, len(downloads)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				if work.Err() != nil {
					return
				}
				item := &downloads[index]
				content, readErr := a.readAgentRepositoryContent(work, item.file.Content, item.key, item.file.SHA256, item.file.SizeBytes, 0, koiSkillFileBytes)
				if readErr == nil && agentWorkspaceSensitiveContent(content) {
					readErr = &agentWorkspaceSensitiveError{Path: item.file.Path}
				}
				if readErr != nil {
					once.Do(func() { firstErr = readErr; cancel() })
					return
				}
				item.file.Content = content
			}
		}()
	}
	for index := range downloads {
		select {
		case jobs <- index:
		case <-work.Done():
		}
		if work.Err() != nil {
			break
		}
	}
	close(jobs)
	wg.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if firstErr != nil {
		return nil, firstErr
	}
	for i := range files {
		file := &files[i]
		if file.SizeBytes > koiSkillFileBytes {
			continue
		}
		index, exists := byHash[file.SHA256]
		if !exists || downloads[index].file.SizeBytes != file.SizeBytes {
			return nil, errAgentRepositoryStorage
		}
		file.Content = downloads[index].file.Content
	}
	return files, nil
}

func (a *App) checkKoiHubPublication(ctx context.Context, expected *agentRepositoryPublication) error {
	var revision int64
	var published time.Time
	err := a.db.QueryRow(ctx, `SELECT p.revision,p.published_at
 FROM agent_repository_publications p JOIN agent_workspaces w ON w.id=p.workspace_id
 WHERE p.workspace_id=$1 AND w.deleted_at IS NULL`, expected.WorkspaceID).Scan(&revision, &published)
	if errors.Is(err, pgx.ErrNoRows) {
		return errAgentWorkspaceNotFound
	}
	if err != nil {
		return err
	}
	if revision != expected.Revision || published.UTC().Format(time.RFC3339Nano) != expected.PublicationID {
		return errAgentWorkspaceConflict
	}
	return nil
}
