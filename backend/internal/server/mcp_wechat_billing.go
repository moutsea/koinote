package server

import (
	"context"
	"errors"
)

var errMCPWechatFreeSyncRequired = errors.New("credit-free WeChat sync is not authorized")

// Grants are provisioned only by the server operator. Token names, clientInfo,
// email addresses and client-supplied flags can never confer a billing exemption.
func (a *App) mcpWechatFreeSyncFolders(ctx context.Context, p mcpPrincipal, accountID string) ([]string, error) {
	if !p.canPublish() {
		return nil, nil
	}
	rows, err := a.db.Query(ctx, `
        SELECT f.folder_id
        FROM mcp_wechat_sync_grants g
        JOIN mcp_tokens t ON t.id = g.token_id
        JOIN wechat_official_accounts w ON w.account_id = g.account_id
        JOIN folders f ON f.id = g.folder_id
        WHERE t.id = $1 AND t.user_id = $2 AND t.scope = 'publish'
          AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
          AND w.account_id = $3 AND w.user_id = t.user_id AND f.user_id = t.user_id
        ORDER BY f.folder_id
    `, p.TokenID, p.User.ID, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var folders []string
	for rows.Next() {
		var folder string
		if err := rows.Scan(&folder); err != nil {
			return nil, err
		}
		folders = append(folders, folder)
	}
	return folders, rows.Err()
}

func (a *App) mcpWechatDraftCreditFree(ctx context.Context, p mcpPrincipal, docID, accountID string, requireFree bool, coverMode string) (bool, error) {
	folders, err := a.mcpWechatFreeSyncFolders(ctx, p, accountID)
	if err != nil {
		return false, err
	}
	free := false
	if len(folders) > 0 {
		err = a.db.QueryRow(ctx, `
            SELECT EXISTS (
                SELECT 1 FROM documents d JOIN folders f ON f.id = d.folder_id
                WHERE d.doc_id = $1 AND d.user_id = $2 AND f.user_id = $2
                  AND d.trashed_at IS NULL AND f.folder_id = ANY($3::text[])
            )
        `, docID, p.User.ID, folders).Scan(&free)
		if err != nil {
			return false, err
		}
	}
	// requireFree is a fail-closed guard, not a request to grant free access.
	// It also forbids paid AI cover generation on the integration path.
	if requireFree && (!free || coverMode == wechatCoverModeAI) {
		return false, errMCPWechatFreeSyncRequired
	}
	return free, nil
}
