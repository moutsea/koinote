package server

import (
	"context"
	"log"
	"time"
)

const (
	wechatImageUploadCacheTTL   = 30 * 24 * time.Hour
	wechatImageUploadCacheLimit = 2000
	wechatImageCacheDBTimeout   = 2 * time.Second
)

func (a *App) loadWechatImageUploadCache(ctx context.Context, account wechatOfficialAccountRef, appID string, hashes []string) map[string]string {
	cache := make(map[string]string)
	cacheContext, cancel := context.WithTimeout(ctx, wechatImageCacheDBTimeout)
	defer cancel()
	rows, err := a.db.Query(cacheContext, `
		SELECT cached.image_sha256, cached.image_url
		FROM wechat_image_upload_cache cached
		JOIN wechat_official_accounts account ON account.account_id = cached.account_id
		WHERE account.user_id = $1 AND cached.account_id = $2
			AND account.app_id = $3 AND cached.app_id = $3
			AND cached.image_sha256 = ANY($4::text[])
			AND cached.uploaded_at > $5
	`, account.UserID, account.AccountID, appID, hashes, time.Now().Add(-wechatImageUploadCacheTTL))
	if err != nil {
		log.Printf("wechat image upload cache read: %v", err)
		return cache
	}
	defer rows.Close()
	for rows.Next() {
		var hash, imageURL string
		if err := rows.Scan(&hash, &imageURL); err != nil {
			log.Printf("wechat image upload cache scan: %v", err)
			return cache
		}
		if imageURL != "" {
			cache[hash] = imageURL
		}
	}
	if err := rows.Err(); err != nil {
		log.Printf("wechat image upload cache read: %v", err)
	}
	return cache
}

func (a *App) storeWechatImageUploadCache(ctx context.Context, account wechatOfficialAccountRef, appID, hash, imageURL string) {
	cacheContext, cancel := context.WithTimeout(ctx, wechatImageCacheDBTimeout)
	defer cancel()
	_, err := a.db.Exec(cacheContext, `
		INSERT INTO wechat_image_upload_cache (account_id, app_id, image_sha256, image_url)
		SELECT account_id, app_id, $4, $5
		FROM wechat_official_accounts
		WHERE user_id = $1 AND account_id = $2 AND app_id = $3
		ON CONFLICT (account_id, app_id, image_sha256) DO UPDATE
		SET image_url = EXCLUDED.image_url, uploaded_at = now()
	`, account.UserID, account.AccountID, appID, hash, imageURL)
	if err != nil {
		log.Printf("wechat image upload cache write: %v", err)
	}
}

func (a *App) pruneWechatImageUploadCache(ctx context.Context, account wechatOfficialAccountRef) {
	cacheContext, cancel := context.WithTimeout(ctx, wechatImageCacheDBTimeout)
	defer cancel()
	_, err := a.db.Exec(cacheContext, `
		DELETE FROM wechat_image_upload_cache cached
		USING wechat_official_accounts account
		WHERE account.account_id = cached.account_id
			AND account.user_id = $1 AND cached.account_id = $2
			AND (cached.uploaded_at <= $3 OR (cached.app_id, cached.image_sha256) IN (
				SELECT app_id, image_sha256 FROM wechat_image_upload_cache
				WHERE account_id = $2
				ORDER BY uploaded_at DESC, app_id, image_sha256
				OFFSET $4
			))
	`, account.UserID, account.AccountID, time.Now().Add(-wechatImageUploadCacheTTL), wechatImageUploadCacheLimit)
	if err != nil {
		log.Printf("wechat image upload cache prune: %v", err)
	}
}
