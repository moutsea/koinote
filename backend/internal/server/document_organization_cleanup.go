package server

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/jackc/pgx/v5"
)

// The caller holds the user's advisory lock, shared with purgeDocument. The
// preparation snapshot predates that lock, so a deleted document must not be
// reintroduced by a request that was already preparing its prompts.
func validateOrganizationDocuments(ctx context.Context, tx pgx.Tx, userID int, data organizationData) error {
	// Items also cover saved data that predates input dependency tracking.
	seen := make(map[string]bool, len(data.InputDocumentIDs)+len(data.Items))
	ids := make([]string, 0, len(data.InputDocumentIDs)+len(data.Items))
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, id := range data.InputDocumentIDs {
		add(id)
	}
	for _, item := range data.Items {
		add(item.DocID)
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM documents WHERE user_id=$1 AND doc_id=ANY($2::text[])`, userID, ids).Scan(&count); err != nil {
		return err
	}
	if count != len(ids) {
		return errOrganizationConflict
	}
	return nil
}

// Scrub every saved preview and undo snapshot in the document deletion
// transaction. Keep other items and mutation timestamps intact: deleting an old
// document must not replace the latest undo target. Running jobs become failed
// before their next guarded write, preventing an in-flight model response from
// restoring the removed data.
func purgeDocumentOrganizations(ctx context.Context, tx pgx.Tx, userID int, docID string) error {
	filter, err := json.Marshal([]map[string]string{{"docId": docID}})
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT organization_id::text,status,data,reservation_id FROM document_organizations
        WHERE user_id=$1 AND (data->'items' @> $2::jsonb OR data->'inputDocumentIds' ? $3::text)
        ORDER BY organization_id FOR UPDATE`, userID, string(filter), docID)
	if err != nil {
		return err
	}
	type savedOrganization struct {
		id, status, reservation string
		raw                     []byte
	}
	var saved []savedOrganization
	for rows.Next() {
		var item savedOrganization
		if err := rows.Scan(&item.id, &item.status, &item.raw, &item.reservation); err != nil {
			rows.Close()
			return err
		}
		saved = append(saved, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, saved := range saved {
		var data organizationData
		if err := json.Unmarshal(saved.raw, &data); err != nil {
			return err
		}
		items := make([]organizationItem, 0, len(data.Items))
		completed := data.Completed
		for index, item := range data.Items {
			if item.DocID == docID {
				if index < data.Completed {
					completed--
				}
				continue
			}
			items = append(items, item)
		}
		data.Items = items
		data.Completed = completed
		data.InputDocumentIDs = slices.DeleteFunc(data.InputDocumentIDs, func(id string) bool { return id == docID })
		raw, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE document_organizations SET data=$3::jsonb,
            status=CASE WHEN status='running' THEN 'failed' ELSE status END,
            error_code=CASE WHEN status='running' THEN 'organization_document_deleted' ELSE error_code END
            WHERE user_id=$1 AND organization_id=$2::uuid`, userID, saved.id, string(raw)); err != nil {
			return err
		}
		if saved.status == "running" && saved.reservation != "" {
			if _, err := releaseCreditReservationTx(ctx, tx, userID, saved.reservation); err != nil {
				return err
			}
		}
	}
	return nil
}
