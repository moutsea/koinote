package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

var feishuIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`)

type feishuConversion struct {
	Roots  []string         `json:"first_level_block_ids"`
	Blocks []map[string]any `json:"blocks"`
	Images []struct {
		BlockID string `json:"block_id"`
		URL     string `json:"image_url"`
	} `json:"block_id_to_image_urls"`
}

type feishuBlockBatch struct {
	Roots  []string
	Blocks []map[string]any
}

type feishuSyncResult struct {
	URL      string `json:"url"`
	Created  bool   `json:"created"`
	Revision int64  `json:"revision"`
}

const feishuSyncTimeout = 110 * time.Second

func feishuDocumentURL(documentID string) string {
	return "https://feishu.cn/docx/" + url.PathEscape(documentID)
}

func (a *App) feishuDocumentSync(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.cfg.FeishuDocsEnabled() {
		writeFeishuError(w, errFeishuNotConfigured)
		return
	}
	if !a.rateLimit().allow("feishu-sync:"+strconv.Itoa(user.ID), 30, time.Hour) {
		httpx.ErrorCode(w, 429, "too_many_requests", "Too many sync requests")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), feishuSyncTimeout)
	defer cancel()
	connection, release, err := a.lockFeishuAccount(ctx, user.ID)
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	defer release()
	documentID := r.PathValue("docId")
	var title, content string
	var revision int64
	err = connection.QueryRow(ctx, `SELECT title,content,revision FROM documents WHERE doc_id=$1 AND user_id=$2 AND trashed_at IS NULL`, documentID, user.ID).Scan(&title, &content, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, 404, "not_found", "Document not found")
		return
	}
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	if strings.TrimSpace(title) == "" {
		title = "Untitled"
	}
	credential, err := a.loadFeishuCredential(ctx, connection, user.ID)
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	converted, err := a.convertFeishuDocument(ctx, credential.AccessToken, content)
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	batches, err := prepareFeishuBatches(converted)
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	images, err := a.prepareFeishuImages(ctx, converted)
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	var remoteID string
	err = connection.QueryRow(ctx, `SELECT feishu_document_id FROM feishu_document_links WHERE user_id=$1 AND document_id=$2 AND app_id=$3 AND open_id=$4`, user.ID, documentID, a.cfg.FeishuClientID, credential.OpenID).Scan(&remoteID)
	created := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !created {
		writeFeishuError(w, err)
		return
	}
	for attempt := 0; attempt < 2; attempt++ {
		if created {
			var result struct {
				Document struct {
					ID string `json:"document_id"`
				} `json:"document"`
			}
			err = a.feishuJSON(ctx, credential.AccessToken, http.MethodPost, "/docx/v1/documents", map[string]string{"title": title}, &result)
			if err != nil {
				writeFeishuError(w, err)
				return
			}
			remoteID = result.Document.ID
			if !feishuIDPattern.MatchString(remoteID) {
				writeFeishuError(w, errors.New("Feishu document ID missing"))
				return
			}
			persistCtx, persistCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			_, err = connection.Exec(persistCtx, `INSERT INTO feishu_document_links (user_id,document_id,app_id,open_id,feishu_document_id) VALUES ($1,$2,$3,$4,$5)
				ON CONFLICT (user_id,document_id,app_id,open_id) DO UPDATE SET feishu_document_id=EXCLUDED.feishu_document_id,source_revision=0,synced_at=NULL`, user.ID, documentID, a.cfg.FeishuClientID, credential.OpenID, remoteID)
			persistCancel()
			if err != nil {
				writeFeishuError(w, err)
				return
			}
		}
		err = a.replaceFeishuDocument(ctx, credential.AccessToken, remoteID, title, batches, images)
		if !created && errors.Is(err, errFeishuDocumentMissing) {
			created = true
			continue
		}
		if err != nil {
			writeFeishuError(w, err)
			return
		}
		break
	}
	_, err = connection.Exec(ctx, `UPDATE feishu_document_links SET source_revision=$5,synced_at=now() WHERE user_id=$1 AND document_id=$2 AND app_id=$3 AND open_id=$4`, user.ID, documentID, a.cfg.FeishuClientID, credential.OpenID, revision)
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	httpx.JSON(w, 200, feishuSyncResult{URL: feishuDocumentURL(remoteID), Created: created, Revision: revision})
}

func (a *App) convertFeishuDocument(ctx context.Context, token, content string) (feishuConversion, error) {
	var converted feishuConversion
	if strings.TrimSpace(content) == "" {
		converted.Roots = []string{"empty"}
		converted.Blocks = []map[string]any{{"block_id": "empty", "block_type": 2, "text": map[string]any{"elements": []any{map[string]any{"text_run": map[string]string{"content": ""}}}}}}
		return converted, nil
	}
	err := a.feishuJSON(ctx, token, http.MethodPost, "/docx/v1/documents/blocks/convert", map[string]string{"content_type": "markdown", "content": content}, &converted)
	return converted, err
}

func prepareFeishuBatches(converted feishuConversion) ([]feishuBlockBatch, error) {
	if len(converted.Blocks) == 0 || len(converted.Roots) == 0 || len(converted.Blocks) > 5000 || len(converted.Images) > 20 {
		return nil, errFeishuContentLimit
	}
	byID := make(map[string]map[string]any, len(converted.Blocks))
	for _, block := range converted.Blocks {
		blockID, _ := block["block_id"].(string)
		if blockID == "" || byID[blockID] != nil {
			return nil, errors.New("Invalid Feishu block tree")
		}
		stripFeishuReadOnlyFields(block)
		delete(block, "parent_id")
		delete(block, "revision_id")
		byID[blockID] = block
	}
	visited := make(map[string]bool)
	var collect func(string, int, *[]map[string]any) error
	collect = func(blockID string, depth int, tree *[]map[string]any) error {
		block := byID[blockID]
		if block == nil || visited[blockID] || depth > 100 {
			return errors.New("Invalid Feishu block tree")
		}
		visited[blockID] = true
		*tree = append(*tree, block)
		if children := block["children"]; children != nil {
			items, ok := children.([]any)
			if !ok {
				return errors.New("Invalid Feishu children")
			}
			for _, item := range items {
				childID, ok := item.(string)
				if !ok {
					return errors.New("Invalid Feishu child ID")
				}
				if err := collect(childID, depth+1, tree); err != nil {
					return err
				}
			}
		}
		return nil
	}
	var batches []feishuBlockBatch
	batch := feishuBlockBatch{}
	for _, rootID := range converted.Roots {
		var tree []map[string]any
		if err := collect(rootID, 0, &tree); err != nil {
			return nil, err
		}
		if len(tree) > 1000 {
			return nil, errFeishuContentLimit
		}
		if len(batch.Blocks)+len(tree) > 1000 {
			batches = append(batches, batch)
			batch = feishuBlockBatch{}
		}
		batch.Roots = append(batch.Roots, rootID)
		batch.Blocks = append(batch.Blocks, tree...)
	}
	if len(visited) != len(byID) {
		return nil, errors.New("Unreachable Feishu blocks")
	}
	batches = append(batches, batch)
	return batches, nil
}

func stripFeishuReadOnlyFields(value any) {
	switch item := value.(type) {
	case map[string]any:
		delete(item, "merge_info")
		delete(item, "comment_ids")
		for _, child := range item {
			stripFeishuReadOnlyFields(child)
		}
	case []any:
		for _, child := range item {
			stripFeishuReadOnlyFields(child)
		}
	}
}

func (a *App) prepareFeishuImages(ctx context.Context, converted feishuConversion) (map[string][]byte, error) {
	if len(converted.Images) > 20 {
		return nil, errFeishuContentLimit
	}
	images := make(map[string][]byte)
	byURL := make(map[string][]byte)
	total := 0
	for _, image := range converted.Images {
		data, exists := byURL[image.URL]
		if !exists {
			var err error
			data, err = a.readXImage(ctx, image.URL)
			if err != nil {
				return nil, errFeishuImage
			}
			contentType := http.DetectContentType(data)
			if contentType != "image/png" && contentType != "image/jpeg" && contentType != "image/gif" && contentType != "image/webp" {
				return nil, errFeishuImage
			}
			byURL[image.URL] = data
		}
		total += len(data)
		if total > 50<<20 {
			return nil, errFeishuContentLimit
		}
		images[image.BlockID] = data
	}
	for _, block := range converted.Blocks {
		if _, isImage := block["image"]; isImage {
			blockID, _ := block["block_id"].(string)
			if len(images[blockID]) == 0 {
				return nil, errFeishuImage
			}
		}
	}
	return images, nil
}

func (a *App) mutateFeishuBlock(ctx context.Context, token, method, path string, body, output any) error {
	clientToken, err := randomUUID()
	if err != nil {
		return err
	}
	return a.feishuJSON(ctx, token, method, path+"?document_revision_id=-1&client_token="+url.QueryEscape(clientToken), body, output)
}

type feishuRootResponse struct {
	Block struct {
		Children []string `json:"children"`
		ID       string   `json:"block_id"`
	} `json:"block"`
}

func (a *App) replaceFeishuDocument(ctx context.Context, token, documentID, title string, batches []feishuBlockBatch, images map[string][]byte) (resultErr error) {
	basePath := "/docx/v1/documents/" + url.PathEscape(documentID) + "/blocks/"
	rootPath := basePath + url.PathEscape(documentID)
	var root feishuRootResponse
	if err := a.feishuJSON(ctx, token, http.MethodGet, rootPath, nil, &root); err != nil {
		var provider *feishuAPIError
		if errors.As(err, &provider) &&
			((provider.Status == http.StatusNotFound && provider.Code == 1770002) ||
				(provider.Status == http.StatusBadRequest && provider.Code == 1770003)) {
			return errors.Join(errFeishuDocumentMissing, err)
		}
		return err
	}
	if root.Block.ID != documentID {
		return errors.New("Invalid Feishu document root")
	}
	oldCount := len(root.Block.Children)
	var insertedRoots []string
	removingOld := false
	defer func() {
		if resultErr == nil || removingOld || len(insertedRoots) == 0 {
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		var current feishuRootResponse
		if a.feishuJSON(cleanup, token, http.MethodGet, rootPath, nil, &current) != nil {
			return
		}
		children := current.Block.Children
		if current.Block.ID == documentID && len(children) == oldCount+len(insertedRoots) &&
			slices.Equal(children[:oldCount], root.Block.Children) && slices.Equal(children[oldCount:], insertedRoots) {
			_ = a.mutateFeishuBlock(cleanup, token, http.MethodDelete, rootPath+"/children/batch_delete", map[string]int{"start_index": oldCount, "end_index": len(children)}, nil)
		}
	}()
	for _, batch := range batches {
		var inserted struct {
			Relations []struct {
				TemporaryID string `json:"temporary_block_id"`
				ID          string `json:"block_id"`
			} `json:"block_id_relations"`
		}
		err := a.mutateFeishuBlock(ctx, token, http.MethodPost, rootPath+"/descendant", map[string]any{"children_id": batch.Roots, "descendants": batch.Blocks, "index": -1}, &inserted)
		if err != nil {
			return err
		}
		actualIDs := make(map[string]string)
		for _, relation := range inserted.Relations {
			actualIDs[relation.TemporaryID] = relation.ID
		}
		for _, rootID := range batch.Roots {
			actualID := actualIDs[rootID]
			if !feishuIDPattern.MatchString(actualID) {
				return errors.New("Feishu block ID missing")
			}
			insertedRoots = append(insertedRoots, actualID)
		}
		for _, block := range batch.Blocks {
			temporaryID, _ := block["block_id"].(string)
			data, image := images[temporaryID]
			if !image {
				continue
			}
			actualID := actualIDs[temporaryID]
			if !feishuIDPattern.MatchString(actualID) {
				return errors.New("Feishu image block ID missing")
			}
			fileToken, err := a.uploadFeishuImage(ctx, token, documentID, actualID, data)
			if err != nil {
				return err
			}
			if err = a.mutateFeishuBlock(ctx, token, http.MethodPatch, basePath+url.PathEscape(actualID), map[string]any{"replace_image": map[string]string{"token": fileToken}}, nil); err != nil {
				return err
			}
		}
	}
	if err := a.mutateFeishuBlock(ctx, token, http.MethodPatch, rootPath, map[string]any{"update_text_elements": map[string]any{"elements": []any{map[string]any{"text_run": map[string]string{"content": title}}}}}, nil); err != nil {
		return err
	}
	for oldCount > 0 {
		removingOld = true
		count := min(oldCount, 1000)
		if err := a.mutateFeishuBlock(ctx, token, http.MethodDelete, rootPath+"/children/batch_delete", map[string]int{"start_index": 0, "end_index": count}, nil); err != nil {
			return err
		}
		oldCount -= count
	}
	return nil
}

func (a *App) uploadFeishuImage(ctx context.Context, token, documentID, blockID string, data []byte) (string, error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	extra, _ := json.Marshal(map[string]string{"drive_route_token": documentID})
	for name, value := range map[string]string{"file_name": "image", "parent_type": "docx_image", "parent_node": blockID, "size": strconv.Itoa(len(data)), "extra": string(extra)} {
		if err := writer.WriteField(name, value); err != nil {
			return "", err
		}
	}
	part, err := writer.CreateFormFile("file", "image")
	if err != nil {
		return "", err
	}
	if _, err = part.Write(data); err != nil {
		return "", err
	}
	if err = writer.Close(); err != nil {
		return "", err
	}
	raw, err := a.feishuCall(ctx, token, http.MethodPost, "/drive/v1/medias/upload_all", writer.FormDataContentType(), buffer.Bytes())
	if err != nil {
		return "", err
	}
	var result struct {
		Token string `json:"file_token"`
	}
	if err = json.Unmarshal(raw, &result); err != nil || result.Token == "" {
		return "", errFeishuImage
	}
	return result.Token, nil
}
