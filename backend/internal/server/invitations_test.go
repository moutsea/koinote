package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/config"
	"koinote/backend/internal/migrations"
)

func TestInvitationCodeGeneration(t *testing.T) {
	seen := make(map[string]bool)
	for range 100 {
		code, err := newInvitationCode()
		if err != nil {
			t.Fatalf("生成邀请码: %v", err)
		}
		if len(code) != invitationCodeLength || !validInvitationCode(code) {
			t.Fatalf("生成的邀请码格式无效: %q", code)
		}
		if seen[code] {
			t.Fatalf("生成了重复的邀请码: %q", code)
		}
		seen[code] = true
	}
}

func TestConcurrentOAuthUserCreationIsIdempotent(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设 TEST_DATABASE_URL，跳过 OAuth 并发创建测试（CI 里会跑）")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("连库失败: %v", err)
	}
	defer pool.Close()
	if err := migrations.Apply(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}

	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	profile := oauthProfile{
		Provider:       "google",
		ProviderUserID: "concurrent-" + suffix,
		Email:          "concurrent-" + suffix + "@example.com",
		Name:           "Concurrent User",
	}
	authUserID := profile.Provider + "_" + profile.ProviderUserID
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE auth_user_id = $1`, authUserID)
	})

	app := New(config.Config{SessionSecret: "secret"}, pool)
	const concurrent = 12
	ids := make([]int, concurrent)
	errs := make([]error, concurrent)
	start := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(concurrent)
	for index := range concurrent {
		go func() {
			defer wait.Done()
			<-start
			user, createErr := app.getOrCreateOAuthUser(ctx, profile, "", false)
			ids[index] = user.ID
			errs[index] = createErr
		}()
	}
	close(start)
	wait.Wait()

	for index, createErr := range errs {
		if createErr != nil {
			t.Fatalf("并发调用 %d 返回 oauth_sync_failed 根因: %v", index, createErr)
		}
		if ids[index] == 0 || ids[index] != ids[0] {
			t.Fatalf("并发调用未收敛到同一用户: %v", ids)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE auth_user_id = $1`, authUserID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("并发 OAuth 创建了 %d 个账号", count)
	}
}

func TestInvitationCodeNormalization(t *testing.T) {
	if got := normalizeInvitationCode("  abcdefgh23456789  "); got != "ABCDEFGH23456789" {
		t.Fatalf("归一化结果 = %q", got)
	}
	for _, code := range []string{"", "SHORT", "ABCDEFGHIJKLMNO!", "ABCDEFGHIJKLMNOPQ"} {
		if validInvitationCode(code) {
			t.Fatalf("无效邀请码不应通过: %q", code)
		}
	}
}

func TestBoundedInvitationBonus(t *testing.T) {
	cases := []struct {
		name     string
		input    int64
		expected int64
	}{
		{name: "negative", input: -1, expected: 0},
		{name: "zero", input: 0, expected: 0},
		{name: "below cap", input: invitationRewardBytes, expected: invitationRewardBytes},
		{name: "at cap", input: maxInvitationBonusBytes, expected: maxInvitationBonusBytes},
		{name: "above cap", input: maxInvitationBonusBytes + 1, expected: maxInvitationBonusBytes},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := boundedInvitationBonus(tc.input); got != tc.expected {
				t.Fatalf("boundedInvitationBonus(%d) = %d，期望 %d", tc.input, got, tc.expected)
			}
		})
	}
}

func TestRegisterRejectsMalformedInvitationCodeBeforeDatabase(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "secret"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(`{
		"username":"new-user",
		"email":"new@example.com",
		"password":"password",
		"verificationCode":"123456",
		"invitationCode":"not-valid"
	}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("格式错误的邀请码期望 400，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if code := decodeErrorCode(t, rec); code != "invalid_invitation_code" {
		t.Fatalf("错误码 = %q", code)
	}
}

func TestInvitationsOverviewRequiresAuthentication(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "secret"})
	rec := doRequest(app, http.MethodGet, "/api/invitations")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录期望 401，实际 %d", rec.Code)
	}
}

func TestInvitationRewardAndOAuthIdempotency(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设 TEST_DATABASE_URL，跳过邀请奖励事务测试（CI 里会跑）")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("连库失败: %v", err)
	}
	defer pool.Close()
	if err := migrations.Apply(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}

	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	inviterAuthID := "invite-owner-" + suffix
	inviterCode, _ := newInvitationCode()
	var inviterUserID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified, invitation_code)
		VALUES ($1, $2, true, $3)
		RETURNING id
	`, inviterAuthID, inviterAuthID+"@example.com", inviterCode).Scan(&inviterUserID); err != nil {
		t.Fatalf("创建邀请人: %v", err)
	}
	createdUserIDs := []int{inviterUserID}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM invitations WHERE inviter_user_id = $1 OR invited_user_id = ANY($2)`, inviterUserID, createdUserIDs)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, createdUserIDs)
	})

	app := New(config.Config{
		SessionSecret:   "secret",
		InternalToken:   "internal",
		ImageQuotaBytes: 500 * 1024 * 1024,
	}, pool)
	profile := oauthProfile{
		Provider:       "google",
		ProviderUserID: "invited-" + suffix,
		Email:          "invited-" + suffix + "@example.com",
		Name:           "Invited User",
	}

	invited, err := app.getOrCreateOAuthUser(ctx, profile, strings.ToLower(inviterCode), false)
	if err != nil {
		t.Fatalf("创建受邀 OAuth 用户: %v", err)
	}
	createdUserIDs = append(createdUserIDs, invited.ID)

	if invited.BonusStorageBytes != invitationRewardBytes {
		t.Fatalf("受邀用户奖励 = %d，期望 %d", invited.BonusStorageBytes, invitationRewardBytes)
	}
	var inviterBonus int64
	var invitedBy *int
	if err := pool.QueryRow(ctx, `
		SELECT bonus_storage_bytes FROM users WHERE id = $1
	`, inviterUserID).Scan(&inviterBonus); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT invited_by FROM users WHERE id = $1`, invited.ID).Scan(&invitedBy); err != nil {
		t.Fatal(err)
	}
	if inviterBonus != invitationRewardBytes || invitedBy == nil || *invitedBy != inviterUserID {
		t.Fatalf("邀请关系或奖励错误: inviterBonus=%d invitedBy=%v", inviterBonus, invitedBy)
	}

	// 已存在账号再次 OAuth 登录时，即使 URL 带了别的邀请码，也绝不能重复领奖。
	if _, err := app.getOrCreateOAuthUser(ctx, profile, "", true); err != nil {
		t.Fatalf("既有账号登录不应校验或领取新邀请码: %v", err)
	}
	var ledgerCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM invitations WHERE invited_user_id = $1`, invited.ID).Scan(&ledgerCount); err != nil {
		t.Fatal(err)
	}
	if ledgerCount != 1 {
		t.Fatalf("重复 OAuth 后邀请记录数 = %d，期望 1", ledgerCount)
	}

	invalidProfile := oauthProfile{
		Provider:       "google",
		ProviderUserID: "invalid-invite-" + suffix,
		Email:          "invalid-invite-" + suffix + "@example.com",
		Name:           "Invalid Invite",
	}
	if _, err := app.getOrCreateOAuthUser(ctx, invalidProfile, "", true); !errors.Is(err, errInvalidInvitationCode) {
		t.Fatalf("新 OAuth 账号的无效邀请码期望 errInvalidInvitationCode，实际 %v", err)
	}
	var invalidUserCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE auth_user_id = $1`, "google_"+invalidProfile.ProviderUserID).Scan(&invalidUserCount); err != nil {
		t.Fatal(err)
	}
	if invalidUserCount != 0 {
		t.Fatalf("无效邀请码不应创建 OAuth 用户，实际 %d", invalidUserCount)
	}

	if _, err := pool.Exec(ctx, `
		UPDATE users SET bonus_storage_bytes = $2 WHERE id = $1
	`, inviterUserID, maxInvitationBonusBytes-invitationRewardBytes/2); err != nil {
		t.Fatalf("设置临界奖励额度: %v", err)
	}

	partialProfile := oauthProfile{
		Provider:       "google",
		ProviderUserID: "partial-reward-" + suffix,
		Email:          "partial-reward-" + suffix + "@example.com",
		Name:           "Partial Reward",
	}
	partialInvited, err := app.getOrCreateOAuthUser(ctx, partialProfile, inviterCode, false)
	if err != nil {
		t.Fatalf("创建临界受邀用户: %v", err)
	}
	createdUserIDs = append(createdUserIDs, partialInvited.ID)
	if partialInvited.BonusStorageBytes != invitationRewardBytes {
		t.Fatalf("临界受邀用户奖励 = %d，期望 %d", partialInvited.BonusStorageBytes, invitationRewardBytes)
	}

	var partialLedgerReward int64
	if err := pool.QueryRow(ctx, `
		SELECT reward_bytes FROM invitations WHERE invited_user_id = $1
	`, partialInvited.ID).Scan(&partialLedgerReward); err != nil {
		t.Fatal(err)
	}
	if partialLedgerReward != invitationRewardBytes/2 {
		t.Fatalf("临界邀请实际发放 = %d，期望 %d", partialLedgerReward, invitationRewardBytes/2)
	}

	cappedProfile := oauthProfile{
		Provider:       "google",
		ProviderUserID: "capped-reward-" + suffix,
		Email:          "capped-reward-" + suffix + "@example.com",
		Name:           "Capped Reward",
	}
	cappedInvited, err := app.getOrCreateOAuthUser(ctx, cappedProfile, inviterCode, false)
	if err != nil {
		t.Fatalf("创建上限后受邀用户: %v", err)
	}
	createdUserIDs = append(createdUserIDs, cappedInvited.ID)

	var cappedLedgerReward int64
	if err := pool.QueryRow(ctx, `
		SELECT reward_bytes FROM invitations WHERE invited_user_id = $1
	`, cappedInvited.ID).Scan(&cappedLedgerReward); err != nil {
		t.Fatal(err)
	}
	if cappedLedgerReward != 0 {
		t.Fatalf("达到上限后邀请人仍获奖励 %d", cappedLedgerReward)
	}
	if err := pool.QueryRow(ctx, `SELECT bonus_storage_bytes FROM users WHERE id = $1`, inviterUserID).Scan(&inviterBonus); err != nil {
		t.Fatal(err)
	}
	if inviterBonus != maxInvitationBonusBytes {
		t.Fatalf("邀请奖励突破或未达到上限：%d", inviterBonus)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE users SET bonus_storage_bytes = $2 WHERE id = $1
	`, inviterUserID, maxInvitationBonusBytes+1); err == nil {
		t.Fatal("数据库约束允许 bonus_storage_bytes 突破 5 GiB")
	}

	req := httptest.NewRequest(http.MethodGet, "/api/invitations", nil)
	req.Header.Set("X-Koinote-Internal-Token", "internal")
	req.Header.Set("X-Auth-User-Id", inviterAuthID)
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("邀请概览期望 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var overview struct {
		InvitationCode    string `json:"invitationCode"`
		SuccessfulInvites int64  `json:"successfulInvites"`
		EarnedBytes       int64  `json:"earnedStorageBytes"`
		BonusBytes        int64  `json:"bonusStorageBytes"`
		MaxBonusBytes     int64  `json:"maxBonusStorageBytes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &overview); err != nil {
		t.Fatal(err)
	}
	if overview.InvitationCode != inviterCode || overview.SuccessfulInvites != 3 || overview.EarnedBytes != invitationRewardBytes+invitationRewardBytes/2 || overview.BonusBytes != maxInvitationBonusBytes || overview.MaxBonusBytes != maxInvitationBonusBytes {
		t.Fatalf("邀请概览不符: %+v", overview)
	}

}
