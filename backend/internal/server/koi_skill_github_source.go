package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

type koiGitHubSourceInput struct {
	RepositoryURL string
	Ref           string
	Path          string
	ExactSkill    bool
	PublicOnly    bool // Shared compatibility checks must never read private Skills.
}

type koiGitHubSource struct {
	Target koiGitHubTarget
	Source *agentGitHubSource
	Files  []koiSkillFile
}

// Read a source without creating a repository or installing anything. Candidate
// validation remains the caller's responsibility. Credentials never enter the
// result, and every download uses the resolved commit rather than a moving ref.
func (a *App) readKoiGitHubSource(ctx context.Context, input koiGitHubSourceInput, token string) (koiGitHubSource, error) {
	target, err := parseKoiGitHubLink(input.RepositoryURL)
	if err != nil {
		return koiGitHubSource{}, err
	}
	dir, err := koiNormalizeRepoPath(input.Path)
	if err != nil {
		return koiGitHubSource{}, err
	}
	if ref := strings.TrimSpace(input.Ref); ref != "" {
		if validateGitHubRef(ref) != nil {
			return koiGitHubSource{}, fmt.Errorf("%w: invalid ref", errKoiGitHubLink)
		}
		// Explicit ref/directory fields replace the link's ref/path split,
		// including blob links. Path now names a directory, not SKILL.md.
		target.Ref, target.Path, target.FileEntry = ref, dir, false
	}
	ctx, cancel := context.WithTimeout(ctx, 2*githubRequestTimeout)
	defer cancel()
	result, err := a.readKoiGitHubSourceWithToken(ctx, input, target, dir, token)
	// Shared maintenance must stop on rejected credentials instead of spending
	// the anonymous API quota reserved for interactive public installations.
	if err != nil && token != "" && !input.PublicOnly && agentGitHubTokenRejected(err) {
		public, publicErr := a.readKoiGitHubSourceWithToken(ctx, input, target, dir, "")
		return public, agentGitHubFallbackError(err, publicErr)
	}
	return result, err
}

func (a *App) readKoiGitHubSourceWithToken(ctx context.Context, input koiGitHubSourceInput, target koiGitHubTarget, dir, token string) (koiGitHubSource, error) {
	metadata, err := a.resolveGitHubRepositoryMetadata(ctx, target.Owner, target.Repo, token, input.PublicOnly)
	if err != nil {
		return koiGitHubSource{}, err
	}
	if target.Ref == "" && target.Path != "" {
		refs, err := a.koiGitHubRefs(ctx, metadata.Owner.Login, metadata.Name, metadata.DefaultBranch, token)
		if err != nil {
			return koiGitHubSource{}, err
		}
		target.Ref, target.Path, err = koiResolveGitHubRefPath(target.Path, refs)
		if err != nil {
			return koiGitHubSource{}, err
		}
	}
	if strings.TrimSpace(input.Path) != "" {
		target.Path, target.FileEntry = dir, false
	}
	if target.FileEntry {
		target.Path = koiSkillDirOf(target.Path)
	}
	target.FileEntry = target.FileEntry || input.ExactSkill
	source, err := a.resolveGitHubRepositoryCommit(ctx, metadata, target.Ref, token)
	if err != nil {
		return koiGitHubSource{}, err
	}
	archiveToken := token
	if input.PublicOnly {
		archiveToken = ""
	}
	files, err := a.downloadKoiGitHubRepository(ctx, metadata.Owner.Login, metadata.Name, source.CommitSHA, archiveToken, target.Path, target.FileEntry)
	if err != nil {
		return koiGitHubSource{}, err
	}
	target.Owner, target.Repo, target.Ref = metadata.Owner.Login, metadata.Name, source.Ref
	return koiGitHubSource{Target: target, Source: source, Files: files}, nil
}

// A partial branch/tag catalog cannot prove a URL's ref/path split unique.
// Read bounded pages and require explicit fields if the catalog is too large,
// instead of silently choosing a ref from the first page.
func (a *App) koiGitHubRefs(ctx context.Context, owner, repo, defaultBranch, token string) ([]string, error) {
	seen := map[string]bool{}
	if defaultBranch != "" && validateGitHubRef(defaultBranch) == nil {
		seen[defaultBranch] = true
	}
	for _, kind := range []string{"branches", "tags"} {
		for page := 1; ; page++ {
			if page > 10 {
				return nil, fmt.Errorf("%w: too many branches or tags; enter the ref and directory separately", errKoiGitHubLink)
			}
			endpoint := fmt.Sprintf("%s/repos/%s/%s/%s?per_page=100&page=%d", githubAPIBaseURL, url.PathEscape(owner), url.PathEscape(repo), kind, page)
			data, err := a.githubRead(ctx, endpoint, token, "application/vnd.github+json", githubRequestCommit)
			if err != nil {
				return nil, err
			}
			var entries []struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(data, &entries) != nil || entries == nil || len(entries) > 100 {
				return nil, errAgentGitHubResponseInvalid
			}
			for _, entry := range entries {
				if entry.Name == "" || validateGitHubRef(entry.Name) != nil {
					return nil, errAgentGitHubResponseInvalid
				}
				seen[entry.Name] = true
			}
			if len(entries) < 100 {
				break
			}
		}
	}
	refs := make([]string, 0, len(seen))
	for ref := range seen {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	return refs, nil
}
