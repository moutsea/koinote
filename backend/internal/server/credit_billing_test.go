package server

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/stripe/stripe-go/v82"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func paidCreditCheckout() *stripe.CheckoutSession {
	return paidCreditCheckoutFor("credits_10000", "usd")
}

func paidCreditCheckoutFor(code, currency string) *stripe.CheckoutSession {
	pack, ok := creditPackFor(code, currency)
	if !ok {
		panic("test credit pack missing")
	}
	return &stripe.CheckoutSession{
		ID:                "cs_test_credits",
		Mode:              stripe.CheckoutSessionModePayment,
		PaymentStatus:     stripe.CheckoutSessionPaymentStatusPaid,
		AmountTotal:       pack.Amount,
		Currency:          pack.Currency,
		ClientReferenceID: "credit-auth-user",
		Metadata: map[string]string{
			"service":              stripeServiceName,
			"koinote_purchase":     creditPurchaseCode,
			"koinote_pack":         pack.Code,
			"koinote_credits":      strconv.FormatInt(pack.Credits, 10),
			"koinote_user_id":      "42",
			"koinote_auth_user_id": "credit-auth-user",
			"koinote_currency":     string(pack.Currency),
		},
		LineItems: &stripe.LineItemList{Data: []*stripe.LineItem{{
			Price:       &stripe.Price{ID: "price_inline", Product: &stripe.Product{ID: "prod_credits"}},
			Quantity:    1,
			AmountTotal: pack.Amount,
			Currency:    pack.Currency,
		}}},
		PaymentIntent: &stripe.PaymentIntent{ID: "pi_credits"},
		Customer:      &stripe.Customer{ID: "cus_credits"},
	}
}

func TestCreditCheckoutParamsUseFixedPack(t *testing.T) {
	cfg := config.Config{AppURL: "https://koinote.app/", StripeCreditsProductID: "prod_credits"}
	user := model.User{ID: 42, AuthUserID: "credit-auth-user", Email: "credit@example.test"}
	pack, ok := creditPackFor("credits_10000", "cny")
	if !ok {
		t.Fatal("CNY credits pack missing")
	}
	params := creditCheckoutParams(cfg, user, pack, "attempt-1", checkoutClientWeb)
	if len(params.LineItems) != 1 || params.LineItems[0].PriceData == nil ||
		stripe.StringValue(params.LineItems[0].PriceData.Product) != "prod_credits" ||
		stripe.Int64Value(params.LineItems[0].PriceData.UnitAmount) != 3_600 ||
		stripe.StringValue(params.LineItems[0].PriceData.Currency) != "cny" ||
		stripe.Int64Value(params.LineItems[0].Quantity) != 1 {
		t.Fatalf("Credits Checkout 未使用服务端固定套餐: %+v", params.LineItems)
	}
	if params.Metadata["koinote_purchase"] != creditPurchaseCode ||
		params.Metadata["koinote_pack"] != pack.Code ||
		params.Metadata["koinote_credits"] != "10000" ||
		params.Metadata["koinote_currency"] != "cny" ||
		params.Metadata["koinote_auth_user_id"] != user.AuthUserID {
		t.Fatalf("Credits Checkout 元数据不完整: %+v", params.Metadata)
	}
	if len(params.PaymentMethodTypes) != 0 {
		t.Fatalf("Credits 支付方式应由 Stripe 按币种动态选择: %+v", params.PaymentMethodTypes)
	}
	if stripe.StringValue(params.SuccessURL) != "https://koinote.app/settings?section=ai&credit_checkout=success&session_id={CHECKOUT_SESSION_ID}" ||
		stripe.StringValue(params.CancelURL) != "https://koinote.app/settings?section=ai&credit_checkout=cancelled" {
		t.Fatalf("Credits 回跳地址错误: success=%q cancel=%q",
			stripe.StringValue(params.SuccessURL), stripe.StringValue(params.CancelURL))
	}
	desktopParams := creditCheckoutParams(cfg, user, pack, "attempt-2", checkoutClientDesktop)
	if stripe.StringValue(desktopParams.SuccessURL) != "https://koinote.app/billing/desktop-return?checkout=success&purchase=credits&session_id={CHECKOUT_SESSION_ID}" ||
		stripe.StringValue(desktopParams.CancelURL) != "https://koinote.app/billing/desktop-return?checkout=cancelled&purchase=credits" {
		t.Fatalf("桌面 Credits 回跳地址错误: success=%q cancel=%q",
			stripe.StringValue(desktopParams.SuccessURL), stripe.StringValue(desktopParams.CancelURL))
	}
}

func TestCreditPacksExposeMembershipCurrencies(t *testing.T) {
	wantAmounts := map[string]map[string]int64{
		"credits_3000":  {"usd": 199, "cny": 1_400, "eur": 199, "jpy": 300},
		"credits_10000": {"usd": 499, "cny": 3_600, "eur": 499, "jpy": 750},
		"credits_30000": {"usd": 1_299, "cny": 9_400, "eur": 1_299, "jpy": 1_950},
	}
	for _, payload := range creditPacksPayload() {
		want := wantAmounts[payload.Code]
		if payload.Currency != "usd" || payload.Amount != want["usd"] {
			t.Fatalf("旧客户端默认价格错误: %+v", payload)
		}
		if len(payload.Prices) != len(lifetimePriceOptions) {
			t.Fatalf("%s 币种数=%d，期望 %d", payload.Code, len(payload.Prices), len(lifetimePriceOptions))
		}
		for _, price := range payload.Prices {
			if price.Amount != want[price.Currency] {
				t.Fatalf("%s %s 价格=%d，期望 %d", payload.Code, price.Currency, price.Amount, want[price.Currency])
			}
		}
	}
}

func TestValidateCreditCheckoutSession(t *testing.T) {
	checkout, err := validateCreditCheckoutSession(paidCreditCheckout(), "prod_credits")
	if err != nil {
		t.Fatal(err)
	}
	if checkout.UserID != 42 || checkout.Pack.Code != "credits_10000" || checkout.Pack.Credits != 10_000 {
		t.Fatalf("Credits Checkout 解析错误: %+v", checkout)
	}
	cnyCheckout, err := validateCreditCheckoutSession(paidCreditCheckoutFor("credits_30000", "cny"), "prod_credits")
	if err != nil || cnyCheckout.Pack.Currency != stripe.CurrencyCNY || cnyCheckout.Pack.Amount != 9_400 {
		t.Fatalf("CNY Credits Checkout 解析错误: checkout=%+v err=%v", cnyCheckout, err)
	}

	wrongAmount := paidCreditCheckout()
	wrongAmount.AmountTotal = 199
	if _, err := validateCreditCheckoutSession(wrongAmount, "prod_credits"); !errors.Is(err, errCheckoutInvalid) {
		t.Fatalf("篡改金额错误=%v，期望 invalid", err)
	}
	wrongCredits := paidCreditCheckout()
	wrongCredits.Metadata["koinote_credits"] = "30000"
	if _, err := validateCreditCheckoutSession(wrongCredits, "prod_credits"); !errors.Is(err, errCheckoutInvalid) {
		t.Fatalf("篡改 credits 错误=%v，期望 invalid", err)
	}
	wrongCurrency := paidCreditCheckout()
	wrongCurrency.Metadata["koinote_currency"] = "cny"
	if _, err := validateCreditCheckoutSession(wrongCurrency, "prod_credits"); !errors.Is(err, errCheckoutInvalid) {
		t.Fatalf("篡改币种错误=%v，期望 invalid", err)
	}
	wrongProduct := paidCreditCheckout()
	wrongProduct.LineItems.Data[0].Price.Product.ID = "prod_other"
	if _, err := validateCreditCheckoutSession(wrongProduct, "prod_credits"); !errors.Is(err, errCheckoutInvalid) {
		t.Fatalf("篡改 Product 错误=%v，期望 invalid", err)
	}
}

func TestGrantPurchasedCreditsIsTransactionalAndIdempotent(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	suffix, err := randomHex(8)
	if err != nil {
		t.Fatalf("generate credit checkout suffix: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET membership_tier = 'lifetime' WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	app := New(config.Config{SessionSecret: "credit-purchase-test"}, pool)
	user := loadAgentReviewTestUser(t, app, pool, userID)
	pack, _ := creditPackFor("credits_3000", "usd")
	checkout := validatedCreditCheckout{
		SessionID:       "cs_test_credit_grant_" + suffix,
		PaymentIntentID: "pi_test_credit_grant_" + suffix,
		CustomerID:      "cus_test_credit_grant_" + suffix,
		AuthUserID:      user.AuthUserID,
		UserID:          user.ID,
		Pack:            pack,
	}

	first, err := app.grantPurchasedCredits(ctx, checkout, "evt_credit_1", &user)
	if err != nil {
		t.Fatal(err)
	}
	second, err := app.grantPurchasedCredits(ctx, checkout, "evt_credit_2", &user)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Applied || second.Applied || first.Balance.Balance != 3_000 || second.Balance.Balance != 3_000 {
		t.Fatalf("Credits 幂等发放异常: first=%+v second=%+v", first, second)
	}
	var payments int
	var purchases int
	if err := pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM stripe_credit_payments WHERE user_id = $1),
			(SELECT count(*) FROM credit_transactions WHERE user_id = $1 AND kind = 'purchase')
	`, user.ID).Scan(&payments, &purchases); err != nil {
		t.Fatal(err)
	}
	if payments != 1 || purchases != 1 {
		t.Fatalf("Credits 付款/流水数量错误: payments=%d purchases=%d", payments, purchases)
	}
}
