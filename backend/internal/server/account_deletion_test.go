package server

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/stripe/stripe-go/v82"

	"koinote/backend/internal/config"
)

func TestAccountDeletionEndToEnd(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	app := New(config.Config{SessionSecret: "account-deletion-secret"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	inviter := seedMCPUser(t, pool, app, membershipTierFree)
	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	docID := "account-delete-doc-" + suffix
	objectKey := "u/" + user.AuthUserID + "/" + suffix + "12345678.png"
	tokenHash := sha256.Sum256([]byte("account-delete-token-" + suffix))
	refreshHash := sha256.Sum256([]byte("account-delete-refresh-" + suffix))
	accessHash := sha256.Sum256([]byte("account-delete-access-" + suffix))

	var documentID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO documents (doc_id, user_id, title, content)
		VALUES ($1, $2, 'Delete me', 'content') RETURNING id
	`, docID, user.ID).Scan(&documentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO document_versions (document_id, revision, title, content, source)
		VALUES ($1, 1, 'Old title', 'old content', 'web')
	`, documentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO image_objects (object_key, user_id, bytes) VALUES ($1, $2, 1234)
	`, objectKey, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO invitations (inviter_user_id, invited_user_id, reward_bytes)
		VALUES ($1, $2, 524288000)
	`, inviter.ID, user.ID); err != nil {
		t.Fatal(err)
	}
	var tokenID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mcp_tokens (token_id, user_id, name, token_hash, token_hint, scope)
		VALUES ($1, $2, 'Delete token', $3, '…delete', 'write') RETURNING id
	`, "account-delete-token-"+suffix, user.ID, tokenHash[:]).Scan(&tokenID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mcp_audit_logs (user_id, token_id, tool_name, document_id, doc_id, result, duration_ms)
		VALUES ($1, $2, 'update_document', $3, $4, 'success', 3)
	`, user.ID, tokenID, documentID, docID); err != nil {
		t.Fatal(err)
	}
	var refreshID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO desktop_refresh_tokens
			(token_id, family_id, user_id, token_hash, session_version, expires_at)
		VALUES ($1, $2, $3, $4, 1, now() + interval '1 day') RETURNING id
	`, "refresh-"+suffix, "family-"+suffix, user.ID, refreshHash[:]).Scan(&refreshID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO desktop_access_tokens
			(token_hash, refresh_token_id, user_id, session_version, expires_at)
		VALUES ($1, $2, $3, 1, now() + interval '15 minutes')
	`, accessHash[:], refreshID, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO stripe_payments
			(checkout_session_id, payment_intent_id, customer_id, user_id, plan_code, amount, currency, status)
		VALUES ($1, $2, $3, $4, 'lifetime', 399, 'usd', 'paid')
	`, "cs_"+suffix, "pi_"+suffix, "cus_"+suffix, user.ID); err != nil {
		t.Fatal(err)
	}

	cookie := sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion)
	mismatch := requestWithCookie(app.accountDelete, http.MethodDelete, `{"confirmation":"wrong@example.test"}`, cookie)
	if mismatch.Code != http.StatusBadRequest || decodeErrorCode(t, mismatch) != "account_deletion_confirmation_mismatch" {
		t.Fatalf("错误邮箱应拒绝注销，实际 %d %s", mismatch.Code, mismatch.Body.String())
	}

	deleted := requestWithCookie(app.accountDelete, http.MethodDelete, `{"confirmation":"`+user.Email+`"}`, cookie)
	if deleted.Code != http.StatusOK {
		t.Fatalf("注销失败: %d %s", deleted.Code, deleted.Body.String())
	}
	if cleared := findSessionCookie(deleted); cleared == nil || cleared.MaxAge >= 0 {
		t.Fatal("注销成功后必须清除浏览器会话 Cookie")
	}

	for table, target := range map[string]struct {
		column string
		value  any
	}{
		"users":                  {"id", user.ID},
		"documents":              {"user_id", user.ID},
		"document_versions":      {"document_id", documentID},
		"mcp_tokens":             {"user_id", user.ID},
		"mcp_audit_logs":         {"user_id", user.ID},
		"desktop_refresh_tokens": {"user_id", user.ID},
		"desktop_access_tokens":  {"user_id", user.ID},
		"image_objects":          {"user_id", user.ID},
	} {
		var count int
		query := "SELECT count(*) FROM " + table + " WHERE " + target.column + " = $1"
		if err := pool.QueryRow(ctx, query, target.value).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s 未级联清理，count=%d err=%v", table, count, err)
		}
	}
	var invitationCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM invitations WHERE inviter_user_id = $1 OR invited_user_id = $1
	`, user.ID).Scan(&invitationCount); err != nil || invitationCount != 0 {
		t.Fatalf("邀请记录未删除，count=%d err=%v", invitationCount, err)
	}
	var paymentUserID *int
	if err := pool.QueryRow(ctx, `SELECT user_id FROM stripe_payments WHERE checkout_session_id = $1`, "cs_"+suffix).Scan(&paymentUserID); err != nil {
		t.Fatalf("财务记录应保留: %v", err)
	}
	if paymentUserID != nil {
		t.Fatalf("财务记录应解除账号关联，user_id=%v", *paymentUserID)
	}
	if err := app.insertProductMilestone(ctx, user.ID, milestoneFirstExport); err != nil {
		t.Fatalf("注销完成后的里程碑写入应安全忽略: %v", err)
	}
	recentPayments, err := app.loadAdminRecentPayments(ctx)
	if err != nil {
		t.Fatalf("读取含注销账号的近期付款: %v", err)
	}
	detachedPaymentFound := false
	for _, payment := range recentPayments {
		if payment.UserName == nil && payment.UserEmail == nil {
			detachedPaymentFound = true
			break
		}
	}
	if !detachedPaymentFound {
		t.Fatal("注销账号的付款仍应出现在管理后台近期付款中")
	}
	acknowledged, err := app.acknowledgeDetachedCheckout(ctx, validatedLifetimeCheckout{
		SessionID:       "cs_" + suffix,
		PaymentIntentID: "pi_" + suffix,
		CustomerID:      "cus_" + suffix,
		UserID:          user.ID,
		AuthUserID:      user.AuthUserID,
		Amount:          399,
		Currency:        "usd",
	}, "evt_"+suffix)
	if err != nil || !acknowledged {
		t.Fatalf("注销后的 Stripe webhook 重试应被幂等接收，ack=%v err=%v", acknowledged, err)
	}
	var deletionUserID *int
	if err := pool.QueryRow(ctx, `SELECT user_id FROM pending_image_deletions WHERE object_key = $1`, objectKey).Scan(&deletionUserID); err != nil {
		t.Fatalf("图片待删任务应保留: %v", err)
	}
	if deletionUserID != nil {
		t.Fatalf("图片待删任务应解除账号关联，user_id=%v", *deletionUserID)
	}

	_, _ = pool.Exec(ctx, `DELETE FROM stripe_payments WHERE checkout_session_id = $1`, "cs_"+suffix)
	_, _ = pool.Exec(ctx, `DELETE FROM pending_image_deletions WHERE object_key = $1`, objectKey)
}

func TestAccountDeletionChecksStripeAfterLocalCheckoutExpiry(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	app := New(config.Config{SessionSecret: "account-deletion-stripe-secret"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierFree)
	defer func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, user.ID)
	}()

	sessionID := "cs_account_delete_" + user.AuthUserID
	if _, err := pool.Exec(ctx, `
		INSERT INTO stripe_checkout_attempts (
			user_id, checkout_session_id, checkout_url, currency, client, expires_at
		) VALUES ($1, $2, 'https://checkout.stripe.test/account-delete', 'usd', 'web', now() - interval '1 hour')
	`, user.ID, sessionID); err != nil {
		t.Fatal(err)
	}
	stripeClient := &fakeStripeCheckoutClient{
		expireErr: errors.New("checkout is already complete"),
		retrieveResult: &stripe.CheckoutSession{
			ID:     sessionID,
			Status: stripe.CheckoutSessionStatusComplete,
		},
	}
	app.stripeCheckout = stripeClient

	if err := app.expireCheckoutBeforeAccountDeletion(ctx, user.ID); !errors.Is(err, errAccountDeletionCheckout) {
		t.Fatalf("Stripe 已完成的本地过期 Session 必须阻止注销，实际错误 %v", err)
	}
	cookie := sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion)
	blocked := requestWithCookie(
		app.accountDelete,
		http.MethodDelete,
		`{"confirmation":"`+user.Email+`"}`,
		cookie,
	)
	if blocked.Code != http.StatusConflict || decodeErrorCode(t, blocked) != "account_deletion_payment_pending" {
		t.Fatalf("本地过期但 Stripe 已完成的 Session 应返回付款处理中，实际 %d %s", blocked.Code, blocked.Body.String())
	}
	if err := app.cleanupStripeCheckoutAttempts(ctx); err != nil {
		t.Fatalf("清理已完成 Session: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM stripe_checkout_attempts WHERE user_id = $1 AND checkout_session_id = $2
	`, user.ID, sessionID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("Stripe 已完成但 webhook 尚未入账的 Session 不得被后台清理")
	}

	stripeClient.retrieveResult.Status = stripe.CheckoutSessionStatusExpired
	if err := app.cleanupStripeCheckoutAttempts(ctx); err != nil {
		t.Fatalf("清理 Stripe 已过期 Session: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM stripe_checkout_attempts WHERE user_id = $1 AND checkout_session_id = $2
	`, user.ID, sessionID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("Stripe 已确认过期的 Session 应被后台清理")
	}
}

func TestAccountDeletionRechecksCheckoutAfterWaitingForUserLock(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	app := New(config.Config{SessionSecret: "account-deletion-race-secret"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierFree)
	defer func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, user.ID)
	}()

	creating, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = creating.Rollback(ctx) }()
	if _, err := creating.Exec(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, user.ID); err != nil {
		t.Fatal(err)
	}

	sessionID := "cs_account_delete_race_" + user.AuthUserID
	app.stripeCheckout = &fakeStripeCheckoutClient{
		expireErr: errors.New("checkout is already complete"),
		retrieveResult: &stripe.CheckoutSession{
			ID:     sessionID,
			Status: stripe.CheckoutSessionStatusComplete,
		},
	}
	result := make(chan error, 1)
	go func() {
		deleteCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		result <- app.deleteAccountData(deleteCtx, user, user.Email)
	}()

	select {
	case err := <-result:
		t.Fatalf("注销不应绕过正在创建 Checkout 持有的用户锁，提前返回 %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if _, err := creating.Exec(ctx, `
		INSERT INTO stripe_checkout_attempts (
			user_id, checkout_session_id, checkout_url, currency, client, expires_at
		) VALUES ($1, $2, 'https://checkout.stripe.test/account-delete-race', 'usd', 'web', now() + interval '1 hour')
	`, user.ID, sessionID); err != nil {
		t.Fatal(err)
	}
	if err := creating.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	if err := <-result; !errors.Is(err, errAccountDeletionCheckout) {
		t.Fatalf("等待 Checkout 创建完成后必须重新检查并阻止注销，实际错误 %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, user.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("付款处理中不得删除账号")
	}
}
