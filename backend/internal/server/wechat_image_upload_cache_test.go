package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func wechatCountingUploadClient(uploads *atomic.Int32) *http.Client {
	return &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		count := uploads.Add(1)
		return &http.Response{
			StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"url":"https://mmbiz.qpic.cn/image-%d.jpg"}`, count))),
		}, nil
	})}
}

func TestWechatImageUploadCacheSurvivesRestartAndTracksContent(t *testing.T) {
	app, account := newWechatImageUploadTest(t)
	ctx := context.Background()
	var uploads atomic.Int32
	app.wechatAPIHTTPClient = wechatCountingUploadClient(&uploads)
	preparations := []wechatDraftImagePreparation{
		{Source: "https://images.example.test/original.jpg", Prepared: []byte("same image")},
		{Source: "https://images.example.test/alias.jpg", Prepared: []byte("same image")},
	}
	firstURLs, err := app.uploadWechatDraftImages(ctx, account, preparations)
	if err != nil || len(firstURLs) != 2 || firstURLs[0] != firstURLs[1] || uploads.Load() != 1 {
		t.Fatalf("same-content uploads=%d URLs=%v error=%v", uploads.Load(), firstURLs, err)
	}
	restarted := New(app.cfg, app.db)
	restarted.wechatAPIHTTPClient = app.wechatAPIHTTPClient
	secondURLs, err := restarted.uploadWechatDraftImages(ctx, account, preparations)
	if err != nil || len(secondURLs) != 2 || secondURLs[0] != firstURLs[0] || secondURLs[1] != firstURLs[1] || uploads.Load() != 1 {
		t.Fatalf("cached uploads after restart=%d URLs=%v error=%v", uploads.Load(), secondURLs, err)
	}
	preparations[0].Prepared = []byte("changed content at the same URL")
	thirdURLs, err := app.uploadWechatDraftImages(ctx, account, preparations)
	if err != nil || len(thirdURLs) != 2 || thirdURLs[0] == firstURLs[0] || thirdURLs[1] != firstURLs[1] || uploads.Load() != 2 {
		t.Fatalf("changed-content uploads=%d URLs=%v error=%v", uploads.Load(), thirdURLs, err)
	}
}

func TestWechatImageUploadCacheIsolatesAccountsAndRebinding(t *testing.T) {
	app, account := newWechatImageUploadTest(t)
	otherApp, otherAccount := newWechatImageUploadTest(t)
	ctx := context.Background()
	var uploads atomic.Int32
	client := wechatCountingUploadClient(&uploads)
	app.wechatAPIHTTPClient = client
	otherApp.wechatAPIHTTPClient = client
	preparations := []wechatDraftImagePreparation{{Source: "https://images.example.test/image.jpg", Prepared: []byte("same image")}}
	firstURLs, err := app.uploadWechatDraftImages(ctx, account, preparations)
	if err != nil {
		t.Fatal(err)
	}
	_, err = app.uploadWechatDraftImages(ctx, wechatOfficialAccountRef{UserID: otherAccount.UserID, AccountID: account.AccountID}, preparations)
	if !errors.Is(err, errWechatAccountNotBound) || uploads.Load() != 1 {
		t.Fatalf("unauthorized cache access error=%v uploads=%d", err, uploads.Load())
	}
	secondURLs, err := otherApp.uploadWechatDraftImages(ctx, otherAccount, preparations)
	if err != nil || len(secondURLs) != 1 || secondURLs[0] == firstURLs[0] || uploads.Load() != 2 {
		t.Fatalf("other-account uploads=%d URLs=%v error=%v", uploads.Load(), secondURLs, err)
	}
	newAppID := "wx-rebound-" + account.AccountID
	if _, err := app.db.Exec(ctx, `UPDATE wechat_official_accounts SET app_id = $1 WHERE account_id = $2`, newAppID, account.AccountID); err != nil {
		t.Fatal(err)
	}
	app.storeWechatAccessToken(account.AccountID, wechatAccessToken{AppID: newAppID, Value: "rebound-token", ExpiresAt: time.Now().Add(time.Hour)})
	reboundURLs, err := app.uploadWechatDraftImages(ctx, account, preparations)
	if err != nil || len(reboundURLs) != 1 || reboundURLs[0] == firstURLs[0] || uploads.Load() != 3 {
		t.Fatalf("rebound uploads=%d URLs=%v error=%v", uploads.Load(), reboundURLs, err)
	}
	if _, err := app.deleteWechatOfficialAccount(ctx, account.UserID, account.AccountID); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := app.db.QueryRow(ctx, `SELECT count(*) FROM wechat_image_upload_cache WHERE account_id = $1`, account.AccountID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("cache remained after account deletion: count=%d error=%v", remaining, err)
	}
}

func TestWechatImageUploadCacheExpiresAndBoundsStorage(t *testing.T) {
	app, account := newWechatImageUploadTest(t)
	ctx := context.Background()
	var uploads atomic.Int32
	app.wechatAPIHTTPClient = wechatCountingUploadClient(&uploads)
	preparations := []wechatDraftImagePreparation{{Source: "https://images.example.test/image.jpg", Prepared: []byte("image")}}
	if _, err := app.uploadWechatDraftImages(ctx, account, preparations); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(ctx, `UPDATE wechat_image_upload_cache SET uploaded_at = $1 WHERE account_id = $2`, time.Now().Add(-wechatImageUploadCacheTTL-time.Hour), account.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := app.uploadWechatDraftImages(ctx, account, preparations); err != nil || uploads.Load() != 2 {
		t.Fatalf("expired image uploads=%d error=%v", uploads.Load(), err)
	}
	credential, err := app.loadWechatOfficialCredential(ctx, account)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(ctx, `
		INSERT INTO wechat_image_upload_cache (account_id, app_id, image_sha256, image_url, uploaded_at)
		SELECT $1, $2, md5(cache_index::text), 'https://mmbiz.qpic.cn/old.jpg', now() - cache_index * interval '1 second'
		FROM generate_series(1, $3::int) cache_index
	`, account.AccountID, credential.AppID, wechatImageUploadCacheLimit+5); err != nil {
		t.Fatal(err)
	}
	app.storeWechatImageUploadCache(ctx, account, credential.AppID, "expired", "https://mmbiz.qpic.cn/expired.jpg")
	if _, err := app.db.Exec(ctx, `UPDATE wechat_image_upload_cache SET uploaded_at = $1 WHERE account_id = $2 AND image_sha256 = 'expired'`, time.Now().Add(-wechatImageUploadCacheTTL-time.Hour), account.AccountID); err != nil {
		t.Fatal(err)
	}
	app.pruneWechatImageUploadCache(ctx, account)
	var count, expired int
	if err := app.db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE uploaded_at <= $2) FROM wechat_image_upload_cache WHERE account_id = $1`, account.AccountID, time.Now().Add(-wechatImageUploadCacheTTL)).Scan(&count, &expired); err != nil || count != wechatImageUploadCacheLimit || expired != 0 {
		t.Fatalf("cache count=%d expired=%d error=%v", count, expired, err)
	}
	if _, err := app.uploadWechatDraftImages(ctx, account, preparations); err != nil || uploads.Load() != 2 {
		t.Fatalf("recent image was evicted: uploads=%d error=%v", uploads.Load(), err)
	}
}

func TestWechatImageUploadCacheRetainsSuccessWhenBatchFails(t *testing.T) {
	app, account := newWechatImageUploadTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	thirdStarted := make(chan struct{})
	app.wechatAPIHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		file, _, err := request.FormFile("media")
		if err != nil {
			return nil, err
		}
		defer file.Close()
		body, err := io.ReadAll(file)
		if err != nil {
			return nil, err
		}
		if string(body) == "first" {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"url":"https://mmbiz.qpic.cn/retained.jpg"}`))}, nil
		}
		if string(body) == "second" {
			select {
			case <-thirdStarted:
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"errcode":40005,"errmsg":"invalid file type"}`))}, nil
			case <-request.Context().Done():
				return nil, request.Context().Err()
			}
		}
		close(thirdStarted)
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}
	preparations := []wechatDraftImagePreparation{
		{Source: "https://images.example.test/first.jpg", Prepared: []byte("first")},
		{Source: "https://images.example.test/second.jpg", Prepared: []byte("second")},
		{Source: "https://images.example.test/third.jpg", Prepared: []byte("third")},
	}
	if _, err := app.uploadWechatDraftImages(ctx, account, preparations); !errors.Is(err, errWechatContentImageFailed) {
		t.Fatalf("failed batch error=%v", err)
	}
	var retryUploads atomic.Int32
	app.wechatAPIHTTPClient = wechatCountingUploadClient(&retryUploads)
	urls, err := app.uploadWechatDraftImages(ctx, account, preparations)
	if err != nil || len(urls) != 3 || urls[0] != "https://mmbiz.qpic.cn/retained.jpg" || retryUploads.Load() != 2 {
		t.Fatalf("retry uploads=%d URLs=%v error=%v", retryUploads.Load(), urls, err)
	}
}
