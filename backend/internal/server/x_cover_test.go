package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"strings"
	"testing"
)

func TestXArticleIndependentCover(testRunner *testing.T) {
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		testRunner.Fatal(err)
	}
	source := "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
	for _, count := range []int{0, 20} {
		testRunner.Run(fmt.Sprintf("%d body images", count), func(testRunner *testing.T) {
			var draft map[string]json.RawMessage
			uploads := 0
			app := &App{xOAuth2HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				switch request.URL.Path {
				case "/2/media/upload":
					uploads++
					return jsonResponse(fmt.Sprintf(`{"data":{"id":"%d"}}`, 1234567890123456780+uploads)), nil
				case xOAuth2ArticleDraftPath:
					if err := json.NewDecoder(request.Body).Decode(&draft); err != nil {
						testRunner.Fatal(err)
					}
					return jsonResponse(`{"data":{"id":"1146654567674912769"}}`), nil
				case "/2/articles/1146654567674912769/publish":
					return jsonResponse(`{"data":{"post_id":"1346889436626259968"}}`), nil
				default:
					return nil, fmt.Errorf("unexpected path %s", request.URL.Path)
				}
			})}}
			var body strings.Builder
			images := make([]xPublishImageInput, 0, count)
			for index := 0; index < count; index++ {
				original := fmt.Sprintf("https://example.test/body-%d.png", index)
				fmt.Fprintf(&body, "![image](%s)\n\n", original)
				images = append(images, xPublishImageInput{Source: source, OriginalSource: original})
			}
			body.WriteString("End.")
			coverSource := "data:image/png;base64," + base64.StdEncoding.EncodeToString(append(encoded.Bytes(), byte(0)))
			_, err := app.publishXArticleOAuth2(context.Background(), xOAuth2Credential{AccessToken: "token"}, "Title", body.String(), images, nil, coverSource)
			if err != nil {
				testRunner.Fatal(err)
			}
			if uploads != count+1 {
				testRunner.Fatalf("uploads = %d, want %d", uploads, count+1)
			}
			coverID := fmt.Sprint(1234567890123456780 + uploads)
			if !strings.Contains(string(draft["cover_media"]), coverID) || strings.Contains(string(draft["content_state"]), coverID) {
				testRunner.Fatalf("cover must appear only in cover_media: %s", draft)
			}
			var content struct {
				Entities []struct {
					Value struct {
						Type string `json:"type"`
					} `json:"value"`
				} `json:"entities"`
			}
			if err := json.Unmarshal(draft["content_state"], &content); err != nil {
				testRunner.Fatal(err)
			}
			imageCount := 0
			for _, entity := range content.Entities {
				if entity.Value.Type == "image" {
					imageCount++
				}
			}
			if imageCount != count {
				testRunner.Fatalf("body image count = %d, want %d", imageCount, count)
			}
		})
	}
}
