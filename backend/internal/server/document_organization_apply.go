package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"koinote/backend/internal/httpx"
)

func (a *App) documentOrganizationApply(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var input struct {
		Items  []organizationChoice `json:"items"`
		Orders []organizationOrder  `json:"orders"`
	}
	if !decodeOrganizationRequest(w, r, &input, 2<<20) {
		return
	}
	id := r.PathValue("organizationId")
	if !validUUID(id) {
		writeOrganizationError(w, pgx.ErrNoRows)
		return
	}
	if err := a.applyOrganization(r.Context(), user.ID, id, input.Items, input.Orders, false); err != nil {
		writeOrganizationError(w, err)
		return
	}
	view, err := a.loadOrganization(r.Context(), user.ID, id)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"organization": view})
}
func (a *App) documentOrganizationUndo(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("organizationId")
	if !validUUID(id) {
		writeOrganizationError(w, pgx.ErrNoRows)
		return
	}
	if err := a.applyOrganization(r.Context(), user.ID, id, nil, nil, true); err != nil {
		writeOrganizationError(w, err)
		return
	}
	view, err := a.loadOrganization(r.Context(), user.ID, id)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"organization": view})
}

// Validate only paths the selection reads or writes. Changes elsewhere in the
// taxonomy cannot invalidate a paid preview or prevent an unrelated undo.
func organizationFolderPathValidator(expected, current []organizationFolder) func(...string) error {
	before := make(map[string]organizationFolder, len(expected))
	after := make(map[string]organizationFolder, len(current))
	for _, f := range expected {
		before[f.ID] = f
	}
	for _, f := range current {
		after[f.ID] = f
	}
	return func(ids ...string) error {
		for _, id := range ids {
			seen := map[string]bool{}
			for id != "" {
				f, exists := before[id]
				now, present := after[id]
				if !exists || !present || f != now || seen[id] || len(seen) >= maxFolderDepth {
					return errOrganizationConflict
				}
				seen[id] = true
				id = f.ParentID
			}
		}
		return nil
	}
}

func organizationChildFolder(folders []organizationFolder, parentID, name string) (*organizationFolder, error) {
	var match *organizationFolder
	for _, f := range folders {
		if f.ParentID == parentID && f.Name == name {
			if match != nil {
				return nil, errOrganizationAmbiguousFolder
			}
			match = &f
		}
	}
	return match, nil
}

func (a *App) applyOrganization(ctx context.Context, userID int, id string, choices []organizationChoice, orders []organizationOrder, undo bool) error {
	return retryOrganizationTransaction(ctx, func() error {
		return a.applyOrganizationAttempt(ctx, userID, id, choices, orders, undo)
	})
}

func retryOrganizationTransaction(ctx context.Context, run func() error) error {
	for attempt := 0; attempt < 3; attempt++ {
		err := run()
		var databaseError *pgconn.PgError
		if !errors.As(err, &databaseError) || (databaseError.Code != "40001" && databaseError.Code != "40P01") {
			return err
		}
		if attempt == 2 {
			return errOrganizationBusy
		}
		timer := time.NewTimer(time.Duration(attempt+1) * 25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return errOrganizationBusy
}

func (a *App) applyOrganizationAttempt(ctx context.Context, userID int, id string, choices []organizationChoice, orders []organizationOrder, undo bool) error {
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return err
	}
	var raw []byte
	var status string
	err = tx.QueryRow(ctx, `SELECT status,data FROM document_organizations WHERE user_id=$1 AND organization_id=$2::uuid FOR UPDATE`, userID, id).Scan(&status, &raw)
	if err != nil {
		return err
	}
	var data organizationData
	if err = json.Unmarshal(raw, &data); err != nil {
		return err
	}
	selected := map[string]organizationChoice{}
	if !undo {
		if len(choices) == 0 {
			return errOrganizationInput
		}
		for _, choice := range choices {
			if _, exists := selected[choice.DocID]; exists {
				return errOrganizationInput
			}
			normalized, e := validateOrganizationChoice(choice, data.Folders)
			if e != nil {
				return e
			}
			if !slices.ContainsFunc(data.Items, func(item organizationItem) bool { return item.DocID == choice.DocID && item.Suggested != nil }) {
				return errOrganizationInput
			}
			selected[choice.DocID] = normalized
		}
	}
	if !undo {
		orders, err = normalizeOrganizationOrders(orders, data, selected)
		if err != nil {
			return err
		}
	}
	// Resume a lost response only when the retried selection is the same.
	if !undo && status == "applied" {
		stored := map[string]organizationChoice{}
		for _, item := range data.Items {
			if (item.AppliedVersion != nil || item.ApplySkipped) && item.Suggested != nil {
				stored[item.DocID] = *item.Suggested
			}
		}
		if len(stored) != len(choices) || !reflect.DeepEqual(data.AppliedOrders, orders) {
			return errOrganizationConflict
		}
		for _, choice := range choices {
			normalized, validationErr := validateOrganizationChoice(choice, data.Folders)
			if validationErr != nil || !reflect.DeepEqual(stored[choice.DocID], normalized) {
				return errOrganizationConflict
			}
			delete(stored, choice.DocID)
		}
		return nil
	}
	if undo && status == "undone" {
		return nil
	}
	if (!undo && status != "ready") || (undo && status != "applied") {
		return errOrganizationConflict
	}
	if undo {
		lastMutation, _, e := loadLastOrganizationMutation(ctx, tx, userID)
		err = e
		if err != nil {
			return err
		}
		if lastMutation.ID != id {
			return errOrganizationConflict
		}
	}
	folders, err := loadOrganizationFolders(ctx, tx, userID)
	if err != nil {
		return err
	}
	if undo {
		folders, err = restoreOrganizationTimeFolders(ctx, tx, userID, data, folders)
		if err != nil {
			return err
		}
	}
	expectedFolders := append([]organizationFolder{}, data.Folders...)
	if undo {
		expectedFolders = append(expectedFolders, data.CreatedFolders...)
	}
	// Lock and validate every affected document before creating any folders.
	validateFolderPaths := organizationFolderPathValidator(expectedFolders, folders)
	type currentDocument struct {
		folderID  string
		sortOrder int64
	}
	currentDocuments := map[string]currentDocument{}
	for i, item := range data.Items {
		choice, chosen := selected[item.DocID]
		if (!undo && !chosen) || (undo && item.AppliedVersion == nil) {
			continue
		}
		var revision, version int64
		var trashed bool
		var current currentDocument
		err = tx.QueryRow(ctx, `SELECT d.revision,d.organization_version,d.trashed_at IS NOT NULL,COALESCE(f.folder_id,''),d.sort_order FROM documents d LEFT JOIN folders f ON f.id=d.folder_id WHERE d.user_id=$1 AND d.doc_id=$2 FOR UPDATE OF d`, userID, item.DocID).Scan(&revision, &version, &trashed, &current.folderID, &current.sortOrder)
		if err == pgx.ErrNoRows {
			if undo {
				data.Items[i].UndoSkipped = true
				continue
			}
			return errOrganizationConflict
		}
		if err != nil {
			return err
		}
		if !undo && trashed {
			data.Items[i].ApplySkipped = true
			data.Items[i].Suggested = &choice
			continue
		}
		if undo && version != *item.AppliedVersion {
			// Preserve later manual classifications without preventing the rest
			// of this run from being undone. Persist the outcome for retries.
			data.Items[i].UndoSkipped = true
			continue
		}
		destinationID := choice.FolderID
		if undo {
			if item.Suggested == nil {
				return errOrganizationConflict
			}
			destinationID = item.Suggested.FolderID
			for _, name := range item.Suggested.NewFolders {
				child, e := organizationChildFolder(expectedFolders, destinationID, name)
				if e != nil || child == nil {
					return errOrganizationConflict
				}
				destinationID = child.ID
			}
		}
		if err := validateFolderPaths(item.FolderID, destinationID); err != nil {
			if undo {
				data.Items[i].UndoSkipped = true
				continue
			}
			return err
		}
		if !undo && (revision != item.Revision || version != item.Version) {
			return errOrganizationConflict
		}
		currentDocuments[item.DocID] = current
	}
	if !undo && len(currentDocuments) == 0 {
		return errOrganizationNoActiveDocuments
	}
	if !undo {
		if err := validateOrganizationOrderAnchors(ctx, tx, userID, data, orders, selected); err != nil {
			return err
		}
		if err := captureOrganizationOriginalOrders(ctx, tx, userID, &data, orders, selected); err != nil {
			return err
		}
	}
	var undoPositions map[string]bool
	if undo {
		undoPositions, err = organizationUndoPositions(ctx, tx, userID, data)
		if err != nil {
			return err
		}
	}
	// Restore earlier original positions first, so later insertions cannot shift
	// a document that was already restored to its original position.
	indices := make([]int, len(data.Items))
	for i := range indices {
		indices[i] = i
	}
	if undo {
		slices.SortStableFunc(indices, func(a, b int) int {
			left, right := data.Items[a], data.Items[b]
			if left.FolderID < right.FolderID {
				return -1
			}
			if left.FolderID > right.FolderID {
				return 1
			}
			if left.SortOrder < right.SortOrder {
				return -1
			}
			if left.SortOrder > right.SortOrder {
				return 1
			}
			return 0
		})
	}
	for _, i := range indices {
		item := data.Items[i]
		choice, chosen := selected[item.DocID]
		if (!undo && (!chosen || item.ApplySkipped)) || (undo && (item.AppliedVersion == nil || item.UndoSkipped)) {
			continue
		}
		if undo {
			current := currentDocuments[item.DocID]
			order := current.sortOrder
			_, explicitlyOrdered := undoPositions[item.DocID]
			restorePosition := current.folderID != item.FolderID

			if restorePosition {
				order = item.SortOrder
				if explicitlyOrdered {
					// Restore classification even after manual sorting. Append first;
					// relative positions are restored separately when still safe.
					if err := tx.QueryRow(ctx, `SELECT COALESCE(max(sort_order)+1,0) FROM documents WHERE user_id=$1 AND folder_id IS NOT DISTINCT FROM (SELECT id FROM folders WHERE user_id=$1 AND folder_id=$2) AND trashed_at IS NULL`, userID, item.FolderID).Scan(&order); err != nil {
						return err
					}
				}
				// Make room instead of assigning an ordinal a later document occupies.
				// Do not alter sibling order when undo only restores tags.
				_, err = tx.Exec(ctx, `UPDATE documents SET sort_order=sort_order+1 WHERE user_id=$1 AND doc_id<>$2 AND folder_id IS NOT DISTINCT FROM (SELECT id FROM folders WHERE user_id=$1 AND folder_id=$3) AND sort_order >= $4`, userID, item.DocID, item.FolderID, order)
				if err != nil {
					return err
				}
			}
			_, err = tx.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE user_id=$1 AND folder_id=$3),
                sort_order=CASE WHEN $7 THEN $4 ELSE sort_order END,
                tags=$5,organized_at=$6,updated_at=CASE WHEN folder_id IS DISTINCT FROM (SELECT id FROM folders WHERE user_id=$1 AND folder_id=$3) OR tags IS DISTINCT FROM $5 THEN now() ELSE updated_at END WHERE user_id=$1 AND doc_id=$2`, userID, item.DocID, item.FolderID, order, item.Tags, item.OrganizedAt, restorePosition)
		} else {
			folderID := choice.FolderID
			for _, name := range choice.NewFolders {
				// Reuse siblings created earlier in this transaction; never merge distinct
				// pre-existing folders merely because their display names happen to match.
				expected, e := organizationChildFolder(expectedFolders, folderID, name)
				if e != nil {
					return e
				}
				match, e := organizationChildFolder(folders, folderID, name)
				if e != nil || !reflect.DeepEqual(expected, match) {
					// A concurrently created or renamed matching child is relevant,
					// even though unrelated sibling changes are allowed.
					return errOrganizationConflict
				}
				if match != nil {
					folderID = match.ID
					continue
				}
				nextID, e := randomUUID()
				if e != nil {
					return e
				}
				_, e = tx.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name,parent_id) VALUES($1,$2,$3,(SELECT id FROM folders WHERE user_id=$2 AND folder_id=$4))`, nextID, userID, name, folderID)
				if e != nil {
					return e
				}
				f := organizationFolder{nextID, name, folderID}
				folders = append(folders, f)
				expectedFolders = append(expectedFolders, f)
				data.CreatedFolders = append(data.CreatedFolders, f)
				folderID = nextID
			}
			var version int64
			err = tx.QueryRow(ctx, `WITH destination AS (SELECT id FROM folders WHERE user_id=$1 AND folder_id=$3)
    UPDATE documents d SET folder_id=(SELECT id FROM destination),
      sort_order=CASE WHEN d.folder_id IS NOT DISTINCT FROM (SELECT id FROM destination) THEN d.sort_order ELSE
        COALESCE((SELECT max(sort_order)+1 FROM documents WHERE user_id=$1 AND folder_id IS NOT DISTINCT FROM (SELECT id FROM destination) AND trashed_at IS NULL),0) END,
      tags=$4,organized_at=now(),updated_at=CASE WHEN d.folder_id IS DISTINCT FROM (SELECT id FROM destination) OR d.tags IS DISTINCT FROM $4 THEN now() ELSE d.updated_at END WHERE d.user_id=$1 AND d.doc_id=$2 RETURNING organization_version`, userID, item.DocID, folderID, choice.Tags).Scan(&version)
			data.Items[i].AppliedVersion = &version
			data.Items[i].Suggested = &choice
		}
		if err != nil {
			return err
		}
	}
	if !undo {
		if err := applyOrganizationOrders(ctx, tx, userID, &data, orders, selected, folders); err != nil {
			return err
		}
		data.AppliedOrders = orders
	}
	if undo {
		if err := undoOrganizationOrders(ctx, tx, userID, data, undoPositions); err != nil {
			return err
		}
		// Only remove unchanged, empty folders created by this run. Purging a
		// document removes its item, so these paths may not have been checked above.
		// Preserve repurposed folders without blocking the remaining documents' undo.
		for i := len(data.CreatedFolders) - 1; i >= 0; i-- {
			if validateFolderPaths(data.CreatedFolders[i].ID) != nil {
				continue
			}
			_, err = tx.Exec(ctx, `DELETE FROM folders f WHERE user_id=$1 AND folder_id=$2 AND NOT EXISTS(SELECT 1 FROM documents WHERE folder_id=f.id) AND NOT EXISTS(SELECT 1 FROM folders WHERE parent_id=f.id)`, userID, data.CreatedFolders[i].ID)
			if err != nil {
				return err
			}
		}
		status = "undone"
	} else {
		if err := pruneOrganizationTimeFolders(ctx, tx, userID, &data); err != nil {
			return err
		}
		status = "applied"
	}
	raw, err = json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE document_organizations SET status=$3,data=$4::jsonb,updated_at=clock_timestamp() WHERE user_id=$1 AND organization_id=$2::uuid`, userID, id, status, string(raw))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
