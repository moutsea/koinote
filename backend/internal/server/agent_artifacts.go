package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type agentArtifact struct {
	ID       string `json:"id"`
	TaskID   string `json:"taskId"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Bytes    int64  `json:"bytes"`
}
type agentArtifactInput struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Content  string `json:"content,omitempty" jsonschema:"UTF-8 text file content, or omit when supplying base64."`
	Base64   string `json:"base64,omitempty" jsonschema:"Binary file content encoded as base64. Maximum decoded size 1 MiB."`
}

func (a *App) agentSaveArtifact(ctx context.Context, _ *mcp.CallToolRequest, in agentArtifactInput) (*mcp.CallToolResult, agentArtifact, error) {
	t := ctx.Value(writingMCPContext{}).(writingTask)
	if strings.HasPrefix(in.Name, "koi-cover-") {
		return nil, agentArtifact{}, errors.New("koi-cover- filenames are reserved for generate_cover")
	}
	if strings.TrimSpace(in.Name) == "" || utf8.RuneCountInString(in.Name) > 120 || strings.ContainsAny(in.Name, "/\\\r\n\x00") || len(in.MimeType) > 100 || strings.ContainsAny(in.MimeType, "\r\n") || (in.Content != "" && in.Base64 != "") {
		return nil, agentArtifact{}, errAgentInput
	}
	data := []byte(in.Content)
	var err error
	if in.Base64 != "" {
		data, err = base64.StdEncoding.DecodeString(in.Base64)
		if err != nil {
			return nil, agentArtifact{}, errAgentInput
		}
	}
	if len(data) > 1<<20 {
		return nil, agentArtifact{}, errAgentInput
	}
	user, err := a.agentUser(ctx, t.UserID)
	if err != nil {
		return nil, agentArtifact{}, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, agentArtifact{}, err
	}
	defer tx.Rollback(ctx)
	_, session, err := a.lockAgentTask(ctx, tx, t.UserID, t.ID, true)
	if err != nil {
		return nil, agentArtifact{}, err
	}
	if session.WriteDocumentID != "" {
		return nil, agentArtifact{}, errArticleWriteScope
	}
	digest := sha256.Sum256(data)
	hash := hex.EncodeToString(digest[:])
	var existingHash string
	artifact := agentArtifact{TaskID: t.ID, Name: in.Name, MimeType: in.MimeType, Bytes: int64(len(data))}
	err = tx.QueryRow(ctx, `SELECT id::text,digest FROM agent_artifacts WHERE task_id=$1 AND name=$2`, t.ID, in.Name).Scan(&artifact.ID, &existingHash)
	if err == nil {
		if existingHash != hash {
			return nil, artifact, errAgentSessionConflict
		}
		return nil, artifact, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, artifact, err
	}
	artifact.ID, err = randomUUID()
	if err != nil {
		return nil, artifact, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_artifacts(id,task_id,user_id,name,mime_type,digest,data) VALUES($1,$2,$3,$4,$5,$6,$7)`, artifact.ID, t.ID, t.UserID, in.Name, in.MimeType, hash, data); err != nil {
		return nil, artifact, err
	}
	if err = a.checkAgentTaskBudget(ctx, tx, user, t.ID); err != nil {
		return nil, artifact, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, artifact, err
	}
	return nil, artifact, nil
}
func (a *App) agentArtifactDownload(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !validUUID(r.PathValue("artifactId")) {
		http.NotFound(w, r)
		return
	}
	var name, mimeType string
	var data []byte
	err := a.db.QueryRow(r.Context(), `SELECT a.name,a.mime_type,a.data FROM agent_artifacts a JOIN writing_agent_tasks t ON t.id=a.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE a.id=$1 AND a.user_id=$2 AND s.deleted_at IS NULL`, r.PathValue("artifactId"), u.ID).Scan(&name, &mimeType, &data)
	if err != nil {
		agentError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	if r.URL.Query().Get("preview") == "1" && mimeType == "image/jpeg" && http.DetectContentType(data) == mimeType {
		w.Header().Set("Content-Type", mimeType)
		w.Header().Set("Content-Disposition", "inline")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}
