package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

// File paths passed to these helpers must already be normalized, unique,
// repository-relative paths. SHA256 values used by the content digest must be
// verified against the file bytes by the source reader. These functions only
// establish package boundaries and provenance; they do not validate an import
// or authorize its use.

// Determine ownership from metadata before fetching or validating bytes,
// including exact single-Skill selection without its nested candidates.
func koiSkillNeededPaths(byPath map[string]koiSkillFile, dir string, exact bool) map[string]bool {
	dirs := []string{}
	for filePath := range byPath {
		if path.Base(filePath) == "SKILL.md" {
			dirs = append(dirs, koiSkillDirOf(filePath))
		}
	}
	needed := map[string]bool{}
	for _, skillDir := range dirs {
		if !koiSkillUnder(dir, skillDir) || exact && skillDir != dir {
			continue
		}
		nested := []string{}
		for _, other := range dirs {
			if other != skillDir && koiSkillUnder(skillDir, other) {
				nested = append(nested, other)
			}
		}
		for _, file := range koiSkillPackageFiles(skillDir, byPath, nested) {
			needed[file.Path] = true
		}
	}
	return needed
}

// Return the files that belong to the selected package. Nested skill
// directories are separate candidates and are never folded into a parent.
func koiSkillPackageFiles(dir string, byPath map[string]koiSkillFile, nested []string) []koiSkillFile {
	files := []koiSkillFile{}
	for filePath, file := range byPath {
		if !koiSkillUnder(dir, filePath) && !koiSkillAncestorNotice(dir, filePath) {
			continue
		}
		excluded := false
		for _, child := range nested {
			if child != dir && koiSkillUnder(child, filePath) {
				excluded = true
				break
			}
		}
		if !excluded {
			files = append(files, file)
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files
}

func koiSkillAncestorNotice(dir, filePath string) bool {
	parent := koiSkillDirOf(filePath)
	return parent != dir && koiSkillUnder(parent, dir) && koiSkillProvenanceName(strings.ToUpper(path.Base(filePath)))
}

// Rebase members already selected by koiSkillPackageFiles, preserving notices.
func koiSkillRebaseFiles(dir string, files []koiSkillFile) []koiSkillFile {
	rebased := make([]koiSkillFile, 0, len(files))
	used := map[string]bool{}
	for _, file := range files {
		if koiSkillUnder(dir, file.Path) {
			if dir != "" {
				file.Path = strings.TrimPrefix(file.Path, dir+"/")
			}
			used[file.Path] = true
			rebased = append(rebased, file)
		}
	}
	for _, file := range files {
		if koiSkillUnder(dir, file.Path) {
			continue
		}
		// Ancestor notices get their own path even when the Skill has a local
		// license too. Never overwrite either file or change its bytes.
		base := "_provenance/" + koiDigest([]byte(file.Path))[:16]
		target := base + "/" + path.Base(file.Path)
		for index := 1; used[target]; index++ {
			target = fmt.Sprintf("%s-%d/%s", base, index, path.Base(file.Path))
		}
		file.Path = target
		used[target] = true
		rebased = append(rebased, file)
	}
	sort.Slice(rebased, func(i, j int) bool { return rebased[i].Path < rebased[j].Path })
	return rebased
}

func koiSkillUnder(prefix, candidate string) bool {
	if prefix == "" {
		return true
	}
	return candidate == prefix || strings.HasPrefix(candidate, prefix+"/")
}

func koiSkillDirOf(entry string) string {
	dir := path.Dir(entry)
	if dir == "." || dir == "/" {
		return ""
	}
	return dir
}

func koiSkillContentDigest(files []koiSkillFile) string {
	sorted := make([]koiSkillFile, len(files))
	copy(sorted, files)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })
	digest := sha256.New()
	for _, file := range sorted {
		digest.Write([]byte(file.Path))
		digest.Write([]byte{0})
		digest.Write([]byte(file.SHA256))
		digest.Write([]byte{'\n'})
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// Required capabilities in an unchanged entry remain required when a user adds
// a README or other attachments. Package approvals still use the full digest.
func koiSkillEntryDigest(instructions string) string {
	return koiSkillContentDigest([]koiSkillFile{{Path: "SKILL.md", SHA256: koiDigest([]byte(instructions))}})
}

// Use selected source paths before rebasing. Prefer a local license, then a
// frontmatter declaration, then the closest ancestor's license. Attribution
// notices stay in the package but never stand in for a license declaration.
func koiSkillLicense(raw map[string]any, files []koiSkillFile, dir string) string {
	for _, file := range files {
		if path.Dir(file.Path) != koiDirOrDot(dir) {
			continue
		}
		base := strings.ToUpper(path.Base(file.Path))
		if !koiSkillLicenseName(base) {
			continue
		}
		if summary := koiSkillLicenseSummary(string(file.Content)); summary != "" {
			return summary
		}
	}
	for _, key := range []string{"license", "licence"} {
		if value, ok := raw[key].(string); ok {
			if summary := koiSkillLicenseSummary(value); summary != "" {
				return summary
			}
		}
	}
	if dir != "" {
		return koiSkillLicense(nil, files, koiSkillDirOf(dir))
	}
	return ""
}

// Length only limits the display summary; it must never change which notice or
// declaration wins. Keep the original file bytes and raw metadata untouched.
func koiSkillLicenseSummary(value string) string {
	const maxBytes = 4096
	const suffix = "…"
	value = strings.TrimSpace(value)
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes - len(suffix)
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end] + suffix
}

func koiDirOrDot(dir string) string {
	if dir == "" {
		return "."
	}
	return dir
}

func koiSkillProvenanceName(upper string) bool {
	return koiSkillLicenseName(upper) || upper == "NOTICE" || strings.HasPrefix(upper, "NOTICE.") || strings.HasPrefix(upper, "NOTICE-")
}

func koiSkillLicenseName(upper string) bool {
	for _, prefix := range []string{"LICENSE", "LICENCE", "COPYING"} {
		if upper == prefix || strings.HasPrefix(upper, prefix+".") || strings.HasPrefix(upper, prefix+"-") {
			return true
		}
	}
	return false
}

func koiDigest(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}
