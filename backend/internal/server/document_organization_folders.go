package server

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type organizationTimeFolder struct {
	organizationFolder
	// Empty in snapshots saved before activity buckets were also obsolete.
	Kind string `json:"kind,omitempty"`
	// Manual marks a user folder removed because this run emptied it.
	Manual        bool      `json:"manual,omitempty"`
	DocumentCount int       `json:"documentCount"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// Match calendar labels produced by the built-in organizer in supported
// locales, and require its provenance separately. A manually named date folder
// or an automatic folder renamed to a topic must not be cleaned up.
var organizationCalendarName = regexp.MustCompile(`(?i)^(?:` +
	`[0-9]{4}年[0-9]{1,2}月|[0-9]{4}-[0-9]{2}|第\s*[1-5]\s*[周週]|(?:week|semaine) [1-5]|[0-9]{1,2}月[0-9]{1,2}日|` +
	`(?:january|february|march|april|may|june|july|august|september|october|november|december|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre) [0-9]{4}|` +
	`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec) [0-9]{1,2}|[0-9]{1,2} (?:janv\.|févr\.|mars|avr\.|mai|juin|juil\.|août|sept\.|oct\.|nov\.|déc\.)|` +
	`日期未知|日付不明|unknown date|date inconnue)$`)

// Recency labels produced by the activity strategy in supported locales.
var organizationActivityName = regexp.MustCompile(`(?i)^(?:` +
	`最近 7 天|8–30 天|31–90 天|91–365 天|一年以上|最近 7 日|8〜30 日|31〜90 日|91〜365 日|1 年以上|` +
	`last 7 days|8–30 days|31–90 days|91–365 days|over one year|` +
	`7 derniers jours|8–30 jours|31–90 jours|91–365 jours|plus d’un an)$`)

func organizationObsoleteFolderName(kind, name string) bool {
	name = strings.TrimSpace(name)
	return (kind == "smart" && organizationCalendarName.MatchString(name)) ||
		(kind == "activity" && organizationActivityName.MatchString(name))
}

// Automatic date/recency buckets that still carry their generated label. They
// are never valid destinations: AI organization re-files their documents by
// topic and removes the buckets once they are empty.
func loadOrganizationTimeFolders(ctx context.Context, db organizationQuerier, userID int, expected []organizationFolder) ([]organizationTimeFolder, error) {
	current, err := loadOrganizationFolders(ctx, db, userID)
	if err != nil {
		return nil, err
	}
	validate := organizationFolderPathValidator(expected, current)
	rows, err := db.Query(ctx, `SELECT f.folder_id,f.name,COALESCE(p.folder_id,''),f.organizer_kind,f.created_at,f.updated_at,
        (SELECT count(*) FROM documents d WHERE d.user_id=$1 AND d.folder_id=f.id)
        FROM folders f LEFT JOIN folders p ON p.id=f.parent_id
        WHERE f.user_id=$1 AND f.organizer_kind IS NOT NULL ORDER BY f.folder_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []organizationTimeFolder{}
	for rows.Next() {
		var folder organizationTimeFolder
		if err := rows.Scan(&folder.ID, &folder.Name, &folder.ParentID, &folder.Kind, &folder.CreatedAt, &folder.UpdatedAt, &folder.DocumentCount); err != nil {
			return nil, err
		}
		if organizationObsoleteFolderName(folder.Kind, folder.Name) && validate(folder.ID) == nil {
			result = append(result, folder)
		}
	}
	return result, rows.Err()
}

func organizationObsoleteFolderIDs(folders []organizationTimeFolder) map[string]bool {
	ids := make(map[string]bool, len(folders))
	for _, folder := range folders {
		ids[folder.ID] = true
	}
	return ids
}

// organizationInObsoleteBranch reports whether a folder is an obsolete bucket
// or nested anywhere inside one; such a destination would keep the bucket.
func organizationInObsoleteBranch(folders []organizationFolder, obsolete map[string]bool, id string) bool {
	for seen := 0; id != "" && seen <= maxFolderDepth; seen++ {
		if obsolete[id] {
			return true
		}
		i := slices.IndexFunc(folders, func(f organizationFolder) bool { return f.ID == id })
		if i < 0 {
			return false
		}
		id = folders[i].ParentID
	}
	return false
}

// retargetOrganizationChoice moves a destination out of obsolete buckets.
// Obsolete levels are dropped from the path; the remaining folder names below
// the topmost bucket become new folders under that bucket's parent, so
// "2026年9月/AI行业动态" becomes "AI行业动态" at the bucket's level. It returns
// false when nothing remains, i.e. the model only kept the time bucket.
func retargetOrganizationChoice(choice organizationChoice, folders []organizationFolder, obsolete map[string]bool) (organizationChoice, bool) {
	if !organizationInObsoleteBranch(folders, obsolete, choice.FolderID) {
		return choice, true
	}
	var chain []organizationFolder
	for id := choice.FolderID; id != "" && len(chain) <= maxFolderDepth; {
		i := slices.IndexFunc(folders, func(f organizationFolder) bool { return f.ID == id })
		if i < 0 {
			break
		}
		chain = append(chain, folders[i])
		id = folders[i].ParentID
	}
	slices.Reverse(chain)
	top := slices.IndexFunc(chain, func(f organizationFolder) bool { return obsolete[f.ID] })
	names := []string{}
	for _, folder := range chain[top+1:] {
		if !obsolete[folder.ID] {
			names = append(names, folder.Name)
		}
	}
	choice.FolderID = chain[top].ParentID
	choice.NewFolders = append(names, choice.NewFolders...)
	return choice, len(choice.NewFolders) > 0
}

// pruneOrganizationFolders removes folders left empty by an applied run:
// obsolete automatic buckets, every folder a moved document came from, and
// ancestors of those folders that become empty as a consequence. Folders that
// were already empty and unrelated to this run are left alone. Occupancy is
// rechecked in the same transaction, including trash and other documents.
func pruneOrganizationFolders(ctx context.Context, tx pgx.Tx, userID int, data *organizationData, sources []string) error {
	timeFolders, err := loadOrganizationTimeFolders(ctx, tx, userID, data.Folders)
	if err != nil {
		return err
	}
	current, err := loadOrganizationFolders(ctx, tx, userID)
	if err != nil {
		return err
	}
	validate := organizationFolderPathValidator(data.Folders, current)
	rows, err := tx.Query(ctx, `SELECT f.folder_id,f.name,COALESCE(p.folder_id,''),COALESCE(f.organizer_kind,''),f.created_at,f.updated_at
        FROM folders f LEFT JOIN folders p ON p.id=f.parent_id WHERE f.user_id=$1`, userID)
	if err != nil {
		return err
	}
	meta := map[string]organizationTimeFolder{}
	for rows.Next() {
		var folder organizationTimeFolder
		if err := rows.Scan(&folder.ID, &folder.Name, &folder.ParentID, &folder.Kind, &folder.CreatedAt, &folder.UpdatedAt); err != nil {
			rows.Close()
			return err
		}
		folder.Manual = folder.Kind == ""
		meta[folder.ID] = folder
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	candidates := map[string]organizationTimeFolder{}
	for _, folder := range timeFolders {
		candidates[folder.ID] = folder
	}
	for _, id := range sources {
		// Only folders whose path is unchanged since the preview are touched.
		for depth := 0; id != "" && depth <= maxFolderDepth; depth++ {
			folder, ok := meta[id]
			if !ok || validate(id) != nil {
				break
			}
			if _, seen := candidates[id]; !seen {
				candidates[id] = folder
			}
			id = folder.ParentID
		}
	}
	folders := make([]organizationTimeFolder, 0, len(candidates))
	depths := make(map[string]int, len(candidates))
	for _, folder := range candidates {
		path, _ := organizationFolderPath(current, folder.ID)
		depths[folder.ID] = len(path)
		folders = append(folders, folder)
	}
	// Delete children before parents so emptied ancestors are seen as empty.
	slices.SortStableFunc(folders, func(a, b organizationTimeFolder) int {
		if depths[a.ID] != depths[b.ID] {
			return depths[b.ID] - depths[a.ID]
		}
		return strings.Compare(a.ID, b.ID)
	})
	for _, folder := range folders {
		result, err := tx.Exec(ctx, `DELETE FROM folders f WHERE f.user_id=$1 AND f.folder_id=$2
            AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.folder_id=f.id)
            AND NOT EXISTS(SELECT 1 FROM folders child WHERE child.parent_id=f.id)`, userID, folder.ID)
		if err != nil {
			return err
		}
		if result.RowsAffected() == 1 {
			folder.DocumentCount = 0
			data.RemovedFolders = append(data.RemovedFolders, folder)
		}
	}
	return nil
}

func restoreOrganizationTimeFolders(ctx context.Context, tx pgx.Tx, userID int, data organizationData, current []organizationFolder) ([]organizationFolder, error) {
	virtual := slices.Clone(current)
	present := map[string]bool{}
	for _, folder := range current {
		present[folder.ID] = true
	}
	for _, folder := range data.RemovedFolders {
		if !present[folder.ID] {
			virtual = append(virtual, folder.organizationFolder)
		}
	}
	validate := organizationFolderPathValidator(data.Folders, virtual)
	// Removed folders are recorded child-first, so recreate parent-first using
	// the original public IDs. Never recreate an ancestor deleted by the user.
	for i := len(data.RemovedFolders) - 1; i >= 0; i-- {
		folder := data.RemovedFolders[i]
		if present[folder.ID] || validate(folder.ID) != nil || (folder.ParentID != "" && !present[folder.ParentID]) {
			continue
		}
		var kind *string
		if !folder.Manual {
			value := folder.Kind
			if value == "" {
				value = "smart" // Snapshots saved before kinds were recorded.
			}
			kind = &value
		}
		result, err := tx.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name,parent_id,organizer_kind,created_at,updated_at)
            VALUES($1,$2,$3,(SELECT id FROM folders WHERE user_id=$2 AND folder_id=$4),$7,$5,$6)
            ON CONFLICT(folder_id) DO NOTHING`, folder.ID, userID, folder.Name, folder.ParentID, folder.CreatedAt, folder.UpdatedAt, kind)
		if err != nil {
			return nil, err
		}
		if result.RowsAffected() != 1 {
			return nil, errOrganizationConflict
		}
		present[folder.ID] = true
		current = append(current, folder.organizationFolder)
	}
	return current, nil
}

// retargetOrganizationSuggestions enforces that model output never keeps an
// obsolete bucket alive. A suggestion that only keeps the document in a bucket
// has no usable destination and becomes an unchecked item for manual review,
// which also keeps a batch of such answers free of platform credits.
func retargetOrganizationSuggestions(suggestions []organizationSuggestion, items []organizationItem, folders []organizationFolder, obsolete map[string]bool) []organizationSuggestion {
	if len(obsolete) == 0 {
		return suggestions
	}
	result := make([]organizationSuggestion, 0, len(suggestions))
	for _, s := range suggestions {
		if s.NeedsReview {
			result = append(result, s)
			continue
		}
		choice, ok := retargetOrganizationChoice(s.organizationChoice, folders, obsolete)
		if ok {
			if _, err := validateOrganizationChoice(choice, folders); err != nil {
				ok = false
			}
		}
		if !ok {
			i := slices.IndexFunc(items, func(item organizationItem) bool { return item.DocID == s.DocID })
			if i >= 0 {
				fallback := organizationFallback(items[i])
				fallback.Reason = s.Reason
				result = append(result, fallback)
				continue
			}
		}
		s.organizationChoice = choice
		result = append(result, s)
	}
	return result
}

func loadOrganizationFolderCounts(ctx context.Context, db organizationQuerier, userID int) (map[string]int, error) {
	rows, err := db.Query(ctx, `SELECT f.folder_id,(SELECT count(*) FROM documents d WHERE d.user_id=$1 AND d.folder_id=f.id)
        FROM folders f WHERE f.user_id=$1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var id string
		var count int
		if err := rows.Scan(&id, &count); err != nil {
			return nil, err
		}
		counts[id] = count
	}
	return counts, rows.Err()
}
