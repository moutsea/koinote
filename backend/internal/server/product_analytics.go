package server

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"

	"koinote/backend/internal/httpx"
)

type productMilestone string

const (
	milestoneRegistered        productMilestone = "registered"
	milestoneFirstDocument     productMilestone = "first_document"
	milestoneFirstUpload       productMilestone = "first_upload"
	milestoneFirstExport       productMilestone = "first_export"
	milestoneMCPConnected      productMilestone = "mcp_connected"
	milestoneCheckoutStarted   productMilestone = "checkout_started"
	milestoneCheckoutCompleted productMilestone = "checkout_completed"
)

// activityTracker 避免编辑器自动保存时反复对同一用户、同一天执行
// INSERT ... ON CONFLICT。这里只缓存“今天已经尝试记录过谁”，真值仍在 PostgreSQL。
type activityTracker struct {
	mu   sync.Mutex
	day  string
	seen map[int]struct{}
}

type userClient string

const (
	userClientWeb     userClient = "web"
	userClientDesktop userClient = "desktop"
)

type clientActivityTracker struct {
	mu   sync.Mutex
	hour string
	seen map[clientActivityKey]struct{}
}

type clientActivityKey struct {
	userID int
	client userClient
}

func (t *clientActivityTracker) shouldRecord(userID int, client userClient, now time.Time) bool {
	hour := now.UTC().Format("2006-01-02T15")
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.hour != hour {
		t.hour = hour
		t.seen = make(map[clientActivityKey]struct{})
	}
	key := clientActivityKey{userID: userID, client: client}
	if _, ok := t.seen[key]; ok {
		return false
	}
	t.seen[key] = struct{}{}
	return true
}

func (t *activityTracker) firstToday(userID int, now time.Time) bool {
	day := now.UTC().Format("2006-01-02")
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.day != day {
		t.day = day
		t.seen = make(map[int]struct{})
	}
	if _, ok := t.seen[userID]; ok {
		return false
	}
	t.seen[userID] = struct{}{}
	return true
}

func (a *App) recordProductMilestone(ctx context.Context, userID int, event productMilestone) {
	if a.db == nil || userID <= 0 {
		return
	}
	if err := a.insertProductMilestone(ctx, userID, event); err != nil {
		log.Printf("product milestone %s: %v", event, err)
	}
}

func (a *App) insertProductMilestone(ctx context.Context, userID int, event productMilestone) error {
	_, err := a.db.Exec(ctx, `
		INSERT INTO product_milestones (user_id, event_name, occurred_at)
		SELECT id, $2, now() FROM users WHERE id = $1 FOR KEY SHARE
		ON CONFLICT (user_id, event_name) DO NOTHING
	`, userID, string(event))
	return err
}

func (a *App) recordProductMilestoneAsync(userID int, event productMilestone) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		a.recordProductMilestone(ctx, userID, event)
	}()
}

func (a *App) noteUserActivity(userID int) {
	now := time.Now().UTC()
	if !a.productActivity.firstToday(userID, now) {
		return
	}
	go func(day time.Time) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, err := a.db.Exec(ctx, `
			INSERT INTO user_daily_activity (user_id, activity_date, first_seen_at)
			SELECT id, $2::date, now() FROM users WHERE id = $1 FOR KEY SHARE
			ON CONFLICT (user_id, activity_date) DO NOTHING
		`, userID, day.Format("2006-01-02")); err != nil {
			log.Printf("daily activity: %v", err)
		}
	}(now)
}

func (a *App) noteUserClient(userID int, client userClient) {
	if a.db == nil || userID <= 0 {
		return
	}
	observedAt := time.Now().UTC()
	if !a.clientActivity.shouldRecord(userID, client, observedAt) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, err := a.db.Exec(ctx, `
			UPDATE users
			SET last_client = $2, last_client_at = $3
			WHERE id = $1
			  AND (last_client_at IS NULL OR last_client_at <= $3)
		`, userID, string(client), observedAt); err != nil {
			log.Printf("user client activity: %v", err)
		}
	}()
}

// analyticsEvent 只接受前端才能确知完成时机的首次导出。其余里程碑全部由后端业务
// 成功路径记录，不能由浏览器任意上报。
func (a *App) analyticsEvent(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var body struct {
		Event string `json:"event"`
	}
	if err := decodeJSONBody(r, &body); err != nil || body.Event != string(milestoneFirstExport) {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Unsupported analytics event")
		return
	}
	a.recordProductMilestone(r.Context(), user.ID, milestoneFirstExport)
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
