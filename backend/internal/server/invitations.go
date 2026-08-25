package server

import (
	"context"
	"crypto/rand"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const (
	invitationCodeLength          = 16
	invitationRewardBytes   int64 = 500 * 1024 * 1024
	maxInvitationBonusBytes int64 = 5 * 1024 * 1024 * 1024
)

var (
	errInvalidInvitationCode = errors.New("invalid invitation code")
	invitationCodePattern    = regexp.MustCompile(`^[A-Z0-9]{16}$`)
)

// 去掉容易混淆的 0/O/1/I；32 个字符也让随机字节可以无偏地取低 5 位。
const invitationAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func newInvitationCode() (string, error) {
	randomBytes := make([]byte, invitationCodeLength)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}
	code := make([]byte, invitationCodeLength)
	for index, value := range randomBytes {
		code[index] = invitationAlphabet[int(value)&31]
	}
	return string(code), nil
}

func normalizeInvitationCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

func validInvitationCode(code string) bool {
	return invitationCodePattern.MatchString(normalizeInvitationCode(code))
}

func boundedInvitationBonus(bytes int64) int64 {
	if bytes <= 0 {
		return 0
	}
	if bytes >= maxInvitationBonusBytes {
		return maxInvitationBonusBytes
	}
	return bytes
}

// applyInvitationReward 必须和新用户 INSERT 放在同一事务里调用。账本先写入，
// 再给双方加空间；invited_user_id 的唯一约束是重复发奖的最终防线。邀请人行
// 会被锁住，确保并发注册也无法突破单账号 5 GiB 的邀请奖励上限。
func applyInvitationReward(ctx context.Context, tx pgx.Tx, invitedUserID int, rawCode string) error {
	code := normalizeInvitationCode(rawCode)
	if code == "" {
		return nil
	}
	if !validInvitationCode(code) {
		return errInvalidInvitationCode
	}

	var inviterUserID int
	var inviterBonusBytes int64
	if err := tx.QueryRow(ctx, `
		SELECT id, bonus_storage_bytes
		FROM users
		WHERE invitation_code = $1
		FOR UPDATE
	`, code).Scan(&inviterUserID, &inviterBonusBytes); errors.Is(err, pgx.ErrNoRows) {
		return errInvalidInvitationCode
	} else if err != nil {
		return err
	}
	if inviterUserID == invitedUserID {
		return errInvalidInvitationCode
	}

	inviterRewardBytes := invitationRewardBytes
	if remaining := maxInvitationBonusBytes - boundedInvitationBonus(inviterBonusBytes); remaining < inviterRewardBytes {
		inviterRewardBytes = remaining
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO invitations (inviter_user_id, invited_user_id, reward_bytes)
		VALUES ($1, $2, $3)
	`, inviterUserID, invitedUserID, inviterRewardBytes); err != nil {
		return err
	}
	if inviterRewardBytes > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE users
			SET bonus_storage_bytes = bonus_storage_bytes + $2, updated_at = now()
			WHERE id = $1
		`, inviterUserID, inviterRewardBytes); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users
		SET invited_by = $2,
		    bonus_storage_bytes = LEAST(bonus_storage_bytes + $3, $4),
		    updated_at = now()
		WHERE id = $1
	`, invitedUserID, inviterUserID, invitationRewardBytes, maxInvitationBonusBytes); err != nil {
		return err
	}
	return nil
}

func invitationError(w http.ResponseWriter) {
	httpx.ErrorCode(w, http.StatusBadRequest, "invalid_invitation_code", "Invitation code is invalid")
}

type invitedUserSummary struct {
	Name        string    `json:"name"`
	Email       string    `json:"email"`
	RewardBytes int64     `json:"rewardBytes"`
	InvitedAt   time.Time `json:"invitedAt"`
}

func maskInvitationEmail(email string) string {
	local, domain, ok := strings.Cut(strings.TrimSpace(email), "@")
	if !ok || local == "" || domain == "" {
		return "***"
	}
	return string([]rune(local)[0]) + "***@" + domain
}

func (a *App) invitationsOverview(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	var code string
	var successfulInvites int64
	var earnedStorageBytes int64
	err := a.db.QueryRow(r.Context(), `
		SELECT u.invitation_code,
		       COUNT(i.id),
		       COALESCE(SUM(i.reward_bytes), 0)
		FROM users u
		LEFT JOIN invitations i ON i.inviter_user_id = u.id
		WHERE u.id = $1
		GROUP BY u.id, u.invitation_code
	`, user.ID).Scan(&code, &successfulInvites, &earnedStorageBytes)
	if err != nil {
		log.Printf("invitation overview: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	rows, err := a.db.Query(r.Context(), `
		SELECT COALESCE(
		           NULLIF(btrim(invited.nickname), ''),
		           NULLIF(btrim(invited.username), ''),
		           ''
		       ),
		       invited.email,
		       i.reward_bytes,
		       i.created_at
		FROM invitations i
		JOIN users invited ON invited.id = i.invited_user_id
		WHERE i.inviter_user_id = $1
		ORDER BY i.created_at DESC, i.id DESC
		LIMIT 50
	`, user.ID)
	if err != nil {
		log.Printf("invitation list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()

	invitedUsers := make([]invitedUserSummary, 0)
	for rows.Next() {
		var item invitedUserSummary
		var email string
		if err := rows.Scan(&item.Name, &email, &item.RewardBytes, &item.InvitedAt); err != nil {
			log.Printf("scan invitation list: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		item.Email = maskInvitationEmail(email)
		if item.Name == "" {
			item.Name = item.Email
		}
		invitedUsers = append(invitedUsers, item)
	}
	if err := rows.Err(); err != nil {
		log.Printf("iterate invitation list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"invitationCode":       code,
		"successfulInvites":    successfulInvites,
		"rewardPerInviteBytes": invitationRewardBytes,
		"maxBonusStorageBytes": maxInvitationBonusBytes,
		"earnedStorageBytes":   boundedInvitationBonus(earnedStorageBytes),
		"bonusStorageBytes":    boundedInvitationBonus(user.BonusStorageBytes),
		"invitedUsers":         invitedUsers,
	})
}
