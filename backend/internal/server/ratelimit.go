package server

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// rateLimiter 是进程内的固定窗口限流器。
//
// 代价说清楚：多实例部署时各进程独立计数，实际阈值被放大 N 倍。
// 单机部署够用，上多实例前必须接入共享限流存储。
type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]*rateEntry
	// 上次清理时间，用于摊销式回收过期条目
	lastSweep time.Time
}

type rateEntry struct {
	count     int
	expiresAt time.Time
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{
		entries:   make(map[string]*rateEntry),
		lastSweep: time.Now(),
	}
}

// allow 记一次请求并返回是否放行。limit <= 0 表示不限流。
func (r *rateLimiter) allow(key string, limit int, window time.Duration) bool {
	if limit <= 0 {
		return true
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()

	// 摊销清理：每个窗口最多扫一次全表，避免每次请求都遍历
	if now.Sub(r.lastSweep) >= window {
		for k, e := range r.entries {
			if now.After(e.expiresAt) {
				delete(r.entries, k)
			}
		}
		r.lastSweep = now
	}

	entry, found := r.entries[key]
	if !found || now.After(entry.expiresAt) {
		r.entries[key] = &rateEntry{count: 1, expiresAt: now.Add(window)}
		return true
	}

	entry.count++
	return entry.count <= limit
}

// reset 清掉某个 key 的计数。密码验证成功后调用，
// 免得之前的失败次数继续压着这个用户。
func (r *rateLimiter) reset(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, key)
}

// requestIP 取客户端 IP。
// Worker 会设 X-Forwarded-For 并在转发前剥掉客户端伪造的同名头，
// 所以这里可以信它；直连时回落到 RemoteAddr。
func requestIP(r *http.Request) string {
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		// 可能是逗号分隔的链路，第一个是最初的客户端
		if idx := strings.IndexByte(forwarded, ','); idx > 0 {
			return strings.TrimSpace(forwarded[:idx])
		}
		return forwarded
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
