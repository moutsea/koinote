package server

import (
	"context"
	"io"
	"mime"
	"path"
)

// Download a pinned archive and read only the selected packages and ancestor
// notices. This is a source reader; callers must validate candidate packages
// before installation. Oversized members carry metadata only for rejection.
// dir must be normalized and repository-relative; fileEntry excludes nested Skills.
func (a *App) downloadKoiGitHubRepository(ctx context.Context, owner, repo, commit, token, dir string, fileEntry bool) ([]koiSkillFile, error) {
	var files []koiSkillFile
	err := a.readGitHubRepositoryArchive(ctx, owner, repo, commit, token, func(reader io.ReaderAt, size int64) error {
		var err error
		files, err = readKoiGitHubArchive(ctx, reader, size, dir, fileEntry)
		return err
	})
	return files, err
}

func readKoiGitHubArchive(ctx context.Context, reader io.ReaderAt, size int64, dir string, fileEntry bool) ([]koiSkillFile, error) {
	members, err := githubArchiveMembers(ctx, reader, size)
	if err != nil {
		return nil, err
	}
	byPath := make(map[string]koiSkillFile, len(members))
	for _, member := range members {
		// Bound hostile ZIP sizes before converting to int64. Values above this
		// cap are already too large for any candidate package.
		sizeBytes := int64(koiSkillImportBytes + 1)
		if member.File.UncompressedSize64 <= uint64(koiSkillImportBytes) {
			sizeBytes = int64(member.File.UncompressedSize64)
		}
		byPath[member.Path] = koiSkillFile{Path: member.Path, SizeBytes: sizeBytes}
	}
	needed := koiSkillNeededPaths(byPath, dir, fileEntry)
	if len(needed) > koiSkillImportFiles {
		return nil, errKoiSkillTooLarge
	}
	files := make([]koiSkillFile, 0, len(needed))
	totalBytes := 0
	for _, member := range members {
		if err := githubArchiveContextError(ctx); err != nil {
			return nil, err
		}
		if !needed[member.Path] {
			continue
		}
		file := byPath[member.Path]
		file.MimeType = mime.TypeByExtension(path.Ext(file.Path))
		if file.MimeType == "" {
			file.MimeType = "application/octet-stream"
		}
		if file.SizeBytes <= koiSkillFileBytes {
			if totalBytes+int(file.SizeBytes) > koiSkillImportBytes {
				return nil, errKoiSkillTooLarge
			}
			file.Content, err = readGitHubArchiveMember(ctx, member, koiSkillFileBytes)
			if err != nil {
				return nil, err
			}
			totalBytes += len(file.Content)
			if agentWorkspaceSensitiveContent(file.Content) {
				// Keep the member's boundary, but never retain rejected bytes.
				// Candidate validation rejects its package and any inheritors;
				// independent siblings can still be previewed and installed.
				file.RejectionCode = "sensitive_data_detected"
				file.Content = nil
			} else {
				file.SHA256 = koiDigest(file.Content)
			}
		}
		files = append(files, file)
	}
	if err := githubArchiveContextError(ctx); err != nil {
		return nil, err
	}
	return files, nil
}
