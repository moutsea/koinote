package server

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode"
)

// A GitHub entry point before source resolution. When Ref is empty, Path holds
// the unsplit ref/path remainder of a tree or blob link. FileEntry selects only
// the package containing that SKILL.md, excluding nested Skills.
type koiGitHubTarget struct {
	Owner     string
	Repo      string
	Ref       string
	Path      string
	FileEntry bool
}

var errKoiGitHubLink = errors.New("enter a github.com repository, tree or SKILL.md link")

func parseKoiGitHubLink(raw string) (koiGitHubTarget, error) {
	var target koiGitHubTarget
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) > 500 {
		return target, errKoiGitHubLink
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" ||
		(!strings.EqualFold(parsed.Host, "github.com") && !strings.EqualFold(parsed.Host, "www.github.com")) ||
		parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return target, errKoiGitHubLink
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 2 {
		return target, errKoiGitHubLink
	}
	target.Owner = parts[0]
	target.Repo = strings.TrimSuffix(parts[1], ".git")
	if !githubRepositorySegmentPattern.MatchString(target.Owner) || !githubRepositorySegmentPattern.MatchString(target.Repo) ||
		target.Owner == "." || target.Owner == ".." || target.Repo == "." || target.Repo == ".." {
		return koiGitHubTarget{}, errKoiGitHubLink
	}
	if len(parts) == 2 {
		return target, nil
	}
	if len(parts) < 4 || parts[2] != "tree" && parts[2] != "blob" {
		return koiGitHubTarget{}, errKoiGitHubLink
	}
	// Both refs and directories reject traversal, empty segments and controls.
	// Validate their shared syntax without guessing where the ref ends.
	for _, part := range parts[3:] {
		if part == "" || part == "." || part == ".." || strings.Contains(part, "\\") || strings.ContainsFunc(part, unicode.IsControl) {
			return koiGitHubTarget{}, errKoiGitHubLink
		}
	}
	target.FileEntry = parts[2] == "blob"
	if target.FileEntry && (len(parts) < 5 || parts[len(parts)-1] != "SKILL.md") {
		return koiGitHubTarget{}, errKoiGitHubLink
	}
	if githubCommitPattern.MatchString(parts[3]) {
		// Commit permalinks need no branch listing, even after branch deletion.
		target.Ref = parts[3]
		target.Path, err = koiNormalizeRepoPath(strings.Join(parts[4:], "/"))
		if err != nil {
			return koiGitHubTarget{}, err
		}
	} else {
		target.Path = strings.Join(parts[3:], "/")
	}
	return target, nil
}

// The caller supplies the repository's relevant branch/tag names. Multiple
// matching splits are ambiguous; never choose a different version by guessing
// that the longest ref was intended. Duplicate branch/tag names are one split.
func koiResolveGitHubRefPath(remainder string, refs []string) (ref, dir string, err error) {
	remainder = strings.Trim(strings.TrimSpace(remainder), "/")
	if remainder == "" {
		return "", "", errKoiGitHubLink
	}
	first, rest, _ := strings.Cut(remainder, "/")
	if githubCommitPattern.MatchString(first) {
		ref, dir = first, rest
	} else {
		for _, candidate := range refs {
			if candidate == "" || candidate == ref || remainder != candidate && !strings.HasPrefix(remainder, candidate+"/") {
				continue
			}
			if ref != "" {
				return "", "", fmt.Errorf("%w: ambiguous branch or tag; enter the ref and directory separately", errKoiGitHubLink)
			}
			ref = candidate
		}
		if ref == "" {
			return "", "", fmt.Errorf("%w: the branch or tag in this link could not be resolved", errKoiGitHubLink)
		}
		if remainder != ref {
			dir = strings.TrimPrefix(remainder, ref+"/")
		}
	}
	if validateGitHubRef(ref) != nil {
		return "", "", fmt.Errorf("%w: invalid branch or tag", errKoiGitHubLink)
	}
	if dir != "" {
		clean, cleanErr := koiNormalizeRepoPath(dir)
		if cleanErr != nil || clean != dir {
			return "", "", fmt.Errorf("%w: invalid directory in link", errKoiGitHubLink)
		}
	}
	return ref, dir, nil
}

// Advanced directory inputs accept the repository root and surrounding slashes;
// non-root paths follow the same rules as the archive and workspace readers.
func koiNormalizeRepoPath(raw string) (string, error) {
	value := strings.Trim(strings.TrimSpace(raw), "/")
	if value == "" {
		return "", nil
	}
	clean, err := normalizeAgentWorkspacePath(value)
	if err != nil {
		return "", fmt.Errorf("%w: invalid directory", errKoiGitHubLink)
	}
	return clean, nil
}
