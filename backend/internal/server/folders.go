package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

// 文件夹：侧栏的目录结构。
//
// 与文档的关系是「容器」而非「父文档」：文件夹没有正文、不能分享、没有排版主题。
// 详见 migrations/0006_folders.sql 里的取舍说明。

const maxFolderNameRunes = 60

// 嵌套深度上限。数据库层面没有这个约束，纯粹是防 UI 被拖成一条几十层的缩进 ——
// 侧栏宽度有限，深到一定程度就没法看了。
const maxFolderDepth = 8

func (a *App) foldersList(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	rows, err := a.db.Query(r.Context(), `
		SELECT f.folder_id, f.name, COALESCE(p.folder_id, '')
		FROM folders f
		LEFT JOIN folders p ON p.id = f.parent_id
		WHERE f.user_id = $1
		ORDER BY f.name
	`, user.ID)
	if err != nil {
		log.Printf("folders list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()

	folders := make([]model.Folder, 0)
	for rows.Next() {
		var f model.Folder
		var parent string
		if err := rows.Scan(&f.FolderID, &f.Name, &parent); err != nil {
			log.Printf("folders scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		// 空串代表根下。JSON 里用 null 表达，前端的 parentFolderId 是 string|null
		if parent != "" {
			p := parent
			f.ParentFolderID = &p
		}
		folders = append(folders, f)
	}
	if rows.Err() != nil {
		log.Printf("folders rows: %v", rows.Err())
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"folders": folders})
}

func (a *App) folderCreate(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	var body struct {
		Name           string  `json:"name"`
		ParentFolderID *string `json:"parentFolderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}

	name, err := validateFolderName(body.Name)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "name_too_long", err.Error())
		return
	}

	folderID, err := randomUUID()
	if err != nil {
		log.Printf("folder id: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	// 深度上限。folderMove 一直有这个检查，create 之前没有 —— 只要一层层往里建就能
	// 绕过上限，而移动同一棵树反倒会被挡。右键菜单能在文件夹里直接建子文件夹之后，
	// 这条路径是日常操作，必须补上。
	//
	// 找不到父文件夹时按 0 处理：可能是不存在，也可能是别人的。两种情况下面的
	// INSERT 子查询都会解析成 NULL（落到根下），深度就是 1，不该被挡。
	if parent := derefOrEmpty(body.ParentFolderID); parent != "" {
		var parentID int
		err := a.db.QueryRow(r.Context(),
			`SELECT id FROM folders WHERE folder_id = $1 AND user_id = $2`,
			parent, user.ID,
		).Scan(&parentID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			log.Printf("folder create parent lookup: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if err == nil {
			depth, err := a.folderDepth(r.Context(), parentID)
			if err != nil {
				log.Printf("folder create depth: %v", err)
				httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
				return
			}
			if depth+1 > maxFolderDepth {
				httpx.ErrorCode(w, http.StatusBadRequest, "too_deep", "Folder nesting is too deep")
				return
			}
		}
	}

	// parent_id 经子查询解析并带 user_id 过滤：传别人的 folderId 会解析成 NULL
	// （落到根下）而不是报外键错误 —— 后者会泄露「该文件夹存在」
	var created model.Folder
	var parent string
	err = a.db.QueryRow(r.Context(), `
		WITH ins AS (
			INSERT INTO folders (folder_id, user_id, parent_id, name)
			VALUES (
				$1, $2,
				(SELECT id FROM folders WHERE folder_id = $3 AND user_id = $2),
				$4
			)
			RETURNING folder_id, name, parent_id
		)
		SELECT ins.folder_id, ins.name, COALESCE(p.folder_id, '')
		FROM ins LEFT JOIN folders p ON p.id = ins.parent_id
	`, folderID, user.ID, derefOrEmpty(body.ParentFolderID), name).
		Scan(&created.FolderID, &created.Name, &parent)
	if err != nil {
		log.Printf("folder create: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if parent != "" {
		created.ParentFolderID = &parent
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"folder": created})
}

func (a *App) folderRename(w http.ResponseWriter, r *http.Request) {
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
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	name, err := validateFolderName(body.Name)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "name_too_long", err.Error())
		return
	}

	var updated model.Folder
	var parent string
	err = a.db.QueryRow(r.Context(), `
		WITH upd AS (
			UPDATE folders SET name = $3, updated_at = now()
			WHERE folder_id = $1 AND user_id = $2
			RETURNING folder_id, name, parent_id
		)
		SELECT upd.folder_id, upd.name, COALESCE(p.folder_id, '')
		FROM upd LEFT JOIN folders p ON p.id = upd.parent_id
	`, folderID, user.ID, name).Scan(&updated.FolderID, &updated.Name, &parent)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
		return
	}
	if err != nil {
		log.Printf("folder rename: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if parent != "" {
		updated.ParentFolderID = &parent
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"folder": updated})
}

// folderDelete 删文件夹本身，子项提到父级。
//
// 不做级联删：一个文件夹下可能有几十篇正文，点一次删除就全没了，而这个操作在 UI 上
// 与「删一篇文档」长得一样。提升子项是可恢复的，级联删不可恢复。
func (a *App) folderDelete(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	folderID := strings.TrimSpace(r.PathValue("folderId"))
	if folderID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		log.Printf("folder delete begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var internalID int
	var parentID *int
	err = tx.QueryRow(r.Context(),
		`SELECT id, parent_id FROM folders WHERE folder_id = $1 AND user_id = $2`,
		folderID, user.ID,
	).Scan(&internalID, &parentID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
		return
	}
	if err != nil {
		log.Printf("folder delete lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	// 子文件夹与文档都提到父级（父为 NULL 时即根下）
	if _, err := tx.Exec(r.Context(),
		`UPDATE folders SET parent_id = $2, updated_at = now() WHERE parent_id = $1`,
		internalID, parentID,
	); err != nil {
		log.Printf("folder delete lift folders: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE documents SET folder_id = $2 WHERE folder_id = $1`,
		internalID, parentID,
	); err != nil {
		log.Printf("folder delete lift docs: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	if _, err := tx.Exec(r.Context(),
		`DELETE FROM folders WHERE id = $1 AND user_id = $2`, internalID, user.ID,
	); err != nil {
		log.Printf("folder delete: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("folder delete commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func validateFolderName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if utf8.RuneCountInString(name) > maxFolderNameRunes {
		return "", errors.New("Folder name is too long")
	}
	return name, nil
}

func derefOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}
