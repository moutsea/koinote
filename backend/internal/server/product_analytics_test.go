package server

import (
	"testing"
	"time"
)

func TestClientActivityTrackerRecordsEachClientOncePerHour(t *testing.T) {
	var tracker clientActivityTracker
	now := time.Date(2026, 8, 23, 10, 15, 0, 0, time.UTC)

	if !tracker.shouldRecord(7, userClientWeb, now) {
		t.Fatal("首次 Web 使用应记录")
	}
	if tracker.shouldRecord(7, userClientWeb, now.Add(20*time.Minute)) {
		t.Fatal("同一小时内重复使用同一客户端不应重复记录")
	}
	if !tracker.shouldRecord(7, userClientDesktop, now.Add(21*time.Minute)) {
		t.Fatal("同一小时首次使用桌面端应记录")
	}
	if tracker.shouldRecord(7, userClientWeb, now.Add(22*time.Minute)) {
		t.Fatal("Web 和桌面端交替请求不应反复记录已见过的组合")
	}
	if tracker.shouldRecord(7, userClientDesktop, now.Add(23*time.Minute)) {
		t.Fatal("同一小时重复使用桌面端不应记录")
	}
	if !tracker.shouldRecord(8, userClientWeb, now.Add(24*time.Minute)) {
		t.Fatal("不同用户应独立记录")
	}
	if !tracker.shouldRecord(7, userClientWeb, now.Add(time.Hour)) {
		t.Fatal("跨小时后应刷新最近使用时间")
	}
}
