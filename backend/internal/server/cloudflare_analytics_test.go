package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestCloudflareAnalyticsRequiresCompleteConfiguration(t *testing.T) {
	if got := newCloudflareAnalyticsClient(config.Config{}); got != nil {
		t.Fatal("缺配置时不应启用 Cloudflare Analytics")
	}
	if got := newCloudflareAnalyticsClient(config.Config{
		CloudflareZoneID:         "zone",
		CloudflareAnalyticsToken: "token",
	}); got == nil {
		t.Fatal("Zone 和 Token 齐全时应启用 Cloudflare Analytics")
	}
}

func TestCloudflareAnalyticsQueriesTotalsAndCaches(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if got := r.Header.Get("Authorization"); got != "Bearer analytics-token" {
			t.Errorf("Authorization = %q", got)
		}
		var body struct {
			Query     string            `json:"query"`
			Variables map[string]string `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("解析请求: %v", err)
		}
		if !strings.Contains(body.Query, "httpRequests1hGroups") ||
			strings.Contains(body.Query, "clientRequestHTTPHost") ||
			strings.Contains(body.Query, "dimensions") {
			t.Fatalf("应查询无分桶总计，实际 query: %s", body.Query)
		}
		if body.Variables["zoneTag"] != "zone-id" {
			t.Fatalf("GraphQL variables 不符: %+v", body.Variables)
		}
		if _, ok := body.Variables["hostname"]; ok {
			t.Fatalf("Zone 已限定站点，不应发送 Free 计划不支持的 hostname 变量: %+v", body.Variables)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data":{"viewer":{"zones":[{"httpRequests1hGroups":[{
				"sum":{"pageViews":123,"requests":456,"bytes":789},
				"uniq":{"uniques":42}
			}]}]}}
		}`))
	}))
	defer server.Close()

	client := &cloudflareAnalyticsClient{
		zoneID:   "zone-id",
		token:    "analytics-token",
		endpoint: server.URL,
		http:     server.Client(),
	}
	start := time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 2; i++ {
		got, err := client.Traffic(context.Background(), start, start.Add(time.Duration(i+1)*time.Hour))
		if err != nil {
			t.Fatalf("查询失败: %v", err)
		}
		if got.PageViews != 123 || got.UniqueVisitors != 42 || got.Requests != 456 || got.Bytes != 789 {
			t.Fatalf("统计不符: %+v", got)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("一分钟内同一天应命中缓存，实际请求 %d 次", got)
	}
}

func TestCloudflareAnalyticsRejectsGraphQLErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"errors":[{"message":"access denied"}]}`))
	}))
	defer server.Close()

	client := &cloudflareAnalyticsClient{
		zoneID: "zone", token: "token",
		endpoint: server.URL, http: server.Client(),
	}
	_, err := client.Traffic(context.Background(), time.Now().Add(-time.Hour), time.Now())
	if err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("GraphQL errors 必须判失败，实际 %v", err)
	}
}

func TestCloudflareAnalyticsCoalescesConcurrentQueries(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"viewer":{"zones":[{"httpRequests1hGroups":[]}]}}}`))
	}))
	defer server.Close()

	client := &cloudflareAnalyticsClient{
		zoneID: "zone", token: "token",
		endpoint: server.URL, http: server.Client(),
	}
	start := time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
	const concurrent = 12
	ready := make(chan struct{}, concurrent)
	begin := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(concurrent)
	for range concurrent {
		go func() {
			defer wait.Done()
			ready <- struct{}{}
			<-begin
			if _, err := client.Traffic(context.Background(), start, start.Add(time.Hour)); err != nil {
				t.Errorf("并发查询失败: %v", err)
			}
		}()
	}
	for range concurrent {
		<-ready
	}
	close(begin)
	deadline := time.Now().Add(time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(25 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		close(release)
		wait.Wait()
		t.Fatalf("同一统计窗口的并发请求应合并，实际上游请求 %d 次", got)
	}
	close(release)
	wait.Wait()
}
