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

type rateBudget struct {
	key    string
	limit  int
	window time.Duration
}

// Admit all budgets together: a rejected actor cannot spend the shared budget,
// and a saturated shared budget cannot create unlimited actor entries.
func (r *rateLimiter) allowBudgets(budgets ...rateBudget) time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.sweepLocked(now, time.Minute)
	var retryAfter time.Duration
	for _, budget := range budgets {
		if entry := r.entries[budget.key]; entry != nil && now.Before(entry.expiresAt) && entry.count >= budget.limit {
			if delay := entry.expiresAt.Sub(now); delay > retryAfter {
				retryAfter = delay
			}
		}
	}
	if retryAfter > 0 {
		return retryAfter
	}
	for _, budget := range budgets {
		entry := r.entries[budget.key]
		if entry == nil || !now.Before(entry.expiresAt) {
			entry = &rateEntry{expiresAt: now.Add(budget.window)}
			r.entries[budget.key] = entry
		}
		entry.count++
	}
	return 0
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

	r.sweepLocked(now, window)

	entry, found := r.entries[key]
	if !found || now.After(entry.expiresAt) {
		r.entries[key] = &rateEntry{count: 1, expiresAt: now.Add(window)}
		return true
	}

	entry.count++
	return entry.count <= limit
}

// Check an actor and global budget atomically. Denied actors cannot consume the
// global allowance; exhausted global budgets cannot allocate new actor buckets.
func (r *rateLimiter) allowWithGlobal(key string, limit int, globalKey string, globalLimit int, window time.Duration) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.sweepLocked(now, window)
	global := r.entries[globalKey]
	if global == nil || !now.Before(global.expiresAt) {
		global = &rateEntry{expiresAt: now.Add(window)}
	}
	if global.count >= globalLimit {
		return false
	}
	entry := r.entries[key]
	if entry == nil || !now.Before(entry.expiresAt) {
		entry = &rateEntry{expiresAt: now.Add(window)}
	}
	if entry.count >= limit {
		return false
	}
	entry.count++
	global.count++
	r.entries[key], r.entries[globalKey] = entry, global
	return true
}

func (r *rateLimiter) sweepLocked(now time.Time, window time.Duration) {
	if now.Sub(r.lastSweep) >= window {
		for key, entry := range r.entries {
			if !now.Before(entry.expiresAt) {
				delete(r.entries, key)
			}
		}
		r.lastSweep = now
	}
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

// Public endpoints may also be reached directly. Trust forwarding metadata only
// from our authenticated Worker; a caller-controlled XFF must not create a bucket.
// The result is only a rate-limit key: IPv6 sources collapse to their /64, since
// one host normally controls the whole prefix and could otherwise rotate freely.
func (a *App) publicRepositoryRequestIP(r *http.Request) string {
	if a.hasInternalToken(r) {
		if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Forwarded-For"))); ip != nil {
			return rateLimitAddress(ip)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil {
		return rateLimitAddress(ip)
	}
	return host
}

func rateLimitAddress(ip net.IP) string {
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}
