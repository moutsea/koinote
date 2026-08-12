package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFeishuSignMatchesKimiseek(t *testing.T) {
	const timestamp int64 = 1_800_000_000
	const secret = "test-secret"
	mac := hmac.New(sha256.New, []byte("1800000000\n"+secret))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if got := feishuSign(timestamp, secret); got != want {
		t.Fatalf("飞书签名 = %q，期望 %q", got, want)
	}
}

func TestFeishuPaymentTextFormatsCurrencies(t *testing.T) {
	base := paymentNotification{
		UserID:          42,
		CheckoutID:      "cs_test_payment",
		PaymentIntentID: "pi_test_payment",
	}
	for _, tc := range []struct {
		currency string
		amount   int64
		want     string
	}{
		{currency: "usd", amount: 399, want: "支付金额: USD 3.99"},
		{currency: "cny", amount: 2900, want: "支付金额: CNY 29.00"},
		{currency: "eur", amount: 399, want: "支付金额: EUR 3.99"},
		{currency: "jpy", amount: 600, want: "支付金额: JPY 600"},
		{currency: "krw", amount: 1000, want: "支付金额: KRW 1000"},
		{currency: "usd", amount: -150, want: "支付金额: USD -1.50"},
	} {
		t.Run(tc.currency, func(t *testing.T) {
			notification := base
			notification.Currency = tc.currency
			notification.Amount = tc.amount
			text := feishuPaymentText(notification)
			for _, want := range []string{
				"Koinote 收款成功",
				"用户 ID: 42",
				"会员: 终生会员",
				tc.want,
				"订单: cs_test_payment",
				"PaymentIntent: pi_test_payment",
			} {
				if !strings.Contains(text, want) {
					t.Fatalf("通知缺少 %q：\n%s", want, text)
				}
			}
			if strings.Contains(text, "用户邮箱") || strings.Contains(text, "user@example.com") {
				t.Fatalf("通知不应包含用户邮箱：\n%s", text)
			}
		})
	}
}

func TestFeishuPaymentNotifierSendsSignedPayload(t *testing.T) {
	const timestamp int64 = 1_800_000_000
	const secret = "test-secret"
	var got feishuTextPayload
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("飞书请求 = %s content-type=%q", r.Method, r.Header.Get("Content-Type"))
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("解析飞书请求: %v", err)
		}
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer server.Close()

	notifier := &feishuPaymentNotifier{
		webhook: server.URL,
		secret:  secret,
		client:  server.Client(),
		now:     func() time.Time { return time.Unix(timestamp, 0) },
	}
	notification := paymentNotification{
		UserID:          42,
		Amount:          399,
		Currency:        "usd",
		CheckoutID:      "cs_test_payment",
		PaymentIntentID: "pi_test_payment",
	}
	if err := notifier.NotifyPayment(context.Background(), notification); err != nil {
		t.Fatalf("发送飞书通知: %v", err)
	}
	if got.MessageType != "text" || got.Timestamp != timestamp || got.Sign != feishuSign(timestamp, secret) ||
		got.Content.Text != feishuPaymentText(notification) {
		t.Fatalf("飞书 payload 错误: %+v", got)
	}
}

func TestFeishuPaymentNotifierReportsFailures(t *testing.T) {
	for _, tc := range []struct {
		name       string
		statusCode int
		response   string
	}{
		{name: "HTTP 错误", statusCode: http.StatusBadGateway, response: `{"code":0}`},
		{name: "新版业务错误", statusCode: http.StatusOK, response: `{"code":19021,"msg":"bad sign"}`},
		{name: "旧版业务错误", statusCode: http.StatusOK, response: `{"StatusCode":19021,"StatusMessage":"bad sign"}`},
		{name: "畸形响应", statusCode: http.StatusOK, response: `not-json`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.statusCode)
				_, _ = w.Write([]byte(tc.response))
			}))
			defer server.Close()
			notifier := &feishuPaymentNotifier{
				webhook: server.URL,
				secret:  "secret",
				client:  server.Client(),
				now:     time.Now,
			}
			if err := notifier.NotifyPayment(context.Background(), paymentNotification{}); err == nil {
				t.Fatal("飞书失败响应未返回错误")
			}
		})
	}
}

func TestFeishuPaymentNotifierHonorsContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	notifier := &feishuPaymentNotifier{
		webhook: server.URL,
		secret:  "secret",
		client:  server.Client(),
		now:     time.Now,
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := notifier.NotifyPayment(ctx, paymentNotification{}); err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("取消请求错误 = %v", err)
	}
}
