package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stripe/stripe-go/v82"
	"github.com/stripe/stripe-go/v82/webhook"

	"koinote/backend/internal/config"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const (
	membershipTierFree      = "free"
	membershipTierLifetime  = "lifetime"
	lifetimePlanCode        = "lifetime"
	stripeServiceName       = "koinote"
	checkoutParamsVersion   = "v4-single-session-desktop-return"
	maxStripeWebhookBytes   = 64 * 1024
	checkoutUserAttempts    = 5
	checkoutUserWindow      = 10 * time.Minute
	checkoutConfirmAttempts = 12
	checkoutConfirmWindow   = 10 * time.Minute
	checkoutClientWeb       = "web"
	checkoutClientDesktop   = "desktop"
	defaultCheckoutTTL      = 24 * time.Hour
)

type lifetimePriceOption struct {
	Currency stripe.Currency
	Amount   int64
}

var lifetimePriceOptions = []lifetimePriceOption{
	{Currency: stripe.CurrencyUSD, Amount: 399},
	{Currency: stripe.CurrencyCNY, Amount: 2900},
	{Currency: stripe.CurrencyEUR, Amount: 399},
	{Currency: stripe.CurrencyJPY, Amount: 600},
}

// Stripe 的零位小数币种。价目表增加币种时，金额格式化仍按 Stripe 的最小单位解释。
var zeroDecimalCurrencies = map[stripe.Currency]struct{}{
	"bif": {}, "clp": {}, "djf": {}, "gnf": {}, "jpy": {}, "kmf": {}, "krw": {},
	"mga": {}, "pyg": {}, "rwf": {}, "ugx": {}, "vnd": {}, "vuv": {}, "xaf": {},
	"xof": {}, "xpf": {},
}

func currencyMinorUnitDigits(currency stripe.Currency) int {
	if _, zeroDecimal := zeroDecimalCurrencies[currency]; zeroDecimal {
		return 0
	}
	return 2
}

var (
	errCheckoutPending           = errors.New("checkout payment is pending")
	errCheckoutInvalid           = errors.New("invalid checkout session")
	errCheckoutOwner             = errors.New("checkout session belongs to another user")
	errCheckoutAlreadyProcessing = errors.New("checkout payment is already processing")
	errMembershipAlreadyActive   = errors.New("lifetime membership is already active")
)

type stripeCheckoutSessionClient interface {
	Create(context.Context, *stripe.CheckoutSessionCreateParams) (*stripe.CheckoutSession, error)
	Retrieve(context.Context, string, *stripe.CheckoutSessionRetrieveParams) (*stripe.CheckoutSession, error)
	Expire(context.Context, string, *stripe.CheckoutSessionExpireParams) (*stripe.CheckoutSession, error)
}

type checkoutAttempt struct {
	SessionID string
	URL       string
	Currency  stripe.Currency
	Client    string
	ExpiresAt time.Time
}

type validatedLifetimeCheckout struct {
	SessionID       string
	PaymentIntentID string
	CustomerID      string
	AuthUserID      string
	UserID          int
	Amount          int64
	Currency        stripe.Currency
}

type membershipGrantResult struct {
	User    model.User
	Applied bool
}

type billingPricePayload struct {
	Amount   int64  `json:"amount"`
	Currency string `json:"currency"`
}

type billingStatusPayload struct {
	Tier              string                `json:"tier"`
	Active            bool                  `json:"active"`
	StorageQuotaBytes int64                 `json:"storageQuotaBytes"`
	AIEnabled         bool                  `json:"aiEnabled"`
	BillingEnabled    bool                  `json:"billingEnabled"`
	PriceAmount       int64                 `json:"priceAmount"`
	PriceCurrency     string                `json:"priceCurrency"`
	Prices            []billingPricePayload `json:"prices"`
}

type billingPricingPayload struct {
	BillingEnabled            bool                  `json:"billingEnabled"`
	FreeStorageQuotaBytes     int64                 `json:"freeStorageQuotaBytes"`
	LifetimeStorageQuotaBytes int64                 `json:"lifetimeStorageQuotaBytes"`
	Prices                    []billingPricePayload `json:"prices"`
}

func lifetimePriceFor(rawCurrency string) (lifetimePriceOption, bool) {
	currency := stripe.Currency(strings.ToLower(strings.TrimSpace(rawCurrency)))
	if currency == "" {
		currency = stripe.CurrencyUSD
	}
	for _, option := range lifetimePriceOptions {
		if option.Currency == currency {
			return option, true
		}
	}
	return lifetimePriceOption{}, false
}

func billingPricesPayload() []billingPricePayload {
	prices := make([]billingPricePayload, 0, len(lifetimePriceOptions))
	for _, option := range lifetimePriceOptions {
		prices = append(prices, billingPricePayload{
			Amount:   option.Amount,
			Currency: string(option.Currency),
		})
	}
	return prices
}

func lifetimeCheckoutIdempotencyKey(cfg config.Config, user model.User, price lifetimePriceOption, attemptID, client string) string {
	customerIdentity := "email:" + strings.ToLower(strings.TrimSpace(user.Email))
	if user.StripeCustomerID != nil && strings.TrimSpace(*user.StripeCustomerID) != "" {
		customerIdentity = "customer:" + strings.TrimSpace(*user.StripeCustomerID)
	}
	fingerprint := sha256.Sum256([]byte(strings.Join([]string{
		checkoutParamsVersion,
		attemptID,
		strings.TrimRight(cfg.AppURL, "/"),
		user.AuthUserID,
		cfg.StripeLifetimeProductID,
		string(price.Currency),
		strconv.FormatInt(price.Amount, 10),
		customerIdentity,
		client,
	}, "\x00")))
	return "koinote-lifetime-" + checkoutParamsVersion + "-" + hex.EncodeToString(fingerprint[:16])
}

func (a *App) billingStatusPayload(user model.User) billingStatusPayload {
	active := user.MembershipTier == membershipTierLifetime
	tier := user.MembershipTier
	if tier == "" {
		tier = membershipTierFree
	}
	defaultPrice, _ := lifetimePriceFor("")
	return billingStatusPayload{
		Tier:              tier,
		Active:            active,
		StorageQuotaBytes: a.storageQuotaFor(user),
		AIEnabled:         active,
		BillingEnabled:    a.cfg.StripeEnabled(),
		PriceAmount:       defaultPrice.Amount,
		PriceCurrency:     string(defaultPrice.Currency),
		Prices:            billingPricesPayload(),
	}
}

func (a *App) billingStatus(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"membership": a.billingStatusPayload(user)})
}

func (a *App) billingPricing(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=60")
	httpx.JSON(w, http.StatusOK, map[string]any{
		"pricing": billingPricingPayload{
			BillingEnabled:            a.cfg.StripeEnabled(),
			FreeStorageQuotaBytes:     a.imageQuota(),
			LifetimeStorageQuotaBytes: lifetimeStorageQuotaBytes,
			Prices:                    billingPricesPayload(),
		},
	})
}

func (a *App) takeBillingCheckoutAttempt(w http.ResponseWriter, userID int) bool {
	key := "billing:checkout:user:" + strconv.Itoa(userID)
	if a.rateLimit().allow(key, checkoutUserAttempts, checkoutUserWindow) {
		return true
	}
	tooManyAttempts(w)
	return false
}

func (a *App) takeBillingCheckoutConfirmAttempt(w http.ResponseWriter, userID int) bool {
	key := "billing:checkout-confirm:user:" + strconv.Itoa(userID)
	if a.rateLimit().allow(key, checkoutConfirmAttempts, checkoutConfirmWindow) {
		return true
	}
	tooManyAttempts(w)
	return false
}

func validCheckoutClient(value string) bool {
	return value == checkoutClientWeb || value == checkoutClientDesktop
}

func lifetimeCheckoutParams(cfg config.Config, user model.User, price lifetimePriceOption, attemptID, client string) *stripe.CheckoutSessionCreateParams {
	baseURL := strings.TrimRight(cfg.AppURL, "/")
	successURL := baseURL + "/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}"
	cancelURL := baseURL + "/dashboard?checkout=cancelled"
	if client == checkoutClientDesktop {
		successURL = baseURL + "/billing/desktop-return?checkout=success&session_id={CHECKOUT_SESSION_ID}"
		cancelURL = baseURL + "/billing/desktop-return?checkout=cancelled"
	}
	params := &stripe.CheckoutSessionCreateParams{
		Mode:              stripe.String(string(stripe.CheckoutSessionModePayment)),
		SuccessURL:        stripe.String(successURL),
		CancelURL:         stripe.String(cancelURL),
		ClientReferenceID: stripe.String(user.AuthUserID),
		LineItems: []*stripe.CheckoutSessionCreateLineItemParams{
			{
				PriceData: &stripe.CheckoutSessionCreateLineItemPriceDataParams{
					Currency:   stripe.String(string(price.Currency)),
					Product:    stripe.String(cfg.StripeLifetimeProductID),
					UnitAmount: stripe.Int64(price.Amount),
				},
				Quantity: stripe.Int64(1),
			},
		},
		SubmitType: stripe.String("pay"),
		Metadata: map[string]string{
			"service":              stripeServiceName,
			"koinote_plan":         lifetimePlanCode,
			"koinote_user_id":      strconv.Itoa(user.ID),
			"koinote_auth_user_id": user.AuthUserID,
			"koinote_currency":     string(price.Currency),
			"koinote_client":       client,
		},
		PaymentIntentData: &stripe.CheckoutSessionCreatePaymentIntentDataParams{
			Metadata: map[string]string{
				"service":      stripeServiceName,
				"koinote_plan": lifetimePlanCode,
			},
		},
	}
	// 同一次购买尝试的 Stripe 网络重试复用 Session；用户取消、超时或主动重试时会生成
	// 新 attemptID，不能再被带回旧 Session。参数结构变化时仍需更新版本。
	params.SetIdempotencyKey(lifetimeCheckoutIdempotencyKey(cfg, user, price, attemptID, client))
	if user.StripeCustomerID != nil && strings.TrimSpace(*user.StripeCustomerID) != "" {
		params.Customer = stripe.String(strings.TrimSpace(*user.StripeCustomerID))
	} else {
		params.CustomerCreation = stripe.String(string(stripe.CheckoutSessionCustomerCreationAlways))
		params.CustomerEmail = stripe.String(user.Email)
	}
	return params
}

func checkoutExpiresAt(session *stripe.CheckoutSession, now time.Time) time.Time {
	if session != nil && session.ExpiresAt > now.Unix() {
		return time.Unix(session.ExpiresAt, 0).UTC()
	}
	return now.Add(defaultCheckoutTTL)
}

func (a *App) createOrReuseLifetimeCheckout(
	ctx context.Context,
	userID int,
	price lifetimePriceOption,
	client string,
) (checkoutAttempt, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return checkoutAttempt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	user, err := scanBillingUser(tx.QueryRow(ctx, `
		SELECT id, auth_user_id, email, username, nickname, avatar_url,
		       is_verified, is_admin, password_hash IS NOT NULL, session_version,
		       membership_tier, membership_granted_at,
		       bonus_storage_bytes, stripe_customer_id, created_at, updated_at
		FROM users WHERE id = $1
		FOR UPDATE
	`, userID))
	if err != nil {
		return checkoutAttempt{}, err
	}
	if user.MembershipTier == membershipTierLifetime {
		return checkoutAttempt{}, errMembershipAlreadyActive
	}

	var existing checkoutAttempt
	var existingCurrency string
	err = tx.QueryRow(ctx, `
		SELECT checkout_session_id, checkout_url, currency, client, expires_at
		FROM stripe_checkout_attempts
		WHERE user_id = $1
	`, userID).Scan(
		&existing.SessionID, &existing.URL, &existingCurrency, &existing.Client, &existing.ExpiresAt,
	)
	existing.Currency = stripe.Currency(existingCurrency)
	now := time.Now().UTC()
	hadExisting := err == nil
	if err == nil && existing.ExpiresAt.After(now) {
		if existing.Currency == price.Currency && existing.Client == client {
			if err := tx.Commit(ctx); err != nil {
				return checkoutAttempt{}, err
			}
			return existing, nil
		}
		if _, expireErr := a.stripeCheckout.Expire(ctx, existing.SessionID, &stripe.CheckoutSessionExpireParams{}); expireErr != nil {
			current, retrieveErr := a.stripeCheckout.Retrieve(ctx, existing.SessionID, &stripe.CheckoutSessionRetrieveParams{})
			if retrieveErr != nil || current == nil {
				return checkoutAttempt{}, fmt.Errorf("expire previous checkout: %w", expireErr)
			}
			switch current.Status {
			case stripe.CheckoutSessionStatusComplete:
				return checkoutAttempt{}, errCheckoutAlreadyProcessing
			case stripe.CheckoutSessionStatusExpired:
			default:
				return checkoutAttempt{}, fmt.Errorf("expire previous checkout: %w", expireErr)
			}
		}
	} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return checkoutAttempt{}, err
	}
	if hadExisting {
		if _, err := tx.Exec(ctx, `DELETE FROM stripe_checkout_attempts WHERE user_id = $1`, userID); err != nil {
			return checkoutAttempt{}, err
		}
	}

	attemptID, err := randomHex(16)
	if err != nil {
		return checkoutAttempt{}, err
	}
	session, err := a.stripeCheckout.Create(ctx, lifetimeCheckoutParams(a.cfg, user, price, attemptID, client))
	if err != nil {
		if hadExisting {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return checkoutAttempt{}, fmt.Errorf("create checkout: %v; clear previous checkout: %w", err, commitErr)
			}
		}
		return checkoutAttempt{}, err
	}
	if session == nil || session.ID == "" || session.URL == "" {
		if session != nil && session.ID != "" {
			_, _ = a.stripeCheckout.Expire(ctx, session.ID, &stripe.CheckoutSessionExpireParams{})
		}
		if hadExisting {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return checkoutAttempt{}, fmt.Errorf("incomplete checkout response; clear previous checkout: %w", commitErr)
			}
		}
		return checkoutAttempt{}, errors.New("Stripe returned an incomplete checkout session")
	}
	created := checkoutAttempt{
		SessionID: session.ID,
		URL:       session.URL,
		Currency:  price.Currency,
		Client:    client,
		ExpiresAt: checkoutExpiresAt(session, now),
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO stripe_checkout_attempts (
			user_id, checkout_session_id, checkout_url, currency, client, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id) DO UPDATE SET
			checkout_session_id = EXCLUDED.checkout_session_id,
			checkout_url = EXCLUDED.checkout_url,
			currency = EXCLUDED.currency,
			client = EXCLUDED.client,
			expires_at = EXCLUDED.expires_at,
			updated_at = now()
	`, userID, created.SessionID, created.URL, created.Currency, created.Client, created.ExpiresAt); err != nil {
		_, _ = a.stripeCheckout.Expire(ctx, created.SessionID, &stripe.CheckoutSessionExpireParams{})
		return checkoutAttempt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		_, _ = a.stripeCheckout.Expire(ctx, created.SessionID, &stripe.CheckoutSessionExpireParams{})
		return checkoutAttempt{}, err
	}
	return created, nil
}

func (a *App) billingCheckout(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !a.cfg.StripeEnabled() || a.stripeCheckout == nil {
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "billing_not_configured", "Membership checkout is not configured")
		return
	}
	var body struct {
		Currency string `json:"currency"`
		Client   string `json:"client"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid checkout request")
		return
	}
	price, ok := lifetimePriceFor(body.Currency)
	if !ok {
		httpx.ErrorCode(w, http.StatusBadRequest, "unsupported_currency", "Unsupported checkout currency")
		return
	}
	client := strings.ToLower(strings.TrimSpace(body.Client))
	if client == "" {
		client = checkoutClientWeb
	}
	if !validCheckoutClient(client) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Unsupported checkout client")
		return
	}
	if !a.takeBillingCheckoutAttempt(w, user.ID) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	attempt, err := a.createOrReuseLifetimeCheckout(ctx, user.ID, price, client)
	if errors.Is(err, errMembershipAlreadyActive) {
		httpx.ErrorCode(w, http.StatusConflict, "membership_already_active", "Lifetime membership is already active")
		return
	}
	if errors.Is(err, errCheckoutAlreadyProcessing) {
		httpx.ErrorCode(w, http.StatusConflict, "checkout_in_progress", "A previous checkout is already being processed")
		return
	}
	if err != nil {
		log.Printf("stripe checkout create: %v", err)
		httpx.ErrorCode(w, http.StatusBadGateway, "checkout_create_failed", "Could not start checkout")
		return
	}
	a.recordProductMilestone(r.Context(), user.ID, milestoneCheckoutStarted)
	httpx.JSON(w, http.StatusOK, map[string]string{"sessionId": attempt.SessionID, "url": attempt.URL})
}

func validCheckoutSessionID(sessionID string) bool {
	return strings.HasPrefix(sessionID, "cs_") && len(sessionID) <= 255
}

func isLifetimeCheckoutEvent(eventType stripe.EventType) bool {
	return eventType == "checkout.session.completed" ||
		eventType == "checkout.session.async_payment_succeeded"
}

func isKoinoteStripeMetadata(metadata map[string]string) bool {
	return metadata["service"] == stripeServiceName
}

func (a *App) retrieveLifetimeCheckout(ctx context.Context, sessionID string) (*stripe.CheckoutSession, error) {
	if !validCheckoutSessionID(sessionID) {
		return nil, fmt.Errorf("%w: malformed session id", errCheckoutInvalid)
	}
	params := &stripe.CheckoutSessionRetrieveParams{}
	params.AddExpand("line_items.data.price")
	params.AddExpand("line_items.data.price.product")
	return a.stripeCheckout.Retrieve(ctx, sessionID, params)
}

func validateLifetimeCheckoutSession(session *stripe.CheckoutSession, configuredProductID string) (validatedLifetimeCheckout, error) {
	if session == nil || !validCheckoutSessionID(session.ID) {
		return validatedLifetimeCheckout{}, fmt.Errorf("%w: missing session", errCheckoutInvalid)
	}
	if session.Mode != stripe.CheckoutSessionModePayment {
		return validatedLifetimeCheckout{}, fmt.Errorf("%w: unexpected mode", errCheckoutInvalid)
	}
	if session.PaymentStatus != stripe.CheckoutSessionPaymentStatusPaid {
		return validatedLifetimeCheckout{}, errCheckoutPending
	}
	price, ok := lifetimePriceFor(session.Metadata["koinote_currency"])
	if !ok || session.AmountTotal != price.Amount || session.Currency != price.Currency {
		return validatedLifetimeCheckout{}, fmt.Errorf("%w: unexpected amount or currency", errCheckoutInvalid)
	}
	if !isKoinoteStripeMetadata(session.Metadata) || session.ClientReferenceID == "" ||
		session.Metadata["koinote_plan"] != lifetimePlanCode ||
		session.Metadata["koinote_auth_user_id"] != session.ClientReferenceID {
		return validatedLifetimeCheckout{}, fmt.Errorf("%w: missing service or ownership metadata", errCheckoutInvalid)
	}
	userID, err := strconv.Atoi(session.Metadata["koinote_user_id"])
	if err != nil || userID <= 0 {
		return validatedLifetimeCheckout{}, fmt.Errorf("%w: invalid user metadata", errCheckoutInvalid)
	}
	if session.LineItems == nil || len(session.LineItems.Data) != 1 {
		return validatedLifetimeCheckout{}, fmt.Errorf("%w: unexpected line items", errCheckoutInvalid)
	}
	lineItem := session.LineItems.Data[0]
	if lineItem == nil || lineItem.Price == nil || lineItem.Price.Product == nil ||
		lineItem.Price.Product.ID != configuredProductID ||
		lineItem.Quantity != 1 || lineItem.AmountTotal != price.Amount || lineItem.Currency != price.Currency {
		return validatedLifetimeCheckout{}, fmt.Errorf("%w: unexpected price", errCheckoutInvalid)
	}
	if session.PaymentIntent == nil || session.PaymentIntent.ID == "" || session.Customer == nil || session.Customer.ID == "" {
		return validatedLifetimeCheckout{}, fmt.Errorf("%w: missing payment identifiers", errCheckoutInvalid)
	}
	return validatedLifetimeCheckout{
		SessionID:       session.ID,
		PaymentIntentID: session.PaymentIntent.ID,
		CustomerID:      session.Customer.ID,
		AuthUserID:      session.ClientReferenceID,
		UserID:          userID,
		Amount:          price.Amount,
		Currency:        price.Currency,
	}, nil
}

func scanBillingUser(row pgx.Row) (model.User, error) {
	var user model.User
	err := row.Scan(
		&user.ID, &user.AuthUserID, &user.Email, &user.Username, &user.Nickname, &user.AvatarURL,
		&user.IsVerified, &user.IsAdmin, &user.HasPassword, &user.SessionVersion,
		&user.MembershipTier, &user.MembershipGrantedAt,
		&user.BonusStorageBytes, &user.StripeCustomerID, &user.CreatedAt, &user.UpdatedAt,
	)
	return user, err
}

func (a *App) expirePendingCheckoutForMember(ctx context.Context, userID int, completedSessionID string) error {
	var pendingSessionID string
	err := a.db.QueryRow(ctx, `
		SELECT checkout_session_id
		FROM stripe_checkout_attempts
		WHERE user_id = $1
	`, userID).Scan(&pendingSessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if pendingSessionID != completedSessionID {
		if _, expireErr := a.stripeCheckout.Expire(ctx, pendingSessionID, &stripe.CheckoutSessionExpireParams{}); expireErr != nil {
			current, retrieveErr := a.stripeCheckout.Retrieve(ctx, pendingSessionID, &stripe.CheckoutSessionRetrieveParams{})
			if retrieveErr != nil || current == nil {
				return fmt.Errorf("expire pending checkout: %w", expireErr)
			}
			switch current.Status {
			case stripe.CheckoutSessionStatusComplete, stripe.CheckoutSessionStatusExpired:
			default:
				return fmt.Errorf("expire pending checkout: %w", expireErr)
			}
		}
	}
	_, err = a.db.Exec(ctx, `
		DELETE FROM stripe_checkout_attempts
		WHERE user_id = $1 AND checkout_session_id = $2
	`, userID, pendingSessionID)
	return err
}

func (a *App) grantLifetimeMembership(
	ctx context.Context,
	checkout validatedLifetimeCheckout,
	sourceEventID string,
	expectedUser *model.User,
) (membershipGrantResult, error) {
	if expectedUser != nil && (expectedUser.ID != checkout.UserID || expectedUser.AuthUserID != checkout.AuthUserID) {
		return membershipGrantResult{}, errCheckoutOwner
	}

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return membershipGrantResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var userID int
	var authUserID, membershipTier string
	var stripeCustomerID *string
	err = tx.QueryRow(ctx, `
		SELECT id, auth_user_id, membership_tier, stripe_customer_id
		FROM users
		WHERE id = $1 AND auth_user_id = $2
		FOR UPDATE
	`, checkout.UserID, checkout.AuthUserID).Scan(&userID, &authUserID, &membershipTier, &stripeCustomerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return membershipGrantResult{}, errCheckoutOwner
	}
	if err != nil {
		return membershipGrantResult{}, err
	}
	if stripeCustomerID != nil && *stripeCustomerID != checkout.CustomerID {
		return membershipGrantResult{}, fmt.Errorf("%w: Stripe customer mismatch", errCheckoutOwner)
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO stripe_payments (
			checkout_session_id, payment_intent_id, customer_id, user_id,
			plan_code, amount, currency, status, source_event_id,
			notification_next_try_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid', NULLIF($8, ''),
		          CASE WHEN $9 THEN now() ELSE NULL END)
		ON CONFLICT (checkout_session_id) DO NOTHING
	`, checkout.SessionID, checkout.PaymentIntentID, checkout.CustomerID, userID,
		lifetimePlanCode, checkout.Amount, string(checkout.Currency), sourceEventID,
		a.paymentNotifier != nil)
	if err != nil {
		return membershipGrantResult{}, err
	}
	applied := tag.RowsAffected() == 1
	if !applied {
		var existingUserID int
		var existingIntentID, existingCustomerID, existingPlan, existingCurrency string
		var existingAmount int64
		err = tx.QueryRow(ctx, `
			SELECT user_id, payment_intent_id, customer_id, plan_code, amount, currency
			FROM stripe_payments WHERE checkout_session_id = $1
		`, checkout.SessionID).Scan(
			&existingUserID, &existingIntentID, &existingCustomerID, &existingPlan, &existingAmount, &existingCurrency,
		)
		if err != nil {
			return membershipGrantResult{}, err
		}
		if existingUserID != userID || existingIntentID != checkout.PaymentIntentID ||
			existingCustomerID != checkout.CustomerID || existingPlan != lifetimePlanCode ||
			existingAmount != checkout.Amount || existingCurrency != string(checkout.Currency) {
			return membershipGrantResult{}, fmt.Errorf("%w: conflicting payment record", errCheckoutInvalid)
		}
		if sourceEventID != "" {
			if _, err = tx.Exec(ctx, `
				UPDATE stripe_payments
				SET source_event_id = COALESCE(source_event_id, $2), updated_at = now()
				WHERE checkout_session_id = $1
			`, checkout.SessionID, sourceEventID); err != nil {
				return membershipGrantResult{}, err
			}
		}
	}

	user, err := scanBillingUser(tx.QueryRow(ctx, `
		UPDATE users
		SET membership_tier = 'lifetime',
		    membership_granted_at = COALESCE(membership_granted_at, now()),
		    stripe_customer_id = COALESCE(stripe_customer_id, $2),
		    updated_at = now()
		WHERE id = $1
		RETURNING id, auth_user_id, email, username, nickname, avatar_url,
		          is_verified, is_admin, password_hash IS NOT NULL, session_version,
		          membership_tier, membership_granted_at,
		          bonus_storage_bytes, stripe_customer_id, created_at, updated_at
	`, userID, checkout.CustomerID))
	if err != nil {
		return membershipGrantResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return membershipGrantResult{}, err
	}
	if applied {
		a.recordProductMilestone(ctx, user.ID, milestoneCheckoutCompleted)
	}
	return membershipGrantResult{User: user, Applied: applied}, nil
}

func (a *App) grantLifetimeMembershipAndNotify(
	ctx context.Context,
	checkout validatedLifetimeCheckout,
	sourceEventID string,
	expectedUser *model.User,
) (membershipGrantResult, error) {
	result, err := a.grantLifetimeMembership(ctx, checkout, sourceEventID, expectedUser)
	if err != nil {
		return result, err
	}
	if a.stripeCheckout != nil {
		expireCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if expireErr := a.expirePendingCheckoutForMember(expireCtx, result.User.ID, checkout.SessionID); expireErr != nil {
			log.Printf("expire superseded Stripe checkout after membership grant: %v", expireErr)
		}
		cancel()
	}
	if !result.Applied || a.paymentNotifier == nil {
		return result, nil
	}
	a.deliverPaymentNotification(checkout.SessionID)
	return result, nil
}

func (a *App) billingCheckoutConfirm(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !a.cfg.StripeEnabled() || a.stripeCheckout == nil {
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "billing_not_configured", "Membership checkout is not configured")
		return
	}
	var body struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validCheckoutSessionID(strings.TrimSpace(body.SessionID)) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "A valid Checkout Session ID is required")
		return
	}
	if !a.takeBillingCheckoutConfirmAttempt(w, user.ID) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	session, err := a.retrieveLifetimeCheckout(ctx, strings.TrimSpace(body.SessionID))
	if err != nil {
		log.Printf("stripe checkout retrieve: %v", err)
		httpx.ErrorCode(w, http.StatusBadGateway, "checkout_confirm_failed", "Could not verify checkout")
		return
	}
	checkout, err := validateLifetimeCheckoutSession(session, a.cfg.StripeLifetimeProductID)
	if errors.Is(err, errCheckoutPending) {
		httpx.JSON(w, http.StatusAccepted, map[string]string{"status": "pending"})
		return
	}
	if err != nil {
		log.Printf("stripe checkout validation: %v", err)
		httpx.ErrorCode(w, http.StatusBadRequest, "checkout_invalid", "Checkout could not be validated")
		return
	}
	grant, err := a.grantLifetimeMembershipAndNotify(ctx, checkout, "", &user)
	if errors.Is(err, errCheckoutOwner) {
		httpx.ErrorCode(w, http.StatusForbidden, "checkout_forbidden", "Checkout belongs to another user")
		return
	}
	if err != nil {
		log.Printf("grant lifetime membership: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Could not activate membership")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status":     "active",
		"membership": a.billingStatusPayload(grant.User),
		"user":       grant.User,
	})
}

func (a *App) billingWebhook(w http.ResponseWriter, r *http.Request) {
	if !a.cfg.StripeWebhookEnabled() || a.stripeCheckout == nil {
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "billing_not_configured", "Membership checkout is not configured")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxStripeWebhookBytes)
	payload, err := io.ReadAll(r.Body)
	if err != nil {
		httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "bad_request", "Webhook payload is too large")
		return
	}
	event, err := webhook.ConstructEvent(payload, r.Header.Get("Stripe-Signature"), a.cfg.StripeWebhookSecret)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_signature", "Invalid webhook signature")
		return
	}
	if !isLifetimeCheckoutEvent(event.Type) {
		httpx.JSON(w, http.StatusOK, map[string]bool{"received": true})
		return
	}

	var eventSession stripe.CheckoutSession
	if event.Data == nil || json.Unmarshal(event.Data.Raw, &eventSession) != nil || !validCheckoutSessionID(eventSession.ID) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid Checkout Session event")
		return
	}
	if !isKoinoteStripeMetadata(eventSession.Metadata) {
		// 这个 Stripe 账号由多个服务共用。签名正确但不属于 Koinote 的事件应当
		// 正常确认接收，不能尝试履约，也不能用 4xx 触发 Stripe 反复重试。
		httpx.JSON(w, http.StatusOK, map[string]any{"received": true, "ignored": true})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	session, err := a.retrieveLifetimeCheckout(ctx, eventSession.ID)
	if err != nil {
		log.Printf("stripe webhook retrieve: %v", err)
		httpx.ErrorCode(w, http.StatusBadGateway, "checkout_confirm_failed", "Could not verify checkout")
		return
	}
	checkout, err := validateLifetimeCheckoutSession(session, a.cfg.StripeLifetimeProductID)
	if errors.Is(err, errCheckoutPending) {
		httpx.JSON(w, http.StatusOK, map[string]any{"received": true, "status": "pending"})
		return
	}
	if err != nil {
		log.Printf("stripe webhook validation: %v", err)
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "checkout_invalid", "Checkout could not be validated")
		return
	}
	if _, err := a.grantLifetimeMembershipAndNotify(ctx, checkout, event.ID, nil); err != nil {
		log.Printf("stripe webhook grant membership: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Could not activate membership")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"received": true, "status": "active"})
}
