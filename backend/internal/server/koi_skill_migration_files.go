package server

import (
	"context"
	"path"
	"sync"
)

// Keep package boundaries and rejection metadata, but do not download attachments
// for packages whose declared sizes/counts already exceed the runtime limits.
// The entry is still parsed so the existing validation messages stay accurate.
func (a *App) loadKoiMigrationFiles(ctx context.Context, userID int, view agentWorkspaceView, selected map[string]bool, cache map[string][]byte) ([]koiSkillFile, error) {
	byPath := map[string]koiSkillFile{}
	dirs := []string{}
	for _, file := range view.Files {
		byPath[file.Path] = koiSkillFile{Path: file.Path, MimeType: file.MimeType, SHA256: file.SHA256, SizeBytes: file.SizeBytes}
		if path.Base(file.Path) == "SKILL.md" {
			dirs = append(dirs, koiSkillDirOf(file.Path))
		}
	}
	read := map[string]bool{}
	for _, dir := range dirs {
		if selected != nil && !selected[dir] {
			continue
		}
		nested := []string{}
		for _, other := range dirs {
			if other != dir && koiSkillUnder(dir, other) {
				nested = append(nested, other)
			}
		}
		files := koiSkillPackageFiles(dir, byPath, nested)
		var total int64
		valid := len(files) <= koiSkillMaxFiles
		for _, file := range files {
			total += file.SizeBytes
			valid = valid && file.SizeBytes <= koiSkillFileBytes
		}
		entry := path.Join(dir, "SKILL.md")
		if byPath[entry].SizeBytes <= koiSkillEntryBytes {
			read[entry] = true
			if valid && total <= koiSkillPackageBytes {
				for _, file := range files {
					read[file.Path] = true
				}
			}
		}
	}
	// A hash is verified once and reused only within this account's analysis.
	// Fetch all uncached source rows together, then release the DB connection
	// before making bounded parallel object-store requests.
	paths := []string{}
	seen := map[string]bool{}
	for _, file := range view.Files {
		if _, cached := cache[file.SHA256]; read[file.Path] && !cached && !seen[file.SHA256] {
			seen[file.SHA256] = true
			paths = append(paths, file.Path)
		}
	}
	type download struct {
		file koiSkillFile
		key  *string
	}
	downloads := []download{}
	if len(paths) > 0 {
		rows, err := a.db.Query(ctx, `SELECT f.path,f.sha256,f.size_bytes,COALESCE(f.content,b.content),b.r2_object_key
 FROM agent_workspace_files f JOIN agent_workspaces w ON w.id=f.workspace_id
 LEFT JOIN agent_workspace_blobs b ON b.workspace_id=f.workspace_id AND b.sha256=f.sha256
 WHERE w.id=$1 AND w.user_id=$2 AND w.deleted_at IS NULL AND w.revision=$3 AND f.path=ANY($4::text[])`, view.WorkspaceID, userID, view.Revision, paths)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var item download
			if err = rows.Scan(&item.file.Path, &item.file.SHA256, &item.file.SizeBytes, &item.file.Content, &item.key); err != nil {
				rows.Close()
				return nil, err
			}
			expected := byPath[item.file.Path]
			if item.file.SHA256 != expected.SHA256 || item.file.SizeBytes != expected.SizeBytes {
				rows.Close()
				return nil, errKoiSkillConflict
			}
			downloads = append(downloads, item)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if len(downloads) != len(paths) {
			return nil, errKoiSkillConflict
		}
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
				item := &downloads[index]
				content, err := a.readAgentRepositoryContent(work, item.file.Content, item.key, item.file.SHA256, item.file.SizeBytes, 0, koiSkillFileBytes)
				if err != nil {
					once.Do(func() { firstErr = err; cancel() })
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
	for _, item := range downloads {
		cache[item.file.SHA256] = item.file.Content
	}
	needed := koiSkillNeededPaths(byPath, "", false)
	files := []koiSkillFile{}
	for _, member := range view.Files {
		if !needed[member.Path] {
			continue
		}
		file := byPath[member.Path]
		if read[file.Path] {
			file.Content = cache[file.SHA256]
			if int64(len(file.Content)) != file.SizeBytes {
				return nil, errAgentRepositoryStorage
			}
		}
		files = append(files, file)
	}
	return files, nil
}
