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

func loadOrganizationTimeFolders(ctx context.Context, db organizationQuerier, userID int, expected []organizationFolder) ([]organizationTimeFolder, error) {
	current, err := loadOrganizationFolders(ctx, db, userID)
	if err != nil {
		return nil, err
	}
	validate := organizationFolderPathValidator(expected, current)
	rows, err := db.Query(ctx, `SELECT f.folder_id,f.name,COALESCE(p.folder_id,''),f.created_at,f.updated_at,
        (SELECT count(*) FROM documents d WHERE d.user_id=$1 AND d.folder_id=f.id)
        FROM folders f LEFT JOIN folders p ON p.id=f.parent_id
        WHERE f.user_id=$1 AND f.organizer_kind='smart' ORDER BY f.folder_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []organizationTimeFolder{}
	for rows.Next() {
		var folder organizationTimeFolder
		if err := rows.Scan(&folder.ID, &folder.Name, &folder.ParentID, &folder.CreatedAt, &folder.UpdatedAt, &folder.DocumentCount); err != nil {
			return nil, err
		}
		if organizationCalendarName.MatchString(strings.TrimSpace(folder.Name)) && validate(folder.ID) == nil {
			result = append(result, folder)
		}
	}
	return result, rows.Err()
}

func pruneOrganizationTimeFolders(ctx context.Context, tx pgx.Tx, userID int, data *organizationData) error {
	folders, err := loadOrganizationTimeFolders(ctx, tx, userID, data.Folders)
	if err != nil {
		return err
	}
	// Delete children before parents. Recheck actual occupancy in the same
	// serializable transaction, including trash and documents outside this run.
	depths := make(map[string]int, len(folders))
	for _, folder := range folders {
		path, _ := organizationFolderPath(data.Folders, folder.ID)
		depths[folder.ID] = len(path)
	}
	slices.SortStableFunc(folders, func(a, b organizationTimeFolder) int {
		return depths[b.ID] - depths[a.ID]
	})
	for _, folder := range folders {
		if folder.DocumentCount > 0 {
			continue
		}
		result, err := tx.Exec(ctx, `DELETE FROM folders f WHERE f.user_id=$1 AND f.folder_id=$2 AND f.organizer_kind='smart'
            AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.folder_id=f.id)
            AND NOT EXISTS(SELECT 1 FROM folders child WHERE child.parent_id=f.id)`, userID, folder.ID)
		if err != nil {
			return err
		}
		if result.RowsAffected() == 1 {
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
		result, err := tx.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name,parent_id,organizer_kind,created_at,updated_at)
            VALUES($1,$2,$3,(SELECT id FROM folders WHERE user_id=$2 AND folder_id=$4),'smart',$5,$6)
            ON CONFLICT(folder_id) DO NOTHING`, folder.ID, userID, folder.Name, folder.ParentID, folder.CreatedAt, folder.UpdatedAt)
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
