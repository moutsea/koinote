package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestRateLimiterAllowsUpToLimit(t *testing.T) {
	limiter := newRateLimiter()
	for i := 1; i <= 3; i++ {
		if !limiter.allow("k", 3, time.Minute) {
			t.Fatalf("第 %d 次应放行", i)
		}
	}
	if limiter.allow("k", 3, time.Minute) {
		t.Fatal("第 4 次应被拦截")
	}
}

func TestRateLimiterZeroLimitDisables(t *testing.T) {
	limiter := newRateLimiter()
	for i := 0; i < 100; i++ {
		if !limiter.allow("k", 0, time.Minute) {
			t.Fatal("limit=0 表示不限流，不应拦截")
		}
	}
}

// 窗口过后计数必须归零，否则用户被永久锁死
func TestRateLimiterResetsAfterWindow(t *testing.T) {
	limiter := newRateLimiter()
	window := 40 * time.Millisecond

	if !limiter.allow("k", 1, window) {
		t.Fatal("首次应放行")
	}
	if limiter.allow("k", 1, window) {
		t.Fatal("窗口内第二次应被拦截")
	}

	time.Sleep(window + 20*time.Millisecond)

	if !limiter.allow("k", 1, window) {
		t.Fatal("窗口过后应重新放行")
	}
}

// 不同 key 互不影响，否则一个用户能把其他人全锁住
func TestRateLimiterKeysAreIndependent(t *testing.T) {
	limiter := newRateLimiter()
	if !limiter.allow("a", 1, time.Minute) {
		t.Fatal("a 首次应放行")
	}
	if limiter.allow("a", 1, time.Minute) {
		t.Fatal("a 第二次应被拦截")
	}
	if !limiter.allow("b", 1, time.Minute) {
		t.Fatal("b 不应受 a 的计数影响")
	}
}

func TestRateLimiterReset(t *testing.T) {
	limiter := newRateLimiter()
	limiter.allow("k", 1, time.Minute)
	if limiter.allow("k", 1, time.Minute) {
		t.Fatal("应先被拦截")
	}
	limiter.reset("k")
	if !limiter.allow("k", 1, time.Minute) {
		t.Fatal("reset 后应重新放行")
	}
}

// 并发下计数不能丢。配合 -race 跑，同时验证无数据竞争。
func TestRateLimiterConcurrent(t *testing.T) {
	limiter := newRateLimiter()
	const goroutines = 50
	const limit = 20

	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if limiter.allow("shared", limit, time.Minute) {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if allowed != limit {
		t.Fatalf("期望恰好放行 %d 次，实际 %d 次", limit, allowed)
	}
}

// 过期条目要被回收，否则长期运行会无界增长
func TestRateLimiterSweepsExpiredEntries(t *testing.T) {
	limiter := newRateLimiter()
	window := 30 * time.Millisecond

	for i := 0; i < 100; i++ {
		limiter.allow(fmt.Sprintf("key-%d", i), 5, window)
	}
	limiter.mu.Lock()
	before := len(limiter.entries)
	limiter.mu.Unlock()
	if before != 100 {
		t.Fatalf("期望 100 个条目，实际 %d", before)
	}

	time.Sleep(window + 20*time.Millisecond)
	// 再来一次触发摊销清理
	limiter.allow("trigger", 5, window)

	limiter.mu.Lock()
	after := len(limiter.entries)
	limiter.mu.Unlock()
	// 100 个过期的应被清掉，只剩 trigger
	if after > 2 {
		t.Fatalf("过期条目未回收，仍有 %d 个", after)
	}
}

// ---------- requestIP ----------

func TestRequestIP(t *testing.T) {
	cases := []struct {
		name       string
		forwarded  string
		remoteAddr string
		expected   string
	}{
		{"无 XFF 用 RemoteAddr", "", "192.0.2.10:54321", "192.0.2.10"},
		{"有 XFF 取之", "203.0.113.5", "10.0.0.1:1234", "203.0.113.5"},
		{"XFF 多级取最左", "203.0.113.5, 70.41.3.18, 150.172.238.178", "10.0.0.1:1234", "203.0.113.5"},
		{"XFF 带空格", "  203.0.113.9  ", "10.0.0.1:1234", "203.0.113.9"},
		{"RemoteAddr 无端口", "", "192.0.2.77", "192.0.2.77"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = tc.remoteAddr
			if tc.forwarded != "" {
				req.Header.Set("X-Forwarded-For", tc.forwarded)
			}
			if got := requestIP(req); got != tc.expected {
				t.Fatalf("期望 %q，实际 %q", tc.expected, got)
			}
		})
	}
}
