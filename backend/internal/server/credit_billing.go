package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stripe/stripe-go/v82"

	"koinote/backend/internal/config"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const (
	creditPurchaseCode          = "credits"
	creditCheckoutParamsVersion = "v1-credit-packs"
	creditTransactionListLimit  = 20
)

type creditPackOption struct {
	Code     string
	Credits  int64
	Amount   int64
	Currency stripe.Currency
}

var creditPackOptions = []creditPackOption{
	{Code: "credits_3000", Credits: 3_000, Amount: 199, Currency: stripe.CurrencyUSD},
	{Code: "credits_10000", Credits: 10_000, Amount: 499, Currency: stripe.CurrencyUSD},
	{Code: "credits_30000", Credits: 30_000, Amount: 1_299, Currency: stripe.CurrencyUSD},
}

var errCreditPurchaseMembershipRequired = errors.New("lifetime membership is required to buy credits")

type creditPackPayload struct {
	Code     string `json:"code"`
	Credits  int64  `json:"credits"`
	Amount   int64  `json:"amount"`
	Currency string `json:"currency"`
}

type creditTransactionView struct {
	EntryID      string         `json:"entryId"`
	Kind         string         `json:"kind"`
	Amount       int64          `json:"amount"`
	BalanceAfter int64          `json:"balanceAfter"`
	Metadata     map[string]any `json:"metadata"`
	CreatedAt    time.Time      `json:"createdAt"`
}

type creditCheckoutAttempt struct {
	SessionID string
	URL       string
	PackCode  string
	Client    string
	ExpiresAt time.Time
}

type validatedCreditCheckout struct {
	SessionID       string
	PaymentIntentID string
	CustomerID      string
	AuthUserID      string
	UserID          int
	Pack            creditPackOption
}

type creditGrantResult struct {
	Balance creditAccountBalance
	Applied bool
}

func creditPackFor(code string) (creditPackOption, bool) {
	code = strings.ToLower(strings.TrimSpace(code))
	for _, pack := range creditPackOptions {
		if pack.Code == code {
			return pack, true
		}
	}
	return creditPackOption{}, false
}

func creditPacksPayload() []creditPackPayload {
	result := make([]creditPackPayload, 0, len(creditPackOptions))
	for _, pack := range creditPackOptions {
		result = append(result, creditPackPayload{
			Code: pack.Code, Credits: pack.Credits, Amount: pack.Amount, Currency: string(pack.Currency),
		})
	}
	return result
}

func (a *App) agentCreditsGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	balance, err := a.loadCreditBalance(r.Context(), user.ID)
	if err != nil {
		log.Printf("load credits: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Could not load credits")
		return
	}
	transactions, err := a.loadCreditTransactions(r.Context(), user.ID)
	if err != nil {
		log.Printf("load credit transactions: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Could not load credit history")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"credits": map[string]any{
			"balance": balance.Balance, "reserved": balance.Reserved, "available": balance.Available,
			"tokensPerCredit": creditTokensPerCredit,
			"builtinEnabled":  a.cfg.AgentLLMEnabled(),
			"purchaseEnabled": a.cfg.StripeCreditsEnabled(),
			"packs":           creditPacksPayload(), "transactions": transactions,
		},
	})
}

func (a *App) loadCreditTransactions(ctx context.Context, userID int) ([]creditTransactionView, error) {
	rows, err := a.db.Query(ctx, `
		SELECT entry_id, kind, amount, balance_after, metadata, created_at
		FROM credit_transactions
		WHERE user_id = $1
		ORDER BY created_at DESC, entry_id DESC
		LIMIT $2
	`, userID, creditTransactionListLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]creditTransactionView, 0)
	for rows.Next() {
		var transaction creditTransactionView
		var rawMetadata []byte
		if err := rows.Scan(
			&transaction.EntryID,
			&transaction.Kind,
			&transaction.Amount,
			&transaction.BalanceAfter,
			&rawMetadata,
			&transaction.CreatedAt,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(rawMetadata, &transaction.Metadata); err != nil {
			return nil, err
		}
		result = append(result, transaction)
	}
	return result, rows.Err()
}

func (a *App) agentCreditsCheckout(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.cfg.StripeCreditsEnabled() || a.stripeCheckout == nil {
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "credit_billing_not_configured", "Credits checkout is not configured")
		return
	}
	var body struct {
		PackCode string `json:"packCode"`
		Client   string `json:"client"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, agentReviewRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid checkout request")
		return
	}
	pack, ok := creditPackFor(body.PackCode)
	if !ok {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_credit_pack", "Unsupported credit pack")
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
	attempt, err := a.createOrReuseCreditCheckout(ctx, user.ID, pack, client)
	if errors.Is(err, errCheckoutAlreadyProcessing) {
		httpx.ErrorCode(w, http.StatusConflict, "checkout_in_progress", "A previous checkout is already being processed")
		return
	}
	if err != nil {
		log.Printf("Stripe credits checkout create: %v", err)
		httpx.ErrorCode(w, http.StatusBadGateway, "checkout_create_failed", "Could not start credits checkout")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"sessionId": attempt.SessionID, "url": attempt.URL})
}

func (a *App) agentCreditsCheckoutConfirm(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.cfg.StripeCreditsEnabled() || a.stripeCheckout == nil {
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "credit_billing_not_configured", "Credits checkout is not configured")
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
		log.Printf("Stripe credits checkout retrieve: %v", err)
		httpx.ErrorCode(w, http.StatusBadGateway, "checkout_confirm_failed", "Could not verify checkout")
		return
	}
	checkout, err := validateCreditCheckoutSession(session, a.cfg.StripeCreditsProductID)
	if errors.Is(err, errCheckoutPending) {
		httpx.JSON(w, http.StatusAccepted, map[string]string{"status": "pending"})
		return
	}
	if err != nil {
		log.Printf("Stripe credits checkout validation: %v", err)
		httpx.ErrorCode(w, http.StatusBadRequest, "checkout_invalid", "Checkout could not be validated")
		return
	}
	grant, err := a.grantPurchasedCredits(ctx, checkout, "", &user)
	if errors.Is(err, errCheckoutOwner) {
		httpx.ErrorCode(w, http.StatusForbidden, "checkout_forbidden", "Checkout belongs to another user")
		return
	}
	if err != nil {
		log.Printf("grant purchased credits: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Could not grant credits")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "active", "credits": grant.Balance})
}

func creditCheckoutIdempotencyKey(
	cfg config.Config,
	user model.User,
	pack creditPackOption,
	attemptID string,
	client string,
) string {
	fingerprint := sha256.Sum256([]byte(strings.Join([]string{
		creditCheckoutParamsVersion,
		attemptID,
		strings.TrimRight(cfg.AppURL, "/"),
		user.AuthUserID,
		cfg.StripeCreditsProductID,
		pack.Code,
		strconv.FormatInt(pack.Credits, 10),
		strconv.FormatInt(pack.Amount, 10),
		string(pack.Currency),
		client,
	}, "\x00")))
	return "koinote-credits-" + creditCheckoutParamsVersion + "-" + hex.EncodeToString(fingerprint[:16])
}

func creditCheckoutParams(
	cfg config.Config,
	user model.User,
	pack creditPackOption,
	attemptID string,
	client string,
) *stripe.CheckoutSessionCreateParams {
	baseURL := strings.TrimRight(cfg.AppURL, "/")
	successURL := baseURL + "/ai-settings?credit_checkout=success&session_id={CHECKOUT_SESSION_ID}"
	cancelURL := baseURL + "/ai-settings?credit_checkout=cancelled"
	if client == checkoutClientDesktop {
		successURL = baseURL + "/billing/desktop-return?checkout=success&purchase=credits&session_id={CHECKOUT_SESSION_ID}"
		cancelURL = baseURL + "/billing/desktop-return?checkout=cancelled&purchase=credits"
	}
	params := &stripe.CheckoutSessionCreateParams{
		Mode:              stripe.String(string(stripe.CheckoutSessionModePayment)),
		SuccessURL:        stripe.String(successURL),
		CancelURL:         stripe.String(cancelURL),
		ClientReferenceID: stripe.String(user.AuthUserID),
		LineItems: []*stripe.CheckoutSessionCreateLineItemParams{{
			PriceData: &stripe.CheckoutSessionCreateLineItemPriceDataParams{
				Currency: stripe.String(string(pack.Currency)), Product: stripe.String(cfg.StripeCreditsProductID),
				UnitAmount: stripe.Int64(pack.Amount),
			},
			Quantity: stripe.Int64(1),
		}},
		SubmitType: stripe.String("pay"),
		Metadata: map[string]string{
			"service": stripeServiceName, "koinote_purchase": creditPurchaseCode,
			"koinote_pack": pack.Code, "koinote_credits": strconv.FormatInt(pack.Credits, 10),
			"koinote_user_id": strconv.Itoa(user.ID), "koinote_auth_user_id": user.AuthUserID,
			"koinote_client": client,
		},
		PaymentIntentData: &stripe.CheckoutSessionCreatePaymentIntentDataParams{Metadata: map[string]string{
			"service": stripeServiceName, "koinote_purchase": creditPurchaseCode, "koinote_pack": pack.Code,
		}},
	}
	params.SetIdempotencyKey(creditCheckoutIdempotencyKey(cfg, user, pack, attemptID, client))
	if user.StripeCustomerID != nil && strings.TrimSpace(*user.StripeCustomerID) != "" {
		params.Customer = stripe.String(strings.TrimSpace(*user.StripeCustomerID))
	} else {
		params.CustomerCreation = stripe.String(string(stripe.CheckoutSessionCustomerCreationAlways))
		params.CustomerEmail = stripe.String(user.Email)
	}
	return params
}

func (a *App) createOrReuseCreditCheckout(
	ctx context.Context,
	userID int,
	pack creditPackOption,
	client string,
) (creditCheckoutAttempt, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return creditCheckoutAttempt{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	user, err := scanBillingUser(tx.QueryRow(ctx, `
		SELECT id, auth_user_id, email, username, nickname, avatar_url,
		       is_verified, is_admin, password_hash IS NOT NULL, session_version,
		       membership_tier, membership_granted_at,
		       bonus_storage_bytes, stripe_customer_id, created_at, updated_at
		FROM users WHERE id = $1
		FOR UPDATE
	`, userID))
	if err != nil {
		return creditCheckoutAttempt{}, err
	}
	if user.MembershipTier != membershipTierLifetime {
		return creditCheckoutAttempt{}, errCreditPurchaseMembershipRequired
	}

	var existing creditCheckoutAttempt
	err = tx.QueryRow(ctx, `
		SELECT checkout_session_id, checkout_url, pack_code, client, expires_at
		FROM stripe_credit_checkout_attempts
		WHERE user_id = $1
	`, userID).Scan(&existing.SessionID, &existing.URL, &existing.PackCode, &existing.Client, &existing.ExpiresAt)
	now := time.Now().UTC()
	hadExisting := err == nil
	if err == nil && existing.ExpiresAt.After(now) {
		if existing.PackCode == pack.Code && existing.Client == client {
			if err := tx.Commit(ctx); err != nil {
				return creditCheckoutAttempt{}, err
			}
			return existing, nil
		}
		removable, expireErr := a.expireCheckoutSessionForRemoval(ctx, existing.SessionID)
		if expireErr != nil {
			return creditCheckoutAttempt{}, expireErr
		}
		if !removable {
			return creditCheckoutAttempt{}, errCheckoutAlreadyProcessing
		}
	} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return creditCheckoutAttempt{}, err
	}
	if hadExisting {
		if _, err := tx.Exec(ctx, `DELETE FROM stripe_credit_checkout_attempts WHERE user_id = $1`, userID); err != nil {
			return creditCheckoutAttempt{}, err
		}
	}

	attemptID, err := randomHex(16)
	if err != nil {
		return creditCheckoutAttempt{}, err
	}
	session, err := a.stripeCheckout.Create(ctx, creditCheckoutParams(a.cfg, user, pack, attemptID, client))
	if err != nil {
		if hadExisting {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return creditCheckoutAttempt{}, fmt.Errorf("create credit checkout: %v; clear previous checkout: %w", err, commitErr)
			}
		}
		return creditCheckoutAttempt{}, err
	}
	if session == nil || session.ID == "" || session.URL == "" {
		if session != nil && session.ID != "" {
			_, _ = a.stripeCheckout.Expire(ctx, session.ID, &stripe.CheckoutSessionExpireParams{})
		}
		return creditCheckoutAttempt{}, errors.New("Stripe returned an incomplete credits checkout session")
	}
	created := creditCheckoutAttempt{
		SessionID: session.ID, URL: session.URL, PackCode: pack.Code, Client: client,
		ExpiresAt: checkoutExpiresAt(session, now),
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO stripe_credit_checkout_attempts (
			user_id, checkout_session_id, checkout_url, pack_code, client, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id) DO UPDATE SET
			checkout_session_id = EXCLUDED.checkout_session_id,
			checkout_url = EXCLUDED.checkout_url,
			pack_code = EXCLUDED.pack_code,
			client = EXCLUDED.client,
			expires_at = EXCLUDED.expires_at,
			updated_at = now()
	`, userID, created.SessionID, created.URL, created.PackCode, created.Client, created.ExpiresAt); err != nil {
		_, _ = a.stripeCheckout.Expire(ctx, created.SessionID, &stripe.CheckoutSessionExpireParams{})
		return creditCheckoutAttempt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		_, _ = a.stripeCheckout.Expire(ctx, created.SessionID, &stripe.CheckoutSessionExpireParams{})
		return creditCheckoutAttempt{}, err
	}
	return created, nil
}

func validateCreditCheckoutSession(session *stripe.CheckoutSession, configuredProductID string) (validatedCreditCheckout, error) {
	if session == nil || !validCheckoutSessionID(session.ID) || configuredProductID == "" {
		return validatedCreditCheckout{}, fmt.Errorf("%w: missing credit checkout", errCheckoutInvalid)
	}
	if session.Mode != stripe.CheckoutSessionModePayment {
		return validatedCreditCheckout{}, fmt.Errorf("%w: unexpected mode", errCheckoutInvalid)
	}
	if session.PaymentStatus != stripe.CheckoutSessionPaymentStatusPaid {
		return validatedCreditCheckout{}, errCheckoutPending
	}
	pack, ok := creditPackFor(session.Metadata["koinote_pack"])
	if !ok || session.AmountTotal != pack.Amount || session.Currency != pack.Currency ||
		session.Metadata["koinote_credits"] != strconv.FormatInt(pack.Credits, 10) {
		return validatedCreditCheckout{}, fmt.Errorf("%w: unexpected credit pack", errCheckoutInvalid)
	}
	if !isKoinoteStripeMetadata(session.Metadata) || session.Metadata["koinote_purchase"] != creditPurchaseCode ||
		session.ClientReferenceID == "" || session.Metadata["koinote_auth_user_id"] != session.ClientReferenceID {
		return validatedCreditCheckout{}, fmt.Errorf("%w: missing credit purchase metadata", errCheckoutInvalid)
	}
	userID, err := strconv.Atoi(session.Metadata["koinote_user_id"])
	if err != nil || userID <= 0 {
		return validatedCreditCheckout{}, fmt.Errorf("%w: invalid user metadata", errCheckoutInvalid)
	}
	if session.LineItems == nil || len(session.LineItems.Data) != 1 {
		return validatedCreditCheckout{}, fmt.Errorf("%w: unexpected line items", errCheckoutInvalid)
	}
	lineItem := session.LineItems.Data[0]
	if lineItem == nil || lineItem.Price == nil || lineItem.Price.Product == nil ||
		lineItem.Price.Product.ID != configuredProductID || lineItem.Quantity != 1 ||
		lineItem.AmountTotal != pack.Amount || lineItem.Currency != pack.Currency {
		return validatedCreditCheckout{}, fmt.Errorf("%w: unexpected credit price", errCheckoutInvalid)
	}
	if session.PaymentIntent == nil || session.PaymentIntent.ID == "" || session.Customer == nil || session.Customer.ID == "" {
		return validatedCreditCheckout{}, fmt.Errorf("%w: missing payment identifiers", errCheckoutInvalid)
	}
	return validatedCreditCheckout{
		SessionID: session.ID, PaymentIntentID: session.PaymentIntent.ID, CustomerID: session.Customer.ID,
		AuthUserID: session.ClientReferenceID, UserID: userID, Pack: pack,
	}, nil
}

func (a *App) grantPurchasedCredits(
	ctx context.Context,
	checkout validatedCreditCheckout,
	sourceEventID string,
	expectedUser *model.User,
) (creditGrantResult, error) {
	if expectedUser != nil && (expectedUser.ID != checkout.UserID || expectedUser.AuthUserID != checkout.AuthUserID) {
		return creditGrantResult{}, errCheckoutOwner
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return creditGrantResult{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	var userID int
	var membershipTier string
	var stripeCustomerID *string
	err = tx.QueryRow(ctx, `
		SELECT id, membership_tier, stripe_customer_id
		FROM users
		WHERE id = $1 AND auth_user_id = $2
		FOR UPDATE
	`, checkout.UserID, checkout.AuthUserID).Scan(&userID, &membershipTier, &stripeCustomerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return creditGrantResult{}, errCheckoutOwner
	}
	if err != nil {
		return creditGrantResult{}, err
	}
	if membershipTier != membershipTierLifetime {
		return creditGrantResult{}, errCheckoutOwner
	}
	if stripeCustomerID != nil && *stripeCustomerID != checkout.CustomerID {
		return creditGrantResult{}, fmt.Errorf("%w: Stripe customer mismatch", errCheckoutOwner)
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO stripe_credit_payments (
			checkout_session_id, payment_intent_id, customer_id, user_id,
			pack_code, credits, amount, currency, status, source_event_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', NULLIF($9, ''))
		ON CONFLICT (checkout_session_id) DO NOTHING
	`, checkout.SessionID, checkout.PaymentIntentID, checkout.CustomerID, userID,
		checkout.Pack.Code, checkout.Pack.Credits, checkout.Pack.Amount, string(checkout.Pack.Currency), sourceEventID)
	if err != nil {
		return creditGrantResult{}, err
	}
	applied := tag.RowsAffected() == 1
	if !applied {
		var existingUserID *int
		var existingIntentID, existingCustomerID, existingPack, existingCurrency string
		var existingCredits, existingAmount int64
		if err := tx.QueryRow(ctx, `
			SELECT user_id, payment_intent_id, customer_id, pack_code, credits, amount, currency
			FROM stripe_credit_payments WHERE checkout_session_id = $1
		`, checkout.SessionID).Scan(
			&existingUserID, &existingIntentID, &existingCustomerID, &existingPack,
			&existingCredits, &existingAmount, &existingCurrency,
		); err != nil {
			return creditGrantResult{}, err
		}
		if existingUserID == nil || *existingUserID != userID || existingIntentID != checkout.PaymentIntentID ||
			existingCustomerID != checkout.CustomerID || existingPack != checkout.Pack.Code ||
			existingCredits != checkout.Pack.Credits || existingAmount != checkout.Pack.Amount ||
			existingCurrency != string(checkout.Pack.Currency) {
			return creditGrantResult{}, fmt.Errorf("%w: conflicting credit payment record", errCheckoutInvalid)
		}
		if sourceEventID != "" {
			if _, err := tx.Exec(ctx, `
				UPDATE stripe_credit_payments
				SET source_event_id = COALESCE(source_event_id, $2), updated_at = now()
				WHERE checkout_session_id = $1
			`, checkout.SessionID, sourceEventID); err != nil {
				return creditGrantResult{}, err
			}
		}
	}
	balance, _, err := grantCreditsTx(
		ctx, tx, userID, "purchase", checkout.Pack.Credits,
		"stripe-credit:"+checkout.SessionID,
		map[string]any{"checkoutSessionId": checkout.SessionID, "packCode": checkout.Pack.Code},
	)
	if err != nil {
		return creditGrantResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, $2), updated_at = now()
		WHERE id = $1
	`, userID, checkout.CustomerID); err != nil {
		return creditGrantResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM stripe_credit_checkout_attempts
		WHERE user_id = $1 AND checkout_session_id = $2
	`, userID, checkout.SessionID); err != nil {
		return creditGrantResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return creditGrantResult{}, err
	}
	return creditGrantResult{Balance: balance, Applied: applied}, nil
}

func (a *App) handleCreditCheckoutWebhook(
	w http.ResponseWriter,
	r *http.Request,
	eventID string,
	sessionID string,
) {
	if !a.cfg.StripeCreditsEnabled() {
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "checkout_invalid", "Credits checkout is not configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	session, err := a.retrieveLifetimeCheckout(ctx, sessionID)
	if err != nil {
		log.Printf("Stripe credits webhook retrieve: %v", err)
		httpx.ErrorCode(w, http.StatusBadGateway, "checkout_confirm_failed", "Could not verify checkout")
		return
	}
	checkout, err := validateCreditCheckoutSession(session, a.cfg.StripeCreditsProductID)
	if errors.Is(err, errCheckoutPending) {
		httpx.JSON(w, http.StatusOK, map[string]any{"received": true, "status": "pending"})
		return
	}
	if err != nil {
		log.Printf("Stripe credits webhook validation: %v", err)
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "checkout_invalid", "Checkout could not be validated")
		return
	}
	grant, err := a.grantPurchasedCredits(ctx, checkout, eventID, nil)
	if err != nil {
		log.Printf("Stripe credits webhook grant: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Could not grant credits")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"received": true, "status": "active", "credits": grant.Balance,
	})
}
