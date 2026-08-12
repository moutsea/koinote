package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v82"

	"koinote/backend/internal/config"
)

const (
	feishuRequestTimeout   = 5 * time.Second
	maxFeishuResponseBytes = 64 * 1024
)

type paymentNotification struct {
	UserID          int
	Amount          int64
	Currency        string
	CheckoutID      string
	PaymentIntentID string
}

type paymentNotifier interface {
	NotifyPayment(context.Context, paymentNotification) error
}

type feishuPaymentNotifier struct {
	webhook string
	secret  string
	client  *http.Client
	now     func() time.Time
}

type feishuTextPayload struct {
	MessageType string            `json:"msg_type"`
	Content     feishuTextContent `json:"content"`
	Timestamp   int64             `json:"timestamp"`
	Sign        string            `json:"sign"`
}

type feishuTextContent struct {
	Text string `json:"text"`
}

func newPaymentNotifier(cfg config.Config) paymentNotifier {
	if !cfg.FeishuEnabled() {
		return nil
	}
	return &feishuPaymentNotifier{
		webhook: cfg.BotWebhook,
		secret:  cfg.BotWebhookSecret,
		client:  &http.Client{Timeout: feishuRequestTimeout},
		now:     time.Now,
	}
}

func feishuSign(timestamp int64, secret string) string {
	mac := hmac.New(sha256.New, []byte(strconv.FormatInt(timestamp, 10)+"\n"+secret))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func newFeishuTextPayload(text string, timestamp int64, secret string) feishuTextPayload {
	return feishuTextPayload{
		MessageType: "text",
		Content:     feishuTextContent{Text: text},
		Timestamp:   timestamp,
		Sign:        feishuSign(timestamp, secret),
	}
}

func formatPaymentAmount(amount int64, currency string) string {
	code := strings.ToUpper(strings.TrimSpace(currency))
	fractionDigits := currencyMinorUnitDigits(stripeCurrency(code))
	digits := strconv.FormatInt(amount, 10)
	sign := ""
	if strings.HasPrefix(digits, "-") {
		sign = "-"
		digits = strings.TrimPrefix(digits, "-")
	}
	if fractionDigits == 0 {
		return fmt.Sprintf("%s %s%s", code, sign, digits)
	}
	if len(digits) <= fractionDigits {
		digits = strings.Repeat("0", fractionDigits-len(digits)+1) + digits
	}
	separator := len(digits) - fractionDigits
	return fmt.Sprintf("%s %s%s.%s", code, sign, digits[:separator], digits[separator:])
}

func stripeCurrency(code string) stripe.Currency {
	return stripe.Currency(strings.ToLower(strings.TrimSpace(code)))
}

func feishuPaymentText(notification paymentNotification) string {
	return strings.Join([]string{
		"Koinote 收款成功",
		fmt.Sprintf("用户 ID: %d", notification.UserID),
		"会员: 终生会员",
		"支付金额: " + formatPaymentAmount(notification.Amount, notification.Currency),
		"订单: " + notification.CheckoutID,
		"PaymentIntent: " + notification.PaymentIntentID,
	}, "\n")
}

func (n *feishuPaymentNotifier) NotifyPayment(ctx context.Context, notification paymentNotification) error {
	timestamp := n.now().Unix()
	body, err := json.Marshal(newFeishuTextPayload(feishuPaymentText(notification), timestamp, n.secret))
	if err != nil {
		return fmt.Errorf("encode Feishu notification: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.webhook, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create Feishu request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := n.client.Do(req)
	if err != nil {
		return fmt.Errorf("send Feishu notification: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxFeishuResponseBytes))
	if err != nil {
		return fmt.Errorf("read Feishu response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("Feishu webhook returned HTTP %d", response.StatusCode)
	}
	var result struct {
		Code          *int   `json:"code"`
		StatusCode    *int   `json:"StatusCode"`
		Message       string `json:"msg"`
		StatusMessage string `json:"StatusMessage"`
	}
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return fmt.Errorf("decode Feishu response: %w", err)
	}
	code := 0
	if result.Code != nil {
		code = *result.Code
	} else if result.StatusCode != nil {
		code = *result.StatusCode
	}
	if code != 0 {
		message := result.Message
		if message == "" {
			message = result.StatusMessage
		}
		return fmt.Errorf("Feishu webhook rejected message: code=%d message=%s", code, message)
	}
	return nil
}
