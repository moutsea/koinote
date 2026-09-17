package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func requestDocumentExportMetadata(
	t *testing.T,
	app *App,
	user model.User,
	method string,
	docID string,
	body string,
) *httptest.ResponseRecorder {
	t.Helper()
	var request *http.Request
	if body == "" {
		request = httptest.NewRequest(method, "/api/documents/"+docID+"/export-metadata", nil)
	} else {
		request = httptest.NewRequest(method, "/api/documents/"+docID+"/export-metadata", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
	}
	request.AddCookie(sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion))
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	return response
}

func TestDocumentWechatCoverMetadataRoundTrip(t *testing.T) {
	app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
		SessionSecret: "document-export-metadata-test",
		AppURL:        "https://app.example.test",
	})
	imageKey := fmt.Sprintf("u/%s/0123456789abcdef.jpg", user.AuthUserID)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO image_objects (object_key, user_id, bytes, purpose)
		VALUES ($1, $2, 16, 'persistent')
	`, imageKey, user.ID); err != nil {
		t.Fatalf("insert cover image object: %v", err)
	}

	put := requestDocumentExportMetadata(
		t, app, user, http.MethodPut, document.DocID,
		`{"coverImage":"https://img.example.test/`+imageKey+`","coverRatio":"1:1"}`,
	)
	if put.Code != http.StatusOK {
		t.Fatalf("put cover metadata status=%d body=%s", put.Code, put.Body.String())
	}
	var putPayload struct {
		Cover *struct {
			Source string `json:"source"`
			Ratio  string `json:"ratio"`
		} `json:"cover"`
	}
	if err := json.NewDecoder(put.Body).Decode(&putPayload); err != nil {
		t.Fatal(err)
	}
	if putPayload.Cover == nil || putPayload.Cover.Source != "https://app.example.test/images/"+imageKey ||
		putPayload.Cover.Ratio != "1:1" {
		t.Fatalf("unexpected put payload: %+v", putPayload)
	}

	get := requestDocumentExportMetadata(t, app, user, http.MethodGet, document.DocID, "")
	if get.Code != http.StatusOK {
		t.Fatalf("get cover metadata status=%d body=%s", get.Code, get.Body.String())
	}
	var getPayload struct {
		Cover *struct {
			Source string `json:"source"`
			Ratio  string `json:"ratio"`
		} `json:"cover"`
	}
	if err := json.NewDecoder(get.Body).Decode(&getPayload); err != nil {
		t.Fatal(err)
	}
	if getPayload.Cover == nil || getPayload.Cover.Source != putPayload.Cover.Source ||
		getPayload.Cover.Ratio != putPayload.Cover.Ratio {
		t.Fatalf("unexpected get payload: %+v", getPayload)
	}
	var content string
	if err := pool.QueryRow(context.Background(), `
		SELECT content FROM documents WHERE doc_id = $1
	`, document.DocID).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(content, imageKey) || strings.Contains(content, "cover_image") {
		t.Fatalf("cover metadata leaked into document content: %q", content)
	}
}

func TestDocumentWechatCoverMetadataRejectsForeignImage(t *testing.T) {
	app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
		SessionSecret: "document-export-metadata-owner-test",
		AppURL:        "https://app.example.test",
	})
	foreignKey := fmt.Sprintf("u/other-user/0123456789abcdef.jpg")
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO image_objects (object_key, user_id, bytes, purpose)
		VALUES ($1, $2, 16, 'persistent')
	`, foreignKey, user.ID); err != nil {
		t.Fatalf("insert foreign-owned cover image object: %v", err)
	}

	response := requestDocumentExportMetadata(
		t, app, user, http.MethodPut, document.DocID,
		`{"coverImage":"/images/`+foreignKey+`","coverRatio":"2.35:1"}`,
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("foreign cover status=%d body=%s, want bad request", response.Code, response.Body.String())
	}
	var count int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM document_export_metadata WHERE document_id = (
			SELECT id FROM documents WHERE doc_id = $1
		)
	`, document.DocID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("cover metadata rows=%d, want 0", count)
	}
}
