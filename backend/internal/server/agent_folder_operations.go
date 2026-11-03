package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Folder deletion has its own resource identity and optimistic snapshot. It
// never reuses document revisions or pretends folders have a trash bin.
type agentFolderSnapshot struct {
	ID            string    `json:"folderId"`
	Name          string    `json:"name"`
	ParentID      string    `json:"parentFolderId"`
	OrganizerKind string    `json:"organizerKind"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

func (f agentFolderSnapshot) version() string {
	raw, _ := json.Marshal(f)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func agentPathFolderID(path string) string {
	id := strings.TrimPrefix(path, "/folders/")
	if path != "/folders/"+id || !validUUID(id) {
		return ""
	}
	return id
}

type agentArgumentError struct{ message string }

func (e *agentArgumentError) Error() string  { return e.message }
func (e *agentArgumentError) Unwrap() error  { return errAgentInput }
func agentBadArguments(message string) error { return &agentArgumentError{message} }

// A fresh proposal can be replanned when a resource prerequisite is unmet.
// Execution/approval still treats the same condition as a conflict, and the
// intent guard never accepts this diagnostic as an authorization proof.
type agentPreconditionError struct {
	message string
	cause   error
}

func (e *agentPreconditionError) Error() string { return e.message }
func (e *agentPreconditionError) Unwrap() error { return e.cause }

type agentValidationError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (a *App) loadEmptyAgentFolder(ctx context.Context, tx pgx.Tx, userID int, in agentOperationInput) (*agentSnapshot, error) {
	id := agentPathFolderID(in.Path)
	if id == "" || in.ExpectedFolderVersion == "" || in.FolderID != "" || in.ExpectedRevision != 0 {
		return nil, agentBadArguments("delete_folder requires path=/folders/<id> and expectedFolderVersion copied from list_folders.version; omit folderId and expectedRevision")
	}
	f, internalID, err := lockAgentFolder(ctx, tx, userID, id)
	if err != nil {
		return nil, err
	}
	if f.version() != in.ExpectedFolderVersion {
		return nil, errAgentSessionConflict
	}
	empty, err := agentFolderEmpty(ctx, tx, internalID)
	if err != nil {
		return nil, err
	}
	if !empty {
		return nil, &agentPreconditionError{cause: errAgentSessionConflict, message: "文件夹 " + in.Path + " 当前包含文档、子文件夹或同步授权，尚不满足 delete_folder 的前置条件。本批操作未执行。请先用 list_folders 核对；若任务需要移动文档，先单独提交用户已授权的移动，等待宿主确认 applied 后重新读取文件夹，再提交空文件夹删除。不能把删除与尚未生效的前置操作放在同一批，也不能为满足前置条件擅自扩大删除或授权范围。"}
	}
	return &agentSnapshot{Path: in.Path, Folder: &f}, nil
}

func lockAgentFolder(ctx context.Context, tx pgx.Tx, userID int, id string) (agentFolderSnapshot, int, error) {
	var f agentFolderSnapshot
	var internalID int
	// FOR UPDATE also serializes with FK key-share locks from concurrent child
	// or document insertion. Check emptiness in a subsequent fresh snapshot.
	err := tx.QueryRow(ctx, `SELECT f.id,f.folder_id,f.name,COALESCE(p.folder_id,''),COALESCE(f.organizer_kind,''),f.created_at,f.updated_at FROM folders f LEFT JOIN folders p ON p.id=f.parent_id WHERE f.user_id=$1 AND f.folder_id=$2 FOR UPDATE OF f`, userID, id).Scan(&internalID, &f.ID, &f.Name, &f.ParentID, &f.OrganizerKind, &f.CreatedAt, &f.UpdatedAt)
	return f, internalID, err
}

func agentFolderEmpty(ctx context.Context, tx pgx.Tx, internalID int) (bool, error) {
	var empty bool
	err := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM documents WHERE folder_id=$1) AND NOT EXISTS(SELECT 1 FROM folders WHERE parent_id=$1) AND NOT EXISTS(SELECT 1 FROM mcp_wechat_sync_grants WHERE folder_id=$1)`, internalID).Scan(&empty)
	return empty, err
}

func undoCreatedAgentFolder(ctx context.Context, tx pgx.Tx, userID int, op *agentOperation) error {
	folder, internalID, err := lockAgentFolder(ctx, tx, userID, op.Result.FolderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errAgentSessionConflict
	}
	if err != nil {
		return err
	}
	if folder.Name != op.Input.Title || folder.ParentID != op.Input.FolderID {
		return errAgentSessionConflict
	}
	empty, err := agentFolderEmpty(ctx, tx, internalID)
	if err != nil {
		return err
	}
	if !empty {
		return errAgentSessionConflict
	}
	_, err = tx.Exec(ctx, `DELETE FROM folders WHERE id=$1 AND user_id=$2`, internalID, userID)
	return err
}

func (a *App) deleteAgentFolderTx(ctx context.Context, tx pgx.Tx, userID int, op *agentOperation) (agentOperationResult, error) {
	before, err := a.loadEmptyAgentFolder(ctx, tx, userID, op.Input)
	if err != nil {
		return agentOperationResult{}, err
	}
	if op.Before == nil || op.Before.Folder == nil || op.Before.Folder.version() != before.Folder.version() {
		return agentOperationResult{}, errAgentSessionConflict
	}
	tag, err := tx.Exec(ctx, `DELETE FROM folders WHERE folder_id=$1 AND user_id=$2`, before.Folder.ID, userID)
	if err != nil {
		return agentOperationResult{}, err
	}
	if tag.RowsAffected() != 1 {
		return agentOperationResult{}, errAgentSessionConflict
	}
	return agentOperationResult{FolderID: before.Folder.ID, Path: before.Path}, nil
}

func (a *App) restoreAgentFolderTx(ctx context.Context, tx pgx.Tx, userID int, op *agentOperation) error {
	if op.Before == nil || op.Before.Folder == nil {
		return errAgentSessionConflict
	}
	f := op.Before.Folder
	var parent *int
	if f.ParentID != "" {
		var id int
		if err := tx.QueryRow(ctx, `SELECT id FROM folders WHERE folder_id=$1 AND user_id=$2 FOR SHARE`, f.ParentID, userID).Scan(&id); err != nil {
			return fmt.Errorf("原父文件夹已不存在，请先恢复父文件夹: %w", errAgentSessionConflict)
		}
		depth, err := a.folderDepthTx(ctx, tx, id)
		if err != nil {
			return err
		}
		if depth+1 > maxFolderDepth {
			return errAgentSessionConflict
		}
		parent = &id
	}
	// Refuse an existing replacement; never overwrite another folder on undo.
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE folder_id=$1)`, f.ID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("文件夹标识已被占用，无法撤销删除: %w", errAgentSessionConflict)
	}
	_, err := tx.Exec(ctx, `INSERT INTO folders(folder_id,user_id,parent_id,name,organizer_kind,created_at,updated_at) VALUES($1,$2,$3,$4,NULLIF($5,''),$6,clock_timestamp())`, f.ID, userID, parent, f.Name, f.OrganizerKind, f.CreatedAt)
	return err
}

func recoverableAgentValidation(err error) *agentIntentProof {
	var input *agentArgumentError
	if errors.As(err, &input) {
		return &agentIntentProof{ValidationError: &agentValidationError{Code: "invalid_arguments", Retryable: true, Message: input.message}}
	}
	var prerequisite *agentPreconditionError
	if errors.As(err, &prerequisite) {
		return &agentIntentProof{ValidationError: &agentValidationError{Code: "precondition_not_met", Retryable: true, Message: prerequisite.message}}
	}
	return nil
}
