package server

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
)

// Resolve existing prefixes exactly as the preview does, without creating folders.
func organizationOrderDestination(folderID string, names []string, folders []organizationFolder) (string, []string, error) {
	for i, name := range names {
		child, err := organizationChildFolder(folders, folderID, name)
		if err != nil {
			return "", nil, err
		}
		if child == nil {
			return folderID, names[i:], nil
		}
		folderID = child.ID
	}
	return folderID, []string{}, nil
}
func organizationOrderKey(folderID string, names []string) string {
	raw, _ := json.Marshal(struct {
		ID    string
		Names []string
	}{folderID, names})
	return string(raw)
}
func normalizeOrganizationOrders(orders []organizationOrder, data organizationData, selected map[string]organizationChoice) ([]organizationOrder, error) {
	if len(orders) == 0 {
		return nil, nil
	}
	if len(orders) > len(data.Items) {
		return nil, errOrganizationInput
	}
	items := map[string]organizationItem{}
	for _, item := range data.Items {
		items[item.DocID] = item
	}
	directories, seen := map[string]bool{}, map[string]bool{}
	result := make([]organizationOrder, 0, len(orders))
	for _, order := range orders {
		choice, err := validateOrganizationChoice(organizationChoice{FolderID: order.FolderID, NewFolders: order.NewFolders}, data.Folders)
		if err != nil {
			return nil, err
		}
		folderID, names, err := organizationOrderDestination(choice.FolderID, choice.NewFolders, data.Folders)
		if err != nil {
			return nil, err
		}
		key := organizationOrderKey(folderID, names)
		if directories[key] || len(order.DocIDs) == 0 || len(order.DocIDs) > len(items) {
			return nil, errOrganizationInput
		}
		directories[key] = true
		hasSelected := false
		for _, docID := range order.DocIDs {
			item, exists := items[docID]
			if !exists || seen[docID] {
				return nil, errOrganizationInput
			}
			seen[docID] = true
			target := organizationChoice{FolderID: item.FolderID}
			if chosen, ok := selected[docID]; ok {
				target = chosen
				hasSelected = true
			}
			targetID, targetNames, err := organizationOrderDestination(target.FolderID, target.NewFolders, data.Folders)
			if err != nil {
				return nil, err
			}
			if organizationOrderKey(targetID, targetNames) != key {
				return nil, errOrganizationInput
			}
		}
		if !hasSelected {
			return nil, errOrganizationInput
		}
		result = append(result, organizationOrder{folderID, names, slices.Clone(order.DocIDs)})
	}
	return result, nil
}

// Reordering reads unselected siblings as anchors. Lock and check their location
// while allowing unrelated content/tag edits and trashed anchors. Relative anchor
// order is checked by mergeOrganizationOrder after moving the selected documents.
func validateOrganizationOrderAnchors(ctx context.Context, tx pgx.Tx, userID int, data organizationData, orders []organizationOrder, selected map[string]organizationChoice) error {
	expected := map[string]organizationItem{}
	for _, item := range data.Items {
		expected[item.DocID] = item
	}
	for _, order := range orders {
		for _, docID := range order.DocIDs {
			if _, chosen := selected[docID]; chosen {
				continue
			}
			var folderID string
			var trashed bool
			err := tx.QueryRow(ctx, `SELECT COALESCE(f.folder_id,''),d.trashed_at IS NOT NULL FROM documents d LEFT JOIN folders f ON f.id=d.folder_id WHERE d.user_id=$1 AND d.doc_id=$2 FOR UPDATE OF d`, userID, docID).Scan(&folderID, &trashed)
			if err == pgx.ErrNoRows {
				return errOrganizationConflict
			}
			if err != nil {
				return err
			}
			item := expected[docID]
			if !trashed && folderID != item.FolderID {
				return errOrganizationConflict
			}
		}
	}
	return nil
}

// Move selected siblings around fixed anchors. Documents outside the preview
// and unchecked documents retain their relative order.
func mergeOrganizationOrder(current, requested []string, selected map[string]organizationChoice) ([]string, error) {
	present, moving := map[string]bool{}, map[string]bool{}
	for _, id := range current {
		present[id] = true
	}
	anchors := []string{}
	for _, id := range requested {
		if !present[id] {
			continue
		} // A document trashed since preview is skipped.
		if _, ok := selected[id]; ok {
			moving[id] = true
		} else {
			anchors = append(anchors, id)
		}
	}
	currentAnchors := []string{}
	result := make([]string, 0, len(current))
	anchorSet := map[string]bool{}
	for _, id := range anchors {
		anchorSet[id] = true
	}
	for _, id := range current {
		if anchorSet[id] {
			currentAnchors = append(currentAnchors, id)
		}
		if !moving[id] {
			result = append(result, id)
		}
	}
	if !slices.Equal(anchors, currentAnchors) {
		return nil, errOrganizationInput
	}
	cursor := len(result)
	for i := len(requested) - 1; i >= 0; i-- {
		id := requested[i]
		if !present[id] {
			continue
		}
		if moving[id] {
			result = slices.Insert(result, cursor, id)
		} else {
			cursor = slices.Index(result, id)
		}
	}
	return result, nil
}
func applyOrganizationOrders(ctx context.Context, tx pgx.Tx, userID int, data *organizationData, orders []organizationOrder, selected map[string]organizationChoice, folders []organizationFolder) error {
	for _, order := range orders {
		// A destination whose selected documents were all trashed need not exist.
		active := false
		for _, item := range data.Items {
			if item.AppliedVersion != nil && slices.Contains(order.DocIDs, item.DocID) {
				active = true
				break
			}
		}
		if !active {
			continue
		}
		folderID, remaining, err := organizationOrderDestination(order.FolderID, order.NewFolders, folders)
		if err != nil {
			return err
		}
		if len(remaining) > 0 {
			return errOrganizationConflict
		}
		current, err := loadOrganizationFolderOrder(ctx, tx, userID, folderID)
		if err != nil {
			return err
		}
		ordered, err := mergeOrganizationOrder(current, order.DocIDs, selected)
		if errors.Is(err, errOrganizationInput) {
			// Orders were already validated. A different fixed-anchor sequence
			// means the preview is stale, not that the choices are malformed.
			return errOrganizationConflict
		}
		if err != nil {
			return err
		}
		if err := writeOrganizationFolderOrder(ctx, tx, userID, ordered); err != nil {
			return err
		}
		data.ResultOrders = append(data.ResultOrders, organizationFolderOrder{folderID, ordered})
	}
	return nil
}

func loadOrganizationFolderOrder(ctx context.Context, tx pgx.Tx, userID int, folderID string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT doc_id FROM documents WHERE user_id=$1 AND folder_id IS NOT DISTINCT FROM (SELECT id FROM folders WHERE user_id=$1 AND folder_id=$2) AND trashed_at IS NULL ORDER BY sort_order,doc_id FOR UPDATE`, userID, folderID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func writeOrganizationFolderOrder(ctx context.Context, tx pgx.Tx, userID int, ordered []string) error {
	_, err := tx.Exec(ctx, `WITH desired AS (SELECT doc_id,ordinality-1 AS position FROM unnest($2::text[]) WITH ORDINALITY AS x(doc_id,ordinality)) UPDATE documents d SET sort_order=desired.position FROM desired WHERE d.user_id=$1 AND d.doc_id=desired.doc_id AND d.sort_order IS DISTINCT FROM desired.position`, userID, ordered)
	return err
}

// Snapshot the original siblings of explicitly ordered documents before any
// moves. This lets undo restore relative positions without displacing new docs.
func captureOrganizationOriginalOrders(ctx context.Context, tx pgx.Tx, userID int, data *organizationData, orders []organizationOrder, selected map[string]organizationChoice) error {
	ordered := map[string]bool{}
	for _, order := range orders {
		for _, id := range order.DocIDs {
			ordered[id] = true
		}
	}
	seen := map[string]bool{}
	for _, item := range data.Items {
		if _, chosen := selected[item.DocID]; !chosen || !ordered[item.DocID] || item.ApplySkipped || seen[item.FolderID] {
			continue
		}
		seen[item.FolderID] = true
		ids, err := loadOrganizationFolderOrder(ctx, tx, userID, item.FolderID)
		if err != nil {
			return err
		}
		data.OriginalOrders = append(data.OriginalOrders, organizationFolderOrder{item.FolderID, ids})
	}
	return nil
}

// Ignore inserted/deleted siblings and ordinal renumbering. A document's
// position is unchanged only if its relation to every remaining peer is intact.
func unchangedOrganizationPositions(before, current []string) map[string]bool {
	positions := map[string]int{}
	for i, id := range current {
		positions[id] = i
	}
	common := []string{}
	for _, id := range before {
		if _, ok := positions[id]; ok {
			common = append(common, id)
		}
	}
	unchanged := map[string]bool{}
	maxBefore := -1
	for _, id := range common {
		unchanged[id] = positions[id] > maxBefore
		maxBefore = max(maxBefore, positions[id])
	}
	minAfter := len(current)
	for i := len(common) - 1; i >= 0; i-- {
		id := common[i]
		unchanged[id] = unchanged[id] && positions[id] < minAfter
		minAfter = min(minAfter, positions[id])
	}
	return unchanged
}

func organizationUndoPositions(ctx context.Context, tx pgx.Tx, userID int, data organizationData) (map[string]bool, error) {
	positions := map[string]bool{}
	for _, order := range data.AppliedOrders {
		for _, id := range order.DocIDs {
			positions[id] = false
		}
	}
	for _, snapshot := range data.ResultOrders {
		current, err := loadOrganizationFolderOrder(ctx, tx, userID, snapshot.FolderID)
		if err != nil {
			return nil, err
		}
		for id, unchanged := range unchangedOrganizationPositions(snapshot.DocIDs, current) {
			if _, ordered := positions[id]; ordered {
				positions[id] = unchanged
			}
		}
	}
	return positions, nil
}

func undoOrganizationOrders(ctx context.Context, tx pgx.Tx, userID int, data organizationData, positions map[string]bool) error {
	selected := map[string]organizationChoice{}
	for _, item := range data.Items {
		if item.AppliedVersion != nil && !item.UndoSkipped && positions[item.DocID] {
			selected[item.DocID] = organizationChoice{}
		}
	}
	if len(selected) == 0 {
		return nil
	}
	for _, snapshot := range data.OriginalOrders {
		if !slices.ContainsFunc(snapshot.DocIDs, func(id string) bool { _, ok := selected[id]; return ok }) {
			continue
		}
		current, err := loadOrganizationFolderOrder(ctx, tx, userID, snapshot.FolderID)
		if err != nil {
			return err
		}
		ordered, err := mergeOrganizationOrder(current, snapshot.DocIDs, selected)
		if errors.Is(err, errOrganizationInput) {
			// Manual changes to the fixed anchors take precedence over restoring
			// positions. The directory/tag undo remains valid.
			continue
		}
		if err != nil {
			return err
		}
		if !slices.Equal(current, ordered) {
			if err := writeOrganizationFolderOrder(ctx, tx, userID, ordered); err != nil {
				return err
			}
		}
	}
	return nil
}
