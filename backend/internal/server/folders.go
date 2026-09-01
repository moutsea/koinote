package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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

const (
	folderOrganizerSmart    = "smart"
	folderOrganizerActivity = "activity"
)

func (a *App) foldersList(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	rows, err := a.db.Query(r.Context(), `
		SELECT f.folder_id, f.name, COALESCE(p.folder_id, ''), f.organizer_kind
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
		if err := rows.Scan(&f.FolderID, &f.Name, &parent, &f.OrganizerKind); err != nil {
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
		FolderID       string  `json:"folderId"`
		Name           string  `json:"name"`
		ParentFolderID *string `json:"parentFolderId"`
		OrganizerKind  *string `json:"organizerKind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	body.FolderID = strings.TrimSpace(body.FolderID)
	if body.FolderID != "" && (!strings.HasPrefix(bearerToken(r), desktopAccessTokenPrefix) || !validUUID(body.FolderID)) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_folder_id", "Invalid folder id")
		return
	}
	if !validFolderOrganizerKind(body.OrganizerKind) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_organizer_kind", "Invalid organizer kind")
		return
	}

	name, err := validateFolderName(body.Name)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "name_too_long", err.Error())
		return
	}

	folderID := body.FolderID
	if folderID == "" {
		var err error
		folderID, err = randomUUID()
		if err != nil {
			log.Printf("folder id: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
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

	if body.OrganizerKind != nil {
		created, wasCreated, conflict, err := a.createOrganizerFolder(
			r.Context(),
			user.ID,
			folderID,
			derefOrEmpty(body.ParentFolderID),
			name,
			*body.OrganizerKind,
		)
		if err != nil {
			log.Printf("organizer folder create: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if conflict {
			httpx.ErrorCode(w, http.StatusConflict, "conflict", "Folder already exists")
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"folder": created, "created": wasCreated})
		return
	}

	// parent_id 经子查询解析并带 user_id 过滤：传别人的 folderId 会解析成 NULL
	// （落到根下）而不是报外键错误 —— 后者会泄露「该文件夹存在」
	var created model.Folder
	var parent string
	err = a.db.QueryRow(r.Context(), `
		WITH ins AS (
			INSERT INTO folders (folder_id, user_id, parent_id, name, organizer_kind)
			VALUES (
				$1, $2,
				(SELECT id FROM folders WHERE folder_id = $3 AND user_id = $2),
				$4, $5
			)
			RETURNING folder_id, name, parent_id, organizer_kind
		)
		SELECT ins.folder_id, ins.name, COALESCE(p.folder_id, ''), ins.organizer_kind
		FROM ins LEFT JOIN folders p ON p.id = ins.parent_id
	`, folderID, user.ID, derefOrEmpty(body.ParentFolderID), name, body.OrganizerKind).
		Scan(&created.FolderID, &created.Name, &parent, &created.OrganizerKind)
	if err != nil {
		var pgErr *pgconn.PgError
		if body.FolderID != "" && errors.As(err, &pgErr) && pgErr.Code == "23505" {
			var existing model.Folder
			var existingParent string
			lookupErr := a.db.QueryRow(r.Context(), `
				SELECT f.folder_id, f.name, COALESCE(p.folder_id, ''), f.organizer_kind
				FROM folders f LEFT JOIN folders p ON p.id = f.parent_id
				WHERE f.folder_id = $1 AND f.user_id = $2
			`, folderID, user.ID).Scan(&existing.FolderID, &existing.Name, &existingParent, &existing.OrganizerKind)
			if lookupErr == nil && existing.Name == name && existingParent == derefOrEmpty(body.ParentFolderID) && equalOptionalString(existing.OrganizerKind, body.OrganizerKind) {
				if existingParent != "" {
					existing.ParentFolderID = &existingParent
				}
				httpx.JSON(w, http.StatusOK, map[string]any{"folder": existing, "created": false})
				return
			}
			if lookupErr == nil || errors.Is(lookupErr, pgx.ErrNoRows) {
				httpx.ErrorCode(w, http.StatusConflict, "conflict", "Folder already exists")
				return
			}
		}
		log.Printf("folder create: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if parent != "" {
		created.ParentFolderID = &parent
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"folder": created, "created": true})
}

func (a *App) createOrganizerFolder(
	ctx context.Context,
	userID int,
	folderID string,
	requestedParent string,
	name string,
	organizerKind string,
) (model.Folder, bool, bool, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return model.Folder{}, false, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var parentID *int
	if requestedParent != "" {
		var resolvedParentID int
		err := tx.QueryRow(ctx,
			`SELECT id FROM folders WHERE folder_id = $1 AND user_id = $2`,
			requestedParent, userID,
		).Scan(&resolvedParentID)
		if errors.Is(err, pgx.ErrNoRows) {
			requestedParent = ""
		} else if err != nil {
			return model.Folder{}, false, false, err
		} else {
			parentID = &resolvedParentID
		}
	}

	lockKey := fmt.Sprintf(
		"koinote:organizer-folder:%d:%d:%s:%s",
		userID,
		intValueOrZero(parentID),
		organizerKind,
		name,
	)
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		lockKey,
	); err != nil {
		return model.Folder{}, false, false, err
	}

	if folderID != "" {
		var existing model.Folder
		var existingParentID *int
		var existingParent string
		err := tx.QueryRow(ctx, `
			SELECT f.folder_id, f.name, f.parent_id, COALESCE(p.folder_id, ''), f.organizer_kind
			FROM folders f
			LEFT JOIN folders p ON p.id = f.parent_id
			WHERE f.folder_id = $1 AND f.user_id = $2
		`, folderID, userID).Scan(
			&existing.FolderID,
			&existing.Name,
			&existingParentID,
			&existingParent,
			&existing.OrganizerKind,
		)
		if err == nil {
			if existing.Name != name ||
				!sameFolderParent(existingParentID, parentID) ||
				!sameOrganizerKind(existing.OrganizerKind, organizerKind) {
				return model.Folder{}, false, true, nil
			}
			if existingParent != "" {
				existing.ParentFolderID = &existingParent
			}
			if err := tx.Commit(ctx); err != nil {
				return model.Folder{}, false, false, err
			}
			return existing, false, false, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return model.Folder{}, false, false, err
		}
	}

	var existing model.Folder
	var existingParentID *int
	var existingParent string
	err = tx.QueryRow(ctx, `
		SELECT f.folder_id, f.name, f.parent_id, COALESCE(p.folder_id, ''), f.organizer_kind
		FROM folders f
		LEFT JOIN folders p ON p.id = f.parent_id
		WHERE f.user_id = $1
		  AND f.parent_id IS NOT DISTINCT FROM $2
		  AND f.name = $3
		  AND f.organizer_kind = $4
		ORDER BY f.folder_id
		LIMIT 1
	`, userID, parentID, name, organizerKind).Scan(
		&existing.FolderID,
		&existing.Name,
		&existingParentID,
		&existingParent,
		&existing.OrganizerKind,
	)
	if err == nil {
		if existingParent != "" {
			existing.ParentFolderID = &existingParent
		}
		if err := tx.Commit(ctx); err != nil {
			return model.Folder{}, false, false, err
		}
		return existing, false, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return model.Folder{}, false, false, err
	}

	var created model.Folder
	var createdParent string
	err = tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO folders (folder_id, user_id, parent_id, name, organizer_kind)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING folder_id, name, parent_id, organizer_kind
		)
		SELECT ins.folder_id, ins.name, COALESCE(p.folder_id, ''), ins.organizer_kind
		FROM ins LEFT JOIN folders p ON p.id = ins.parent_id
	`, folderID, userID, parentID, name, organizerKind).Scan(
		&created.FolderID,
		&created.Name,
		&createdParent,
		&created.OrganizerKind,
	)
	if err != nil {
		return model.Folder{}, false, false, err
	}
	if createdParent != "" {
		created.ParentFolderID = &createdParent
	}
	if err := tx.Commit(ctx); err != nil {
		return model.Folder{}, false, false, err
	}
	return created, true, false, nil
}

func intValueOrZero(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func sameFolderParent(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func sameOrganizerKind(value *string, expected string) bool {
	return value != nil && *value == expected
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
			RETURNING folder_id, name, parent_id, organizer_kind
		)
		SELECT upd.folder_id, upd.name, COALESCE(p.folder_id, ''), upd.organizer_kind
		FROM upd LEFT JOIN folders p ON p.id = upd.parent_id
	`, folderID, user.ID, name).Scan(&updated.FolderID, &updated.Name, &parent, &updated.OrganizerKind)
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

// folderDeleteEmptyOrganizer 只删除已经为空的自动整理目录。
// 与普通删除不同，它不会提升任何子项；并发产生新内容时条件删除会安全地返回 false。
func (a *App) folderDeleteEmptyOrganizer(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	folderID := strings.TrimSpace(r.PathValue("folderId"))
	if folderID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
		return
	}

	var found, deleted bool
	err := a.db.QueryRow(r.Context(), `
		WITH target AS (
			SELECT id FROM folders WHERE folder_id = $1 AND user_id = $2
		), deleted AS (
			DELETE FROM folders f
			USING target
			WHERE f.id = target.id
			  AND f.organizer_kind IS NOT NULL
			  AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = f.id)
			  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.folder_id = f.id)
			RETURNING 1
		)
		SELECT EXISTS (SELECT 1 FROM target), EXISTS (SELECT 1 FROM deleted)
	`, folderID, user.ID).Scan(&found, &deleted)
	if err != nil {
		log.Printf("folder delete empty organizer: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if !found {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": deleted, "found": true})
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

func validFolderOrganizerKind(kind *string) bool {
	return kind == nil || *kind == folderOrganizerSmart || *kind == folderOrganizerActivity
}

func equalOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
