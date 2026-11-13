package server

import (
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const agentCoverInstructions = `When the user requests an article cover, call generate_cover with a visual prompt and aspect ratio; do not claim image generation is unavailable. Read the article first when its content informs the cover. A successful generation costs an additional 20 Credits, separate from text-model usage. The tool saves one cover per task and the client displays its preview/download. If status is generating, call generate_cover again with the EXACT same prompt and ratio to wait for the existing generation; do not finish until it succeeds or reports an error. Retrying the same prompt returns the saved image without another charge. For another variation or a retry after failure, ask the user to send a new message. Generating a cover does not edit the article or publish anything. If both a cover and article edits are requested, finish cover generation before proposing the final article revision, since approval completes the task. Do not fabricate image URLs, embed base64, or submit an unchanged article just to return a cover. If the service reports an error, explain that specific error rather than denying the capability.`

const agentCoverWait = 40 * time.Second    // Below the upstream MCP client's 60s request limit.
const agentCoverRunLimit = 5 * time.Minute // Fits within the Agent's tool-call/step budget, including polling.
const agentCoverFailed = "封面生成失败或超时，本次未扣除生图 Credits。请发送新消息重试"
const agentCoversHeader = "X-Koinote-Agent-Covers"

var errAgentCoverClient = errors.New("当前客户端无法接收生成的封面，请升级客户端或使用网页版后重试；未扣除生图 Credits")

type agentCoverState struct {
	Status         string `json:"status"`
	ErrorCode      string `json:"errorCode,omitempty"`
	ChargedCredits int64  `json:"chargedCredits"`
}

type agentCoverError string

func (code agentCoverError) Error() string {
	switch code {
	case "service_unavailable":
		return "封面生成服务暂未配置，请稍后重试；本次未扣除生图 Credits"
	case "rate_limited":
		return "封面生成次数已达本小时上限，请稍后重试；本次未扣除生图 Credits"
	case "insufficient_credits":
		return "可用 Credits 不足：封面生成需要额外 20 Credits；当前任务预留的文本费用不包含生图。请补充 Credits 后发送新消息重试；本次未扣除生图 Credits"
	default:
		return agentCoverFailed
	}
}

func agentCoverPrompt(t writingTask) string {
	if t.CoverEnabled {
		return agentCoverInstructions
	}
	return "This client cannot display generated covers. If asked to generate an image, explain in the user's language that they should upgrade the desktop client or use the web app. Do not generate or charge for an image in this task. Other writing tasks remain available."
}

var errAgentCoverGenerating = errors.New("cover_generation_in_progress")

type agentCoverInput struct {
	Prompt string            `json:"prompt" jsonschema:"Visual brief for the cover, 1 to 1200 characters. Use only when the user requests image/cover generation; do not generate speculatively."`
	Ratio  string            `json:"ratio,omitempty" jsonschema:"Aspect ratio W:H, e.g. 2.35:1, 16:9 or 1:1. Defaults to 2.35:1. Reuse the exact prompt/ratio on retries."`
	Proof  *agentIntentProof `json:"_agentTaskProof,omitempty" jsonschema:"Reserved host operation proof. Never supply or invent this field."`
}

type agentCoverOutput struct {
	Artifact        agentArtifact `json:"artifact"`
	Credits         int64         `json:"credits"`
	Status          string        `json:"status"`
	OperationStatus string        `json:"operationStatus"`
	CheckedAt       string        `json:"checkedAt,omitempty"`
}

func normalizeAgentCover(in agentCoverInput) (agentCoverInput, error) {
	in.Proof = nil
	in.Prompt, in.Ratio = strings.TrimSpace(in.Prompt), strings.TrimSpace(in.Ratio)
	if in.Ratio == "" {
		in.Ratio = wechatCoverRatioWide
	}
	if in.Prompt == "" || utf8.RuneCountInString(in.Prompt) > wechatCoverPromptMaxRunes || !validWechatCoverRatio(in.Ratio) {
		return in, errors.New("封面提示词需为 1–1200 字，比例请使用 2.35:1、16:9 或 1:1 等 W:H 格式")
	}
	return in, nil
}

func agentCoverEffects(t writingTask) []agentIntentEffect {
	return []agentIntentEffect{{ResourceID: "new:" + t.ID + ":cover", Kind: "create"}}
}

func (a *App) verifyAgentCoverProof(t writingTask, s agentSession, in agentCoverInput, proof *agentIntentProof) error {
	if t.IntentVersion == 0 {
		return nil
	}
	if proof == nil || proof.TaskID != t.SessionID || proof.SessionID != t.SessionID || proof.Version != t.IntentVersion || proof.CurrentMessageID != agentUserMessageID(t.ID) || !hmac.Equal([]byte(proof.Token), []byte(a.agentIntentToken(t, s, "generate_cover", in, agentCoverEffects(t)))) {
		return errors.New("invalid_cover_task_proof")
	}
	return nil
}

func (a *App) agentGenerateCover(ctx context.Context, _ *mcp.CallToolRequest, in agentCoverInput) (*mcp.CallToolResult, agentCoverOutput, error) {
	// The bounded generation outlives individual MCP polling requests and
	// rechecks task cancellation before saving/charging. A unique DB receipt keeps
	// retries on one generation without pinning a connection during image I/O.
	type result struct {
		out agentCoverOutput
		err error
	}
	done := make(chan result, 1)
	work, cancel := context.WithTimeout(context.WithoutCancel(ctx), agentCoverRunLimit)
	go func() {
		defer cancel()
		until := time.Now().Add(agentCoverWait - time.Second)
		for {
			_, out, err := a.generateAgentCover(work, in)
			if !errors.Is(err, errAgentCoverGenerating) || time.Now().After(until) {
				done <- result{out, err}
				return
			}
			select {
			case <-time.After(time.Second):
			case <-work.Done():
				done <- result{err: work.Err()}
				return
			}
		}
	}()
	timer := time.NewTimer(agentCoverWait)
	defer timer.Stop()
	select {
	case r := <-done:
		if !errors.Is(r.err, errAgentCoverGenerating) {
			return nil, r.out, r.err
		}
	case <-timer.C:
	case <-ctx.Done():
		return nil, agentCoverOutput{}, ctx.Err()
	}
	return nil, agentCoverOutput{Status: "generating", OperationStatus: "proposed", CheckedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

func (a *App) generateAgentCover(ctx context.Context, original agentCoverInput) (*mcp.CallToolResult, agentCoverOutput, error) {
	t := ctx.Value(writingMCPContext{}).(writingTask)
	in, err := normalizeAgentCover(original)
	if err != nil {
		return nil, agentCoverOutput{}, err
	}
	user, err := a.agentUser(ctx, t.UserID)
	if err != nil {
		return nil, agentCoverOutput{}, err
	}
	setting, settingErr := a.loadSystemLLMConfig(ctx, "image")
	input, _ := json.Marshal(in)
	name := "koi-cover-" + koiDigest(input) + ".jpg"
	var artifact agentArtifact
	artifact.TaskID = t.ID
	// Check task scope even on retries: a cancelled/deleted task cannot restart
	// paid work. Article sessions may save this image, never arbitrary files.
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, agentCoverOutput{}, err
	}
	current, session, err := a.lockAgentTask(ctx, tx, t.UserID, t.ID, true)
	if err == nil && !current.CoverEnabled {
		err = errAgentCoverClient
	}
	if err == nil {
		err = a.verifyAgentCoverProof(current, session, in, original.Proof)
	}
	if err == nil {
		err = a.checkAgentTaskBudget(ctx, tx, user, t.ID)
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, agentCoverOutput{}, err
	}
	err = tx.QueryRow(ctx, `SELECT id::text,name,mime_type,octet_length(data) FROM agent_artifacts WHERE task_id=$1 AND name LIKE 'koi-cover-%' ORDER BY created_at LIMIT 1`, t.ID).Scan(&artifact.ID, &artifact.Name, &artifact.MimeType, &artifact.Bytes)
	_ = tx.Rollback(ctx)
	if err == nil {
		if artifact.Name != name {
			return nil, agentCoverOutput{}, errors.New("本轮已生成一张封面。若需要其他版本，请发送新消息，避免重复扣费")
		}
		return nil, agentCoverOutput{Artifact: artifact, Credits: wechatCoverGenerationCredits, Status: "generated_not_applied", OperationStatus: "applied"}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, agentCoverOutput{}, err
	}
	// A persisted attempt prevents a failed/lost response from silently starting
	// another provider request. An interrupted backend run also fails closed.
	var active bool
	var failureCode string
	err = a.db.QueryRow(ctx, `SELECT status='generating' AND created_at>clock_timestamp()-interval '5 minutes',error_code FROM agent_cover_generations WHERE task_id=$1`, t.ID).Scan(&active, &failureCode)
	if err == nil {
		if active {
			return nil, agentCoverOutput{}, errAgentCoverGenerating
		}
		// The image may have committed just after the earlier artifact lookup.
		if err = a.db.QueryRow(ctx, `SELECT id::text,name,mime_type,octet_length(data) FROM agent_artifacts WHERE task_id=$1 AND name=$2`, t.ID, name).Scan(&artifact.ID, &artifact.Name, &artifact.MimeType, &artifact.Bytes); err == nil {
			return nil, agentCoverOutput{Artifact: artifact, Credits: wechatCoverGenerationCredits, Status: "generated_not_applied", OperationStatus: "applied"}, nil
		}
		// Surface interrupted attempts as failures, including after a restart.
		if _, err = a.db.Exec(ctx, `UPDATE agent_cover_generations SET status='failed',error_code='generation_failed' WHERE task_id=$1 AND status='generating' AND created_at<=clock_timestamp()-interval '5 minutes'`, t.ID); err != nil {
			return nil, agentCoverOutput{}, err
		}
		return nil, agentCoverOutput{}, agentCoverError(failureCode)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, agentCoverOutput{}, err
	}
	// Claim before reserving: concurrent retries must not temporarily reserve
	// two image fees or fail for insufficient funds while the first is running.
	if _, err = a.db.Exec(ctx, `INSERT INTO agent_cover_generations(task_id) VALUES($1)`, t.ID); err != nil {
		var conflict *pgconn.PgError
		if errors.As(err, &conflict) && conflict.Code == "23505" {
			return nil, agentCoverOutput{}, errAgentCoverGenerating
		}
		return nil, agentCoverOutput{}, err
	}
	committed := false
	failureCode = "generation_failed"
	var reservation creditReservation
	defer func() {
		if !committed {
			cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if tx, e := a.db.Begin(cleanup); e == nil {
				defer tx.Rollback(cleanup)
				if reservation.ReservationID != "" {
					_, e = releaseCreditReservationTx(cleanup, tx, t.UserID, reservation.ReservationID)
				}
				if e == nil {
					_, e = tx.Exec(cleanup, `UPDATE agent_cover_generations SET status='failed',error_code=$2 WHERE task_id=$1 AND status='generating'`, t.ID, failureCode)
				}
				if e == nil {
					_ = tx.Commit(cleanup)
				}
			}
		}
	}()
	if settingErr != nil || !setting.Enabled {
		failureCode = "service_unavailable"
		return nil, agentCoverOutput{}, agentCoverError(failureCode)
	}
	if !a.rateLimit().allow("wechat-cover:"+fmt.Sprint(t.UserID), wechatCoverGenerateLimit, wechatCoverGenerateWindow) {
		failureCode = "rate_limited"
		return nil, agentCoverOutput{}, agentCoverError(failureCode)
	}
	reservation, err = a.reserveCreditReservation(ctx, t.UserID, nil, wechatCoverGenerationCredits, wechatCoverReservationTTL)
	if err != nil {
		if errors.Is(err, errInsufficientCredits) {
			failureCode = "insufficient_credits"
			err = agentCoverError(failureCode)
		}
		return nil, agentCoverOutput{}, err
	}
	generation, cancel := context.WithTimeout(ctx, agentCoverRunLimit)
	defer cancel()
	cover, err := a.generateWechatCoverWithConfig(generation, in.Prompt, in.Ratio, nil, setting)
	if err != nil {
		return nil, agentCoverOutput{}, agentCoverError(failureCode)
	}
	tx, err = a.db.Begin(ctx)
	if err != nil {
		return nil, agentCoverOutput{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, t.UserID); err == nil {
		_, err = lockCreditAccount(ctx, tx, t.UserID)
	}
	if err == nil {
		_, _, err = a.lockAgentTask(ctx, tx, t.UserID, t.ID, true)
	}
	if err != nil {
		return nil, agentCoverOutput{}, err
	}
	artifact = agentArtifact{TaskID: t.ID, Name: name, MimeType: cover.MimeType, Bytes: int64(len(cover.Data))}
	artifact.ID, err = randomUUID()
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO agent_artifacts(id,task_id,user_id,name,mime_type,digest,data) VALUES($1,$2,$3,$4,$5,$6,$7)`, artifact.ID, t.ID, t.UserID, name, artifact.MimeType, koiDigest(cover.Data), cover.Data)
	}
	if err == nil {
		err = a.checkAgentTaskBudget(ctx, tx, user, t.ID)
	}
	if err == nil {
		_, _, err = commitCreditReservationTx(ctx, tx, t.UserID, reservation.ReservationID, int(wechatCoverGenerationCredits*creditTokensPerCredit), map[string]any{"feature": "koi_cover_generation", "taskId": t.ID, "ratio": in.Ratio, "model": cover.Model})
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE writing_agent_tasks SET charged_credits=charged_credits+$2,updated_at=now() WHERE id=$1`, t.ID, wechatCoverGenerationCredits)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE agent_cover_generations SET status='completed' WHERE task_id=$1`, t.ID)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		return nil, agentCoverOutput{}, err
	}
	committed = true
	return nil, agentCoverOutput{Artifact: artifact, Credits: wechatCoverGenerationCredits, Status: "generated_not_applied", OperationStatus: "applied"}, nil
}
