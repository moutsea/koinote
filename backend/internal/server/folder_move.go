package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

// 移动：把文档或文件夹挪到另一个文件夹下（或根下）。
//
// 单独一个端点而不是复用 PUT /api/documents/{docId}：后者要带上完整的
// title/content/theme，为改一个归属字段传一整篇正文太浪费，而且拖拽时会很频繁。

// folderMove 处理 PUT /api/folders/{folderId}/parent
//
// 这里是整个文件树唯一能造成不可逆损坏的地方：把文件夹移进自己的子孙会造出一个环，
// 那棵子树从根上就够不到了。前端的 canDropFolder 会挡一次，但那只是 UI 层 ——
// 直接打接口绕过它就能把数据搞坏，所以服务端必须自己判。
func (a *App) folderMove(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	folderID := strings.TrimSpace(r.PathValue("folderId"))
	if folderID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
		return
	}

	var body struct {
		ParentFolderID *string `json:"parentFolderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	target := derefOrEmpty(body.ParentFolderID)

	if target == folderID {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_move", "Cannot move a folder into itself")
		return
	}

	// 自身必须存在且属于当前用户
	var selfID int
	err := a.db.QueryRow(r.Context(),
		`SELECT id FROM folders WHERE folder_id = $1 AND user_id = $2`,
		folderID, user.ID,
	).Scan(&selfID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
		return
	}
	if err != nil {
		log.Printf("folder move lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	var parentID *int
	if target != "" {
		var pid int
		err := a.db.QueryRow(r.Context(),
			`SELECT id FROM folders WHERE folder_id = $1 AND user_id = $2`,
			target, user.ID,
		).Scan(&pid)
		// 目标不属于自己或不存在，一律 404：不区分二者，免得成为探测他人数据的手段
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
			return
		}
		if err != nil {
			log.Printf("folder move target: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		parentID = &pid

		cyclic, err := a.isDescendantFolder(r.Context(), selfID, pid)
		if err != nil {
			log.Printf("folder move cycle check: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if cyclic {
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_move", "Cannot move a folder into its own subtree")
			return
		}

		depth, err := a.folderDepth(r.Context(), pid)
		if err != nil {
			log.Printf("folder move depth: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if depth+1 > maxFolderDepth {
			httpx.ErrorCode(w, http.StatusBadRequest, "too_deep", "Folder nesting is too deep")
			return
		}
	}

	if _, err := a.db.Exec(r.Context(),
		`UPDATE folders SET parent_id = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
		selfID, user.ID, parentID,
	); err != nil {
		log.Printf("folder move: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// documentMove 处理 PUT /api/documents/{docId}/folder
func (a *App) documentMove(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	docID := strings.TrimSpace(r.PathValue("docId"))
	if docID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}

	var body struct {
		FolderID *string `json:"folderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	target := derefOrEmpty(body.FolderID)

	// 目标文件夹经子查询解析并带 user_id 过滤。传别人的 folderId 时子查询得 NULL，
	// 文档会落到根下 —— 不会挂到他人的树上
	res, err := a.db.Exec(r.Context(), `
		UPDATE documents
		SET folder_id = CASE
			WHEN $3 = '' THEN NULL
			ELSE (SELECT id FROM folders WHERE folder_id = $3 AND user_id = $2)
		END
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
	`, docID, user.ID, target)
	if err != nil {
		log.Printf("document move: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if res.RowsAffected() == 0 {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// isDescendantFolder 判断 candidate 是否在 root 的子树里（含 root 自身）。
//
// 递归 CTE 而不是在 Go 里逐层查：层数不定，逐层查是 N+1 次往返，而且并发下可能读到
// 不一致的中间状态。
func (a *App) isDescendantFolder(ctx context.Context, root, candidate int) (bool, error) {
	if root == candidate {
		return true, nil
	}
	var found bool
	err := a.db.QueryRow(ctx, `
		WITH RECURSIVE sub AS (
			SELECT id FROM folders WHERE id = $1
			UNION
			SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
		)
		SELECT EXISTS (SELECT 1 FROM sub WHERE id = $2)
	`, root, candidate).Scan(&found)
	return found, err
}

// folderDepth 返回该文件夹到根的层数（根下的文件夹为 1）
func (a *App) folderDepth(ctx context.Context, id int) (int, error) {
	var depth int
	err := a.db.QueryRow(ctx, `
		WITH RECURSIVE up AS (
			SELECT id, parent_id, 1 AS d FROM folders WHERE id = $1
			UNION ALL
			SELECT f.id, f.parent_id, up.d + 1 FROM folders f JOIN up ON f.id = up.parent_id
		)
		SELECT COALESCE(MAX(d), 0) FROM up
	`, id).Scan(&depth)
	return depth, err
}
