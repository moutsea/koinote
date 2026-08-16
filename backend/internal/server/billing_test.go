package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stripe/stripe-go/v82"
	"github.com/stripe/stripe-go/v82/webhook"

	"koinote/backend/internal/config"
	"koinote/backend/internal/migrations"
	"koinote/backend/internal/model"
)

type fakeStripeCheckoutClient struct {
	createdParams  *stripe.CheckoutSessionCreateParams
	createResponse *stripe.CheckoutSession
	retrieveResult *stripe.CheckoutSession
	expiredIDs     []string
}

type fakePaymentNotifier struct {
	notifications []paymentNotification
	err           error
}

type concurrentStripeCheckoutClient struct {
	mu          sync.Mutex
	prefix      string
	createCount int
	expiredIDs  []string
	sessions    map[string]*stripe.CheckoutSession
}

func newConcurrentStripeCheckoutClient(prefix string) *concurrentStripeCheckoutClient {
	return &concurrentStripeCheckoutClient{prefix: prefix, sessions: make(map[string]*stripe.CheckoutSession)}
}

func (f *concurrentStripeCheckoutClient) Create(_ context.Context, _ *stripe.CheckoutSessionCreateParams) (*stripe.CheckoutSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCount++
	session := &stripe.CheckoutSession{
		ID:        "cs_test_attempt_" + f.prefix + "_" + strconv.Itoa(f.createCount),
		URL:       "https://checkout.stripe.test/session/" + strconv.Itoa(f.createCount),
		Status:    stripe.CheckoutSessionStatusOpen,
		ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}
	f.sessions[session.ID] = session
	return session, nil
}

func (f *concurrentStripeCheckoutClient) Retrieve(_ context.Context, sessionID string, _ *stripe.CheckoutSessionRetrieveParams) (*stripe.CheckoutSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	session := f.sessions[sessionID]
	if session == nil {
		return nil, errors.New("session not found")
	}
	copy := *session
	return &copy, nil
}

func (f *concurrentStripeCheckoutClient) Expire(_ context.Context, sessionID string, _ *stripe.CheckoutSessionExpireParams) (*stripe.CheckoutSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	session := f.sessions[sessionID]
	if session == nil {
		return nil, errors.New("session not found")
	}
	session.Status = stripe.CheckoutSessionStatusExpired
	f.expiredIDs = append(f.expiredIDs, sessionID)
	copy := *session
	return &copy, nil
}

func (f *concurrentStripeCheckoutClient) snapshot() (int, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.createCount, append([]string(nil), f.expiredIDs...)
}

func (f *fakePaymentNotifier) NotifyPayment(_ context.Context, notification paymentNotification) error {
	f.notifications = append(f.notifications, notification)
	return f.err
}

func (f *fakeStripeCheckoutClient) Create(_ context.Context, params *stripe.CheckoutSessionCreateParams) (*stripe.CheckoutSession, error) {
	f.createdParams = params
	return f.createResponse, nil
}

func (f *fakeStripeCheckoutClient) Retrieve(_ context.Context, _ string, _ *stripe.CheckoutSessionRetrieveParams) (*stripe.CheckoutSession, error) {
	return f.retrieveResult, nil
}

func (f *fakeStripeCheckoutClient) Expire(_ context.Context, sessionID string, _ *stripe.CheckoutSessionExpireParams) (*stripe.CheckoutSession, error) {
	f.expiredIDs = append(f.expiredIDs, sessionID)
	return &stripe.CheckoutSession{ID: sessionID, Status: stripe.CheckoutSessionStatusExpired}, nil
}

func paidLifetimeCheckout() *stripe.CheckoutSession {
	return &stripe.CheckoutSession{
		ID:                "cs_test_membership",
		Mode:              stripe.CheckoutSessionModePayment,
		PaymentStatus:     stripe.CheckoutSessionPaymentStatusPaid,
		AmountTotal:       399,
		Currency:          stripe.CurrencyUSD,
		ClientReferenceID: "auth-user-1",
		Metadata: map[string]string{
			"service":              stripeServiceName,
			"koinote_plan":         lifetimePlanCode,
			"koinote_user_id":      "42",
			"koinote_auth_user_id": "auth-user-1",
			"koinote_currency":     "usd",
		},
		LineItems: &stripe.LineItemList{Data: []*stripe.LineItem{
			{
				Price:       &stripe.Price{ID: "price_inline", Product: &stripe.Product{ID: "prod_lifetime"}},
				Quantity:    1,
				AmountTotal: 399,
				Currency:    stripe.CurrencyUSD,
			},
		}},
		PaymentIntent: &stripe.PaymentIntent{ID: "pi_membership"},
		Customer:      &stripe.Customer{ID: "cus_membership"},
	}
}

func TestLifetimeCheckoutParamsUseFixedPriceAndOwnership(t *testing.T) {
	cfg := config.Config{
		AppURL:                  "https://koinote.app/",
		StripeLifetimeProductID: "prod_lifetime",
	}
	user := model.User{ID: 42, AuthUserID: "auth-user-1", Email: "user@example.com"}
	price, ok := lifetimePriceFor("usd")
	if !ok {
		t.Fatal("USD 价格不存在")
	}
	params := lifetimeCheckoutParams(cfg, user, price, "attempt-1", checkoutClientWeb)

	if stripe.StringValue(params.Mode) != string(stripe.CheckoutSessionModePayment) {
		t.Fatalf("Checkout mode = %q", stripe.StringValue(params.Mode))
	}
	if len(params.LineItems) != 1 || params.LineItems[0].Price != nil || params.LineItems[0].PriceData == nil ||
		stripe.StringValue(params.LineItems[0].PriceData.Product) != "prod_lifetime" ||
		stripe.StringValue(params.LineItems[0].PriceData.Currency) != "usd" ||
		stripe.Int64Value(params.LineItems[0].PriceData.UnitAmount) != 399 ||
		stripe.Int64Value(params.LineItems[0].Quantity) != 1 {
		t.Fatalf("Checkout 必须只为固定 Product 创建一份白名单价格: %+v", params.LineItems)
	}
	if stripe.StringValue(params.ClientReferenceID) != user.AuthUserID ||
		params.Metadata["service"] != stripeServiceName ||
		params.Metadata["koinote_user_id"] != "42" ||
		params.Metadata["koinote_auth_user_id"] != user.AuthUserID ||
		params.Metadata["koinote_currency"] != "usd" {
		t.Fatalf("用户归属元数据不完整: %+v", params.Metadata)
	}
	if params.PaymentIntentData == nil || params.PaymentIntentData.Metadata["service"] != stripeServiceName ||
		params.PaymentIntentData.Metadata["koinote_plan"] != lifetimePlanCode {
		t.Fatalf("PaymentIntent 缺少服务隔离元数据: %+v", params.PaymentIntentData)
	}
	if stripe.StringValue(params.SuccessURL) != "https://koinote.app/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}" {
		t.Fatalf("成功回跳地址不正确: %q", stripe.StringValue(params.SuccessURL))
	}
	if params.Metadata["koinote_client"] != checkoutClientWeb {
		t.Fatalf("Checkout 客户端元数据 = %q", params.Metadata["koinote_client"])
	}
	if len(params.PaymentMethodTypes) != 0 {
		t.Fatalf("应由 Stripe 动态选择已启用且适配币种的支付方式: %+v", params.PaymentMethodTypes)
	}
	if stripe.StringValue(params.IdempotencyKey) != lifetimeCheckoutIdempotencyKey(cfg, user, price, "attempt-1", checkoutClientWeb) ||
		!strings.HasPrefix(stripe.StringValue(params.IdempotencyKey), "koinote-lifetime-v4-single-session-desktop-return-") {
		t.Fatalf("缺少按参数版本和用户固定的 Stripe 幂等键: %q", stripe.StringValue(params.IdempotencyKey))
	}
	if stripe.StringValue(params.CustomerEmail) != user.Email ||
		stripe.StringValue(params.CustomerCreation) != string(stripe.CheckoutSessionCustomerCreationAlways) {
		t.Fatal("首次购买应预填邮箱并创建 Stripe Customer")
	}
}

func TestLifetimeCheckoutIdempotencyKeyTracksVariableParams(t *testing.T) {
	cfg := config.Config{AppURL: "https://koinote.app/", StripeLifetimeProductID: "prod_lifetime"}
	user := model.User{AuthUserID: "auth-user-1", Email: "user@example.com"}
	usd, _ := lifetimePriceFor("usd")
	eur, _ := lifetimePriceFor("eur")
	base := lifetimeCheckoutIdempotencyKey(cfg, user, usd, "attempt-1", checkoutClientWeb)

	if base != lifetimeCheckoutIdempotencyKey(cfg, user, usd, "attempt-1", checkoutClientWeb) {
		t.Fatal("相同 Checkout 参数必须生成稳定的幂等键")
	}
	if base == lifetimeCheckoutIdempotencyKey(cfg, user, usd, "attempt-2", checkoutClientWeb) {
		t.Fatal("新的购买尝试必须生成新的幂等键，不能复用已取消或过期的 Session")
	}
	changedURL := cfg
	changedURL.AppURL = "https://preview.koinote.app"
	if base == lifetimeCheckoutIdempotencyKey(changedURL, user, usd, "attempt-1", checkoutClientWeb) {
		t.Fatal("回跳地址变化后必须生成新的幂等键")
	}
	if base == lifetimeCheckoutIdempotencyKey(cfg, user, eur, "attempt-1", checkoutClientWeb) {
		t.Fatal("币种变化后必须生成新的幂等键")
	}
	customerID := "cus_existing"
	user.StripeCustomerID = &customerID
	if base == lifetimeCheckoutIdempotencyKey(cfg, user, usd, "attempt-1", checkoutClientWeb) {
		t.Fatal("Customer 参数变化后必须生成新的幂等键")
	}
	user.StripeCustomerID = nil
	if base == lifetimeCheckoutIdempotencyKey(cfg, user, usd, "attempt-1", checkoutClientDesktop) {
		t.Fatal("桌面回跳参数变化后必须生成新的幂等键")
	}
}

func TestLifetimeCheckoutParamsReuseCustomer(t *testing.T) {
	customerID := "cus_existing"
	price, ok := lifetimePriceFor("eur")
	if !ok {
		t.Fatal("EUR 价格不存在")
	}
	params := lifetimeCheckoutParams(config.Config{
		AppURL:                  "https://koinote.app",
		StripeLifetimeProductID: "prod_lifetime",
	}, model.User{ID: 42, AuthUserID: "auth-user-1", Email: "user@example.com", StripeCustomerID: &customerID}, price, "attempt-1", checkoutClientWeb)

	if stripe.StringValue(params.Customer) != customerID {
		t.Fatalf("应复用已有 Customer，实际 %q", stripe.StringValue(params.Customer))
	}
	if params.CustomerEmail != nil || params.CustomerCreation != nil {
		t.Fatal("复用 Customer 时不应同时要求创建新 Customer")
	}
}

func TestLifetimeCheckoutParamsUseDesktopReturnPage(t *testing.T) {
	price, _ := lifetimePriceFor("usd")
	params := lifetimeCheckoutParams(config.Config{
		AppURL:                  "https://koinote.app/",
		StripeLifetimeProductID: "prod_lifetime",
	}, model.User{ID: 42, AuthUserID: "auth-user-1", Email: "user@example.com"}, price, "attempt-1", checkoutClientDesktop)

	if got := stripe.StringValue(params.SuccessURL); got != "https://koinote.app/billing/desktop-return?checkout=success&session_id={CHECKOUT_SESSION_ID}" {
		t.Fatalf("桌面成功回跳地址 = %q", got)
	}
	if got := stripe.StringValue(params.CancelURL); got != "https://koinote.app/billing/desktop-return?checkout=cancelled" {
		t.Fatalf("桌面取消回跳地址 = %q", got)
	}
	if params.Metadata["koinote_client"] != checkoutClientDesktop {
		t.Fatalf("桌面 Checkout 元数据 = %q", params.Metadata["koinote_client"])
	}
}

func TestLifetimePriceForUsesAllowlistedCurrencies(t *testing.T) {
	want := map[string]int64{"usd": 399, "cny": 2900, "eur": 399, "jpy": 600}
	for currency, amount := range want {
		option, ok := lifetimePriceFor(strings.ToUpper(currency))
		if !ok || string(option.Currency) != currency || option.Amount != amount {
			t.Fatalf("%s 价格 = %+v, ok=%v", currency, option, ok)
		}
	}
	defaultOption, ok := lifetimePriceFor("")
	if !ok || defaultOption.Currency != stripe.CurrencyUSD {
		t.Fatalf("默认价格 = %+v, ok=%v", defaultOption, ok)
	}
	if _, ok := lifetimePriceFor("gbp"); ok {
		t.Fatal("未配置的 GBP 不应被接受")
	}
}

func TestBillingPricingIsPublicAndUsesConfiguredQuota(t *testing.T) {
	app := newTestApp(config.Config{
		ImageQuotaBytes:         768 * 1024 * 1024,
		StripeSecretKey:         "sk_test_example",
		StripeLifetimeProductID: "prod_lifetime",
	})
	recorder := httptest.NewRecorder()
	app.Routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/billing/pricing", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("公开价目表状态码 = %d，响应 %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=300, s-maxage=300, stale-while-revalidate=60" {
		t.Fatalf("公开价目表 Cache-Control = %q", got)
	}
	var response struct {
		Pricing billingPricingPayload `json:"pricing"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("解析公开价目表: %v", err)
	}
	if !response.Pricing.BillingEnabled || response.Pricing.FreeStorageQuotaBytes != 768*1024*1024 ||
		response.Pricing.LifetimeStorageQuotaBytes != lifetimeStorageQuotaBytes || len(response.Pricing.Prices) != 4 {
		t.Fatalf("公开价目表内容不正确: %+v", response.Pricing)
	}
}

func TestBillingCheckoutRateLimitIsPerUser(t *testing.T) {
	app := newTestApp(config.Config{})
	for range checkoutUserAttempts {
		recorder := httptest.NewRecorder()
		if !app.takeBillingCheckoutAttempt(recorder, 42) {
			t.Fatalf("阈值内不应被限流，响应 %d", recorder.Code)
		}
	}

	blocked := httptest.NewRecorder()
	if app.takeBillingCheckoutAttempt(blocked, 42) {
		t.Fatal("超过阈值仍创建 Checkout Session")
	}
	if blocked.Code != http.StatusTooManyRequests || decodeErrorCode(t, blocked) != "too_many_requests" {
		t.Fatalf("限流响应不正确: %d %s", blocked.Code, blocked.Body.String())
	}
	if !app.takeBillingCheckoutAttempt(httptest.NewRecorder(), 43) {
		t.Fatal("一个用户触发限流不应影响其他用户")
	}
}

func TestBillingCheckoutConfirmRateLimitIsPerUser(t *testing.T) {
	app := newTestApp(config.Config{})
	for range checkoutConfirmAttempts {
		if !app.takeBillingCheckoutConfirmAttempt(httptest.NewRecorder(), 42) {
			t.Fatal("确认接口在阈值内不应被限流")
		}
	}
	blocked := httptest.NewRecorder()
	if app.takeBillingCheckoutConfirmAttempt(blocked, 42) || blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("确认接口限流响应 = %d %s", blocked.Code, blocked.Body.String())
	}
	if !app.takeBillingCheckoutConfirmAttempt(httptest.NewRecorder(), 43) {
		t.Fatal("确认接口限流不应影响其他用户")
	}
}

func TestCheckoutAttemptsSerializeAndReplaceCurrency(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设 TEST_DATABASE_URL，跳过 Checkout 并发校验（CI 里会跑）")
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
	var userID int
	err = pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified)
		VALUES ($1, $2, true) RETURNING id
	`, "checkout-attempt-"+suffix, "checkout-attempt-"+suffix+"@example.com").Scan(&userID)
	if err != nil {
		t.Fatalf("创建测试用户: %v", err)
	}
	defer func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	}()

	stripeClient := newConcurrentStripeCheckoutClient(suffix)
	app := &App{
		db: pool,
		cfg: config.Config{
			AppURL:                  "https://koinote.app",
			StripeLifetimeProductID: "prod_lifetime",
		},
		stripeCheckout: stripeClient,
	}
	usd, _ := lifetimePriceFor("usd")
	results := make(chan checkoutAttempt, 2)
	errorsChannel := make(chan error, 2)
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			attempt, createErr := app.createOrReuseLifetimeCheckout(ctx, userID, usd, checkoutClientWeb)
			results <- attempt
			errorsChannel <- createErr
		}()
	}
	wait.Wait()
	close(results)
	close(errorsChannel)
	for createErr := range errorsChannel {
		if createErr != nil {
			t.Fatalf("并发创建 Checkout: %v", createErr)
		}
	}
	var sessionID string
	for attempt := range results {
		if sessionID == "" {
			sessionID = attempt.SessionID
		} else if attempt.SessionID != sessionID {
			t.Fatalf("并发请求返回不同 Session: %q / %q", sessionID, attempt.SessionID)
		}
	}
	if createCount, expired := stripeClient.snapshot(); createCount != 1 || len(expired) != 0 {
		t.Fatalf("并发请求 create=%d expired=%v", createCount, expired)
	}

	eur, _ := lifetimePriceFor("eur")
	replacement, err := app.createOrReuseLifetimeCheckout(ctx, userID, eur, checkoutClientWeb)
	if err != nil {
		t.Fatalf("切换币种: %v", err)
	}
	if replacement.SessionID == sessionID || replacement.Currency != stripe.CurrencyEUR {
		t.Fatalf("币种切换未替换 Session: %+v", replacement)
	}
	if createCount, expired := stripeClient.snapshot(); createCount != 2 || len(expired) != 1 || expired[0] != sessionID {
		t.Fatalf("币种切换 create=%d expired=%v", createCount, expired)
	}
	var storedSessionID, storedCurrency string
	var attemptCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*), max(checkout_session_id), max(currency)
		FROM stripe_checkout_attempts WHERE user_id = $1
	`, userID).Scan(&attemptCount, &storedSessionID, &storedCurrency); err != nil {
		t.Fatal(err)
	}
	if attemptCount != 1 || storedSessionID != replacement.SessionID || storedCurrency != "eur" {
		t.Fatalf("数据库待支付记录 count=%d session=%q currency=%q", attemptCount, storedSessionID, storedCurrency)
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET membership_tier = 'lifetime' WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	if err := app.cleanupStripeCheckoutAttempts(ctx); err != nil {
		t.Fatalf("后台清理会员待支付 Session: %v", err)
	}
	if createCount, expired := stripeClient.snapshot(); createCount != 2 || len(expired) != 2 || expired[1] != replacement.SessionID {
		t.Fatalf("会员生效后的清理 create=%d expired=%v", createCount, expired)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM stripe_checkout_attempts WHERE user_id = $1
	`, userID).Scan(&attemptCount); err != nil {
		t.Fatal(err)
	}
	if attemptCount != 0 {
		t.Fatalf("会员生效后仍有 %d 条待支付记录", attemptCount)
	}

	if _, err := pool.Exec(ctx, `UPDATE users SET membership_tier = 'free' WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO stripe_checkout_attempts (
			user_id, checkout_session_id, checkout_url, currency, client, expires_at
		) VALUES ($1, $2, $3, 'usd', 'web', now() - interval '1 hour')
	`, userID, "cs_test_expired_"+suffix, "https://checkout.stripe.test/expired/"+suffix); err != nil {
		t.Fatal(err)
	}
	if err := app.cleanupStripeCheckoutAttempts(ctx); err != nil {
		t.Fatalf("后台删除过期待支付记录: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM stripe_checkout_attempts WHERE user_id = $1
	`, userID).Scan(&attemptCount); err != nil {
		t.Fatal(err)
	}
	if attemptCount != 0 {
		t.Fatalf("过期待支付记录仍有 %d 条", attemptCount)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO stripe_checkout_attempts (
			user_id, checkout_session_id, checkout_url, currency, client, expires_at
		) VALUES ($1, $2, $3, 'usd', 'web', now() + interval '1 hour')
	`, userID, "cs_test_live_"+suffix, "https://checkout.stripe.test/live/"+suffix); err != nil {
		t.Fatal(err)
	}
	if err := app.cleanupStripeCheckoutAttempts(ctx); err != nil {
		t.Fatalf("后台检查未过期待支付记录: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM stripe_checkout_attempts WHERE user_id = $1
	`, userID).Scan(&attemptCount); err != nil {
		t.Fatal(err)
	}
	if attemptCount != 1 {
		t.Fatalf("免费用户未过期待支付记录被误删，剩余 %d 条", attemptCount)
	}
}

func TestLifetimeCheckoutWebhookEvents(t *testing.T) {
	for _, eventType := range []stripe.EventType{
		"checkout.session.completed",
		"checkout.session.async_payment_succeeded",
	} {
		if !isLifetimeCheckoutEvent(eventType) {
			t.Fatalf("应处理 webhook 事件 %q", eventType)
		}
	}
	for _, eventType := range []stripe.EventType{
		"checkout.session.async_payment_failed",
		"payment_intent.succeeded",
	} {
		if isLifetimeCheckoutEvent(eventType) {
			t.Fatalf("不应按会员付款处理事件 %q", eventType)
		}
	}
}

func TestValidateLifetimeCheckoutSession(t *testing.T) {
	got, err := validateLifetimeCheckoutSession(paidLifetimeCheckout(), "prod_lifetime")
	if err != nil {
		t.Fatalf("合法会话校验失败: %v", err)
	}
	if got.UserID != 42 || got.AuthUserID != "auth-user-1" || got.SessionID != "cs_test_membership" {
		t.Fatalf("解析结果错误: %+v", got)
	}
	if got.Amount != 399 || got.Currency != stripe.CurrencyUSD {
		t.Fatalf("支付金额解析错误: %+v", got)
	}

	cases := []struct {
		name   string
		mutate func(*stripe.CheckoutSession)
		want   error
	}{
		{"未支付", func(s *stripe.CheckoutSession) { s.PaymentStatus = stripe.CheckoutSessionPaymentStatusUnpaid }, errCheckoutPending},
		{"金额被改", func(s *stripe.CheckoutSession) { s.AmountTotal = 1 }, errCheckoutInvalid},
		{"币种被改", func(s *stripe.CheckoutSession) { s.Currency = stripe.CurrencyCNY }, errCheckoutInvalid},
		{"币种元数据被改", func(s *stripe.CheckoutSession) { s.Metadata["koinote_currency"] = "cny" }, errCheckoutInvalid},
		{"不支持的币种", func(s *stripe.CheckoutSession) { s.Metadata["koinote_currency"] = "gbp" }, errCheckoutInvalid},
		{"模式被改", func(s *stripe.CheckoutSession) { s.Mode = stripe.CheckoutSessionModeSubscription }, errCheckoutInvalid},
		{"服务标记缺失", func(s *stripe.CheckoutSession) { delete(s.Metadata, "service") }, errCheckoutInvalid},
		{"服务标记不符", func(s *stripe.CheckoutSession) { s.Metadata["service"] = "another-service" }, errCheckoutInvalid},
		{"产品不符", func(s *stripe.CheckoutSession) { s.LineItems.Data[0].Price.Product.ID = "prod_other" }, errCheckoutInvalid},
		{"数量不符", func(s *stripe.CheckoutSession) { s.LineItems.Data[0].Quantity = 2 }, errCheckoutInvalid},
		{"归属不符", func(s *stripe.CheckoutSession) { s.Metadata["koinote_auth_user_id"] = "other" }, errCheckoutInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			session := paidLifetimeCheckout()
			tc.mutate(session)
			_, err := validateLifetimeCheckoutSession(session, "prod_lifetime")
			if !errors.Is(err, tc.want) {
				t.Fatalf("错误 = %v，期望 %v", err, tc.want)
			}
		})
	}
}

func TestBillingWebhookRejectsInvalidSignature(t *testing.T) {
	app := newTestApp(config.Config{
		StripeSecretKey:         "sk_test_example",
		StripeWebhookSecret:     "whsec_example",
		StripeLifetimeProductID: "prod_lifetime",
	})
	app.stripeCheckout = &fakeStripeCheckoutClient{}
	req := httptest.NewRequest(http.MethodPost, "/api/billing/webhook", strings.NewReader(`{"type":"checkout.session.completed"}`))
	req.Header.Set("Stripe-Signature", "invalid")
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("伪造签名期望 400，实际 %d", rec.Code)
	}
	if code := decodeErrorCode(t, rec); code != "invalid_signature" {
		t.Fatalf("错误码 = %q", code)
	}
}

func TestBillingWebhookIgnoresOtherService(t *testing.T) {
	const webhookSecret = "whsec_shared_account"
	payload, err := json.Marshal(map[string]any{
		"id":          "evt_other_service",
		"object":      "event",
		"api_version": stripe.APIVersion,
		"type":        "checkout.session.completed",
		"data": map[string]any{
			"object": map[string]any{
				"id":       "cs_test_other_service",
				"object":   "checkout.session",
				"metadata": map[string]string{"service": "another-service"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	signed := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{
		Payload: payload,
		Secret:  webhookSecret,
	})

	app := newTestApp(config.Config{
		StripeSecretKey:         "sk_test_shared_account",
		StripeWebhookSecret:     webhookSecret,
		StripeLifetimeProductID: "prod_koinote",
	})
	app.stripeCheckout = &fakeStripeCheckoutClient{}
	req := httptest.NewRequest(http.MethodPost, "/api/billing/webhook", strings.NewReader(string(payload)))
	req.Header.Set("Stripe-Signature", signed.Header)
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("其他服务事件期望 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Received bool `json:"received"`
		Ignored  bool `json:"ignored"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Received || !body.Ignored {
		t.Fatalf("其他服务事件未被安全忽略: %+v", body)
	}
}

func TestGrantLifetimeMembershipIsIdempotent(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设 TEST_DATABASE_URL，跳过事务幂等校验（CI 里会跑）")
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
	authUserID := "billing-" + suffix
	var userID int
	err = pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified)
		VALUES ($1, $2, true) RETURNING id
	`, authUserID, authUserID+"@example.com").Scan(&userID)
	if err != nil {
		t.Fatalf("创建测试用户: %v", err)
	}
	defer func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM stripe_payments WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	}()

	notifier := &fakePaymentNotifier{err: errors.New("temporary Feishu failure")}
	app := &App{
		db:              pool,
		cfg:             config.Config{ImageQuotaBytes: 500 * 1024 * 1024},
		paymentNotifier: notifier,
	}
	checkout := validatedLifetimeCheckout{
		SessionID:       "cs_test_" + suffix,
		PaymentIntentID: "pi_" + suffix,
		CustomerID:      "cus_" + suffix,
		AuthUserID:      authUserID,
		UserID:          userID,
		Amount:          600,
		Currency:        stripe.CurrencyJPY,
	}
	for index, eventID := range []string{"", "evt_" + suffix} {
		grant, err := app.grantLifetimeMembershipAndNotify(ctx, checkout, eventID, nil)
		if err != nil {
			t.Fatalf("幂等发放失败: %v", err)
		}
		if grant.User.MembershipTier != membershipTierLifetime {
			t.Fatalf("会员等级 = %q", grant.User.MembershipTier)
		}
		if grant.Applied != (index == 0) {
			t.Fatalf("第 %d 次发放 Applied=%v", index+1, grant.Applied)
		}
	}
	if len(notifier.notifications) != 1 {
		t.Fatalf("飞书通知次数 = %d，期望首次落账后恰好 1 次", len(notifier.notifications))
	}
	gotNotification := notifier.notifications[0]
	if gotNotification.UserID != userID || gotNotification.Amount != checkout.Amount ||
		gotNotification.Currency != string(checkout.Currency) ||
		gotNotification.CheckoutID != checkout.SessionID || gotNotification.PaymentIntentID != checkout.PaymentIntentID {
		t.Fatalf("飞书通知内容错误: %+v", gotNotification)
	}

	var paymentCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM stripe_payments WHERE checkout_session_id = $1`, checkout.SessionID).Scan(&paymentCount); err != nil {
		t.Fatal(err)
	}
	if paymentCount != 1 {
		t.Fatalf("重复确认后支付记录数 = %d，期望 1", paymentCount)
	}
	var storedAmount int64
	var storedCurrency string
	if err := pool.QueryRow(ctx, `
		SELECT amount, currency FROM stripe_payments WHERE checkout_session_id = $1
	`, checkout.SessionID).Scan(&storedAmount, &storedCurrency); err != nil {
		t.Fatal(err)
	}
	if storedAmount != checkout.Amount || storedCurrency != string(checkout.Currency) {
		t.Fatalf("支付记录 = %d %s", storedAmount, storedCurrency)
	}

	var attempts int
	var notifiedAt *time.Time
	var nextTryAt *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT notification_attempts, notified_at, notification_next_try_at
		FROM stripe_payments WHERE checkout_session_id = $1
	`, checkout.SessionID).Scan(&attempts, &notifiedAt, &nextTryAt); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || notifiedAt != nil || nextTryAt == nil {
		t.Fatalf("通知失败状态不完整: attempts=%d notifiedAt=%v nextTryAt=%v", attempts, notifiedAt, nextTryAt)
	}

	notifier.err = nil
	if _, err := pool.Exec(ctx, `
		UPDATE stripe_payments
		SET notification_next_try_at = now(), notification_locked_until = NULL
		WHERE checkout_session_id = $1
	`, checkout.SessionID); err != nil {
		t.Fatal(err)
	}
	if err := app.retryPaymentNotifications(ctx); err != nil {
		t.Fatalf("重试付款通知: %v", err)
	}
	if len(notifier.notifications) != 2 {
		t.Fatalf("重试后飞书通知次数 = %d，期望 2", len(notifier.notifications))
	}
	if err := pool.QueryRow(ctx, `
		SELECT notification_attempts, notified_at, notification_next_try_at
		FROM stripe_payments WHERE checkout_session_id = $1
	`, checkout.SessionID).Scan(&attempts, &notifiedAt, &nextTryAt); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || notifiedAt == nil || nextTryAt != nil {
		t.Fatalf("通知成功状态不完整: attempts=%d notifiedAt=%v nextTryAt=%v", attempts, notifiedAt, nextTryAt)
	}
}

func TestPaymentNotificationBackoff(t *testing.T) {
	for _, tc := range []struct {
		attempts int
		want     time.Duration
	}{
		{attempts: 1, want: time.Minute},
		{attempts: 2, want: 2 * time.Minute},
		{attempts: 8, want: 24 * time.Hour},
		{attempts: 100, want: 24 * time.Hour},
	} {
		if got := paymentNotificationBackoff(tc.attempts); got != tc.want {
			t.Fatalf("attempts=%d backoff=%s，期望 %s", tc.attempts, got, tc.want)
		}
	}
}
