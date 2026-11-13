package server

import (
	"errors"
	"path"
	"sort"
	"strings"
	"unicode"
)

const (
	koiSkillPackageBytes = 512 << 10
	koiSkillMaxFiles     = 32
)

type koiSkillCandidate struct {
	ID             string                `json:"id"`
	Name           string                `json:"name"`
	Description    string                `json:"description"`
	Directory      string                `json:"directory"`
	EntryPath      string                `json:"entryPath"`
	MetadataFormat string                `json:"metadataFormat"`
	Instructions   string                `json:"instructions"`
	RawMetadata    map[string]any        `json:"rawMetadata"`
	Files          []koiSkillFile        `json:"-"`
	FileCount      int                   `json:"fileCount"`
	SizeBytes      int64                 `json:"sizeBytes"`
	ContentSHA256  string                `json:"contentSha256"`
	License        string                `json:"license"`
	Compatibility  koiSkillCompatibility `json:"compatibility"`
}

type koiSkillRejected struct {
	Directory string   `json:"directory"`
	EntryPath string   `json:"entryPath"`
	Name      string   `json:"name,omitempty"`
	Reason    string   `json:"reason"`
	Details   []string `json:"details,omitempty"`
}

// Keep the original tree and source context until package boundaries and
// ancestor notices have been resolved. Directory is repository-relative.
type koiSkillSourceContext struct {
	Review    koiRepositoryCuration
	Directory string
	RootName  string
	License   string
}

func (f *koiSkillFile) normalize() {
	if f.SizeBytes == 0 {
		f.SizeBytes = int64(len(f.Content))
	}
	if f.MimeType == "" {
		f.MimeType = "application/octet-stream"
	}
}

// Split a verified source tree into structurally valid packages and per-package
// rejections. Source readers must supply normalized, unique paths and verified
// bytes/digests (oversized members may be metadata-only). Candidates must support
// hosted conversation use; installation authorization is checked by callers.
func koiSkillCandidates(files []koiSkillFile, contexts ...koiSkillSourceContext) (candidates []koiSkillCandidate, rejected []koiSkillRejected) {
	source := koiSkillSourceContext{}
	if len(contexts) > 0 {
		source = contexts[0]
	}
	byPath := make(map[string]koiSkillFile, len(files))
	entries := []string{}
	for _, file := range files {
		file.normalize()
		if file.SHA256 == "" {
			file.SHA256 = koiDigest(file.Content)
		}
		byPath[file.Path] = file
		if path.Base(file.Path) == "SKILL.md" {
			entries = append(entries, file.Path)
		}
	}
	sort.Strings(entries)
	dirs := make([]string, 0, len(entries))
	for _, entry := range entries {
		dirs = append(dirs, koiSkillDirOf(entry))
	}
	candidates = []koiSkillCandidate{}
	rejected = []koiSkillRejected{}
	for _, entry := range entries {
		if !koiSkillUnder(source.Directory, entry) {
			continue
		}
		dir := koiSkillDirOf(entry)
		relativeDir := strings.TrimPrefix(strings.TrimPrefix(dir, source.Directory), "/")
		var nested []string
		for _, other := range dirs {
			if other != dir && koiSkillUnder(dir, other) {
				nested = append(nested, other)
			}
		}
		pkgFiles := koiSkillPackageFiles(dir, byPath, nested)
		displayDir := relativeDir
		if displayDir == "" {
			displayDir = "."
		}
		reject := func(name, reason string, details ...string) {
			rejected = append(rejected, koiSkillRejected{Directory: displayDir, EntryPath: strings.TrimPrefix(entry, source.Directory+"/"), Name: name, Reason: reason, Details: details})
		}
		// Never turn a rejected member into a missing or empty file. Use the same
		// boundaries for rejected entries, nested Skills and inherited notices.
		blocked := false
		for _, file := range pkgFiles {
			if file.RejectionCode != "" {
				reject("", file.RejectionCode, file.RejectionCode+":"+file.Path)
				blocked = true
				break
			}
		}
		if blocked {
			continue
		}
		entryFile := byPath[entry]
		name, description, raw, format, instructions, err := koiParseSkillEntry(entryFile)
		if err != nil {
			switch {
			case errors.Is(err, errKoiSkillTooLarge):
				reject("", "entry_too_large")
			case errors.Is(err, errKoiSkillMissingName):
				reject("", "missing_name")
			case errors.Is(err, errKoiSkillMissingDescription):
				reject("", "missing_description")
			case errors.Is(err, errKoiSkillEmptyEntry):
				reject("", "empty_entry")
			case strings.Contains(err.Error(), "name must be"):
				reject("", "invalid_name")
			case strings.Contains(err.Error(), "must be strings"):
				reject("", "invalid_metadata_type")
			default:
				reject("", "invalid_frontmatter")
			}
			continue
		}
		if format == "plain-markdown" {
			dirName := path.Base(dir)
			if dir == "" {
				dirName = source.RootName
			}
			if koiValidSkillName(dirName) {
				name = dirName
			} else {
				name = koiSlugFromText(dirName)
			}
			if name == "" {
				name = "skill-" + koiDigest(entryFile.Content)[:12]
			}
			if description == "" {
				description = name
			}
		}
		rebased := koiSkillRebaseFiles(dir, pkgFiles)
		license := koiSkillLicense(raw, pkgFiles, dir)
		if license == "" {
			license = source.License
		}
		candidate := koiSkillCandidate{
			Directory: relativeDir, EntryPath: strings.TrimPrefix(entry, dir+"/"),
			MetadataFormat: format, Instructions: instructions, RawMetadata: raw,
			Files: rebased, FileCount: len(rebased), Name: name, Description: description, License: license,
		}
		oversizeFile := ""
		for _, file := range rebased {
			candidate.SizeBytes += file.SizeBytes
			if oversizeFile == "" && (file.SizeBytes > koiSkillFileBytes || len(file.Content) > koiSkillFileBytes) {
				oversizeFile = file.Path
			}
		}
		switch {
		case oversizeFile != "":
			reject(name, "file_too_large", "file_too_large:"+oversizeFile)
		case candidate.FileCount > koiSkillMaxFiles:
			reject(name, "too_many_files")
		case candidate.SizeBytes > koiSkillPackageBytes:
			reject(name, "package_too_large")
		default:
			if issues := koiSkillRuntimeIssues(raw, name, description, rebased); len(issues) > 0 {
				reject(name, "invalid_runtime_metadata", issues...)
				continue
			}
			candidate.ContentSHA256 = koiSkillContentDigest(rebased)
			candidate.Compatibility = source.Review.contentCompatibility(candidate.ContentSHA256, koiSkillCompatibilityFor(raw), koiSkillEntryDigest(instructions))
			if !candidate.Compatibility.Conversation {
				reject(name, "incompatible", candidate.Compatibility.Reasons...)
				continue
			}
			candidate.ID = "sk-" + koiDigest([]byte(candidate.Directory + ":" + candidate.ContentSHA256))[:16]
			candidates = append(candidates, candidate)
		}
	}
	return candidates, rejected
}

// Derive a display name without changing the original source directory.
func koiSlugFromText(text string) string {
	var builder strings.Builder
	pendingHyphen := false
	for _, char := range strings.ToLower(text) {
		switch {
		case unicode.IsLetter(char) || unicode.IsDigit(char):
			if pendingHyphen && builder.Len() > 0 {
				builder.WriteByte('-')
			}
			pendingHyphen = false
			builder.WriteRune(char)
		default:
			pendingHyphen = true
		}
		if builder.Len() >= koiSkillNameMaxRunes {
			break
		}
	}
	return strings.Trim(builder.String(), "-")
}
