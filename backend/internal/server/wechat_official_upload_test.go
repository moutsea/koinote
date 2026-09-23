package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func newWechatImageUploadTest(t *testing.T) (*App, wechatOfficialAccountRef) {
	t.Helper()
	pool := newGCTestPool(t)
	app := New(config.Config{WechatCredentialEncryptionKey: "wechat-upload-test-key"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	accountID, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := app.encryptWechatCredential(user.ID, "wechat-secret")
	if err != nil {
		t.Fatal(err)
	}
	appID := "wx" + strings.ReplaceAll(accountID, "-", "")
	if _, err := app.createWechatOfficialAccount(context.Background(), user.ID, accountID, wechatOfficialAccountInput{
		AppID: appID, AppSecret: "wechat-secret",
	}, ciphertext); err != nil {
		t.Fatal(err)
	}
	app.storeWechatAccessToken(accountID, wechatAccessToken{
		AppID: appID, Value: "upload-test-token", ExpiresAt: time.Now().Add(time.Hour),
	})
	return app, wechatOfficialAccountRef{UserID: user.ID, AccountID: accountID}
}

func TestWechatDraftImageUploadsUseBoundedConcurrencyAndKeepOrder(t *testing.T) {
	app, account := newWechatImageUploadTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	preparations := make([]wechatDraftImagePreparation, wechatDraftMaxImages)
	for index := range preparations {
		preparations[index] = wechatDraftImagePreparation{
			Source: fmt.Sprintf("https://images.example.test/%d.jpg", index), Prepared: []byte(strconv.Itoa(index)),
		}
	}
	started := make(chan int, len(preparations))
	completed := make(chan int, len(preparations))
	release := make(chan struct{})
	releaseFirst := make(chan struct{})
	var active, maximum atomic.Int32
	app.wechatAPIHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for observed := maximum.Load(); current > observed; observed = maximum.Load() {
			if maximum.CompareAndSwap(observed, current) {
				break
			}
		}
		file, _, err := request.FormFile("media")
		if err != nil {
			return nil, err
		}
		defer file.Close()
		body, err := io.ReadAll(file)
		if err != nil {
			return nil, err
		}
		index, err := strconv.Atoi(string(body))
		if err != nil {
			return nil, err
		}
		started <- index
		gate := release
		if index == 0 {
			gate = releaseFirst
		}
		select {
		case <-gate:
		case <-request.Context().Done():
			return nil, request.Context().Err()
		}
		completed <- index
		return &http.Response{
			StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"url":"https://mmbiz.qpic.cn/%d.jpg"}`, index))),
		}, nil
	})}
	type uploadResult struct {
		urls []string
		err  error
	}
	done := make(chan uploadResult, 1)
	go func() {
		urls, err := app.uploadWechatDraftImages(ctx, account, preparations)
		done <- uploadResult{urls: urls, err: err}
	}()
	for index := 0; index < wechatDraftImageUploadWorkers; index++ {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("image uploads did not start concurrently")
		}
	}
	close(release)
	for index := 1; index < len(preparations); index++ {
		select {
		case finished := <-completed:
			if finished == 0 {
				t.Fatal("first image must remain pending while later images finish")
			}
		case <-ctx.Done():
			t.Fatal("later image uploads waited for the first image")
		}
	}
	close(releaseFirst)
	result := <-done
	if result.err != nil || len(result.urls) != len(preparations) {
		t.Fatalf("uploaded URLs=%v error=%v", result.urls, result.err)
	}
	if maximum.Load() != wechatDraftImageUploadWorkers {
		t.Fatalf("maximum upload concurrency=%d, want %d", maximum.Load(), wechatDraftImageUploadWorkers)
	}
	for index, uploadedURL := range result.urls {
		if want := fmt.Sprintf("https://mmbiz.qpic.cn/%d.jpg", index); uploadedURL != want {
			t.Fatalf("image %d URL=%q, want %q", index, uploadedURL, want)
		}
	}
}

func TestWechatDraftImageUploadFailureCancelsOutstandingWork(t *testing.T) {
	for _, canceledByCaller := range []bool{false, true} {
		t.Run(fmt.Sprintf("caller_canceled=%t", canceledByCaller), func(t *testing.T) {
			app, account := newWechatImageUploadTest(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			preparations := make([]wechatDraftImagePreparation, wechatDraftMaxImages)
			for index := range preparations {
				preparations[index] = wechatDraftImagePreparation{
					Source: "https://images.example.test/article.jpg?signature=private", Prepared: []byte(strconv.Itoa(index)),
				}
			}
			var uploads, cancellations atomic.Int32
			started := make(chan struct{}, len(preparations))
			releaseFailure := make(chan struct{})
			app.wechatAPIHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
				uploads.Add(1)
				file, _, err := request.FormFile("media")
				if err != nil {
					return nil, err
				}
				defer file.Close()
				body, err := io.ReadAll(file)
				if err != nil {
					return nil, err
				}
				started <- struct{}{}
				if string(body) == "1" && !canceledByCaller {
					select {
					case <-releaseFailure:
						return &http.Response{
							StatusCode: http.StatusOK, Header: make(http.Header),
							Body: io.NopCloser(strings.NewReader(`{"errcode":40005,"errmsg":"invalid file type"}`)),
						}, nil
					case <-request.Context().Done():
						return nil, request.Context().Err()
					}
				}
				<-request.Context().Done()
				cancellations.Add(1)
				return nil, request.Context().Err()
			})}
			done := make(chan error, 1)
			go func() {
				urls, err := app.uploadWechatDraftImages(ctx, account, preparations)
				if urls != nil {
					t.Error("failed upload returned partial URLs")
				}
				done <- err
			}()
			for index := 0; index < wechatDraftImageUploadWorkers; index++ {
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal("image uploads did not start concurrently")
				}
			}
			if canceledByCaller {
				cancel()
			} else {
				close(releaseFailure)
			}
			var err error
			select {
			case err = <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("pending uploads did not stop after cancellation")
			}
			if !errors.Is(err, errWechatContentImageFailed) {
				t.Fatalf("upload error=%v", err)
			}
			wantCanceled := int32(wechatDraftImageUploadWorkers)
			if canceledByCaller {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("caller cancellation was lost: %v", err)
				}
			} else {
				wantCanceled--
				var providerError *wechatProviderError
				var imageError *wechatArticleImageError
				if !errors.As(err, &providerError) || providerError.Code != 40005 ||
					!errors.As(err, &imageError) || imageError.Index != 1 || imageError.Stage != "upload" {
					t.Fatalf("original provider/image error was replaced by sibling cancellation: %v", err)
				}
				if strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "signature") {
					t.Fatalf("upload error exposed the source URL: %v", err)
				}
			}
			if uploads.Load() != wechatDraftImageUploadWorkers || cancellations.Load() != wantCanceled {
				t.Fatalf("uploads=%d canceled=%d, want uploads=%d canceled=%d", uploads.Load(), cancellations.Load(), wechatDraftImageUploadWorkers, wantCanceled)
			}
		})
	}
}

func TestWechatDraftImageTransferDeduplicatesAndPreservesCover(t *testing.T) {
	app, account := newWechatImageUploadTest(t)
	firstImage := testWechatCoverJPEG(t)
	second := image.NewRGBA(image.Rect(0, 0, 1, 1))
	second.Set(0, 0, color.RGBA{R: 240, A: 255})
	var secondImage bytes.Buffer
	if err := jpeg.Encode(&secondImage, second, nil); err != nil {
		t.Fatal(err)
	}
	rawImages := map[string][]byte{"/first.jpg": firstImage, "/second.jpg": secondImage.Bytes()}
	preparedURLs := make(map[string]string)
	for path, raw := range rawImages {
		prepared, err := prepareWechatContentImage(raw)
		if err != nil {
			t.Fatal(err)
		}
		preparedURLs[string(prepared)] = "https://mmbiz.qpic.cn" + path
	}
	var downloads, uploads atomic.Int32
	app.wechatImageHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		downloads.Add(1)
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(rawImages[request.URL.Path]))}, nil
	})}
	app.wechatAPIHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		uploads.Add(1)
		file, _, err := request.FormFile("media")
		if err != nil {
			return nil, err
		}
		defer file.Close()
		body, err := io.ReadAll(file)
		if err != nil {
			return nil, err
		}
		return &http.Response{
			StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"url":%q}`, preparedURLs[string(body)]))),
		}, nil
	})}
	content := `<p><img src="https://images.example.test/first.jpg"><img src="https://images.example.test/second.jpg"><img src="https://images.example.test/first.jpg"></p>`
	for _, selectCover := range []bool{false, true} {
		downloads.Store(0)
		uploads.Store(0)
		rewritten, cover, err := app.transferWechatDraftImagesWithCoverImage(context.Background(), account, content, selectCover, "https://images.example.test/second.jpg")
		if err != nil {
			t.Fatal(err)
		}
		if want := strings.ReplaceAll(content, "https://images.example.test", "https://mmbiz.qpic.cn"); rewritten != want {
			t.Fatalf("rewritten HTML=%q, want %q", rewritten, want)
		}
		wantCover := firstImage
		if selectCover {
			wantCover = secondImage.Bytes()
		}
		wantUploads := int32(2)
		if selectCover {
			wantUploads = 0
		}
		if !bytes.Equal(cover, wantCover) || downloads.Load() != 2 || uploads.Load() != wantUploads {
			t.Fatalf("selected cover preserved=%t downloads=%d uploads=%d", bytes.Equal(cover, wantCover), downloads.Load(), uploads.Load())
		}
	}
}
