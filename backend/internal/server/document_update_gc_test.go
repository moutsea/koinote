package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/config"
	"koinote/backend/internal/migrations"
)

// 保存时回收被删掉的图片。
//
// 起因是个真实的问题：把图从正文里删掉再保存，云端用量不降。原因是回收只挂在
// documentDelete 上，documentUpdate 完全没有回收 —— R2 对象和 image_objects
// 里的记账行都留着。
//
// 这里测的是语义，不是语法。sql_prepare_test.go 只证明那条 UPDATE 能 prepare，
// 而这个 bug 的形态恰好是「语句完全合法但拿回来的是新正文」—— 那样比对结果永远
// 是空集，一张图都不会入队，且没有任何报错。所以必须拿真实数据跑一遍。

// key 必须带上所属用户的 authUserId 前缀 —— 归属就是按这个前缀判的。
// 写死成某个固定用户的话，换个测试用户就会被当成「别人的图」跳过，
// 于是测试变成永远通过的空壳（第一版就是这么错的）。
func gcKey(authUserID, hex string) string {
	return "u/" + authUserID + "/" + hex + ".png"
}

const gcHexA = "aaaaaaaa11111111"
const gcHexB = "bbbbbbbb22222222"

func newGCTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设 TEST_DATABASE_URL，跳过真实数据库校验（CI 里会跑）")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("连库失败: %v", err)
	}
	if err := migrations.Apply(ctx, pool, "../../migrations"); err != nil {
		pool.Close()
		t.Fatalf("跑迁移失败: %v", err)
	}
	// 先注册关连接，后续 seed 注册的数据清理会按 LIFO 在它之前执行。
	t.Cleanup(pool.Close)
	return pool
}

// seedGCUser 建一个干净的用户和一篇文档，返回 userRef 和 docID。
func seedGCUser(t *testing.T, pool *pgxpool.Pool, authUserID, content string) (userRef, string) {
	t.Helper()
	ctx := context.Background()

	// 先清掉上次跑残留的，让测试可重复。
	//
	// 队列必须按 object_key 前缀清，不能只靠删 users 连带：
	// pending_image_deletions.user_id 的外键是 ON DELETE SET NULL，删用户只会把
	// user_id 置空，行本身留着。而 object_key 上有 UNIQUE 约束，那行残留会让
	// 下次入队的 ON CONFLICT DO NOTHING 静默变成空操作 —— 于是测试失败在
	// 「图没入队」上，看起来像被测代码坏了。实测踩过。
	if _, err := pool.Exec(ctx,
		`DELETE FROM pending_image_deletions WHERE object_key LIKE 'u/' || $1 || '/%'`,
		authUserID); err != nil {
		t.Fatalf("清理旧回收队列失败: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM users WHERE auth_user_id = $1`, authUserID); err != nil {
		t.Fatalf("清理旧用户失败: %v", err)
	}

	var userID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, nickname, password_hash)
		VALUES ($1, $1 || '@example.test', 'gc', 'x')
		RETURNING id
	`, authUserID).Scan(&userID); err != nil {
		t.Fatalf("建用户失败: %v", err)
	}

	docID := "doc-" + authUserID
	if _, err := pool.Exec(ctx, `
		INSERT INTO documents (doc_id, user_id, title, content, created_at, updated_at)
		VALUES ($1, $2, 'gc test', $3, now(), now())
	`, docID, userID, content); err != nil {
		t.Fatalf("建文档失败: %v", err)
	}

	t.Cleanup(func() {
		ctx := context.Background()
		// 队列先清、且按 key 前缀清 —— 理由同上面那段：删 users 只会把
		// user_id 置空，留下的行会污染下一次运行
		_, _ = pool.Exec(ctx,
			`DELETE FROM pending_image_deletions WHERE object_key LIKE 'u/' || $1 || '/%'`,
			authUserID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE auth_user_id = $1`, authUserID)
	})
	return userRef{ID: userID, AuthUserID: authUserID}, docID
}

// pendingKeys 按 key 前缀查队列，而不是按 user_id。
//
// 按 user_id 查会漏：外键是 ON DELETE SET NULL，任何删过用户的历史残留行
// user_id 都是 NULL，查不到却仍占着 object_key 的唯一约束。按前缀查能看见它们，
// 断言因此能反映队列的真实状态。
func pendingKeys(t *testing.T, pool *pgxpool.Pool, authUserID string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT object_key FROM pending_image_deletions
		 WHERE object_key LIKE 'u/' || $1 || '/%' ORDER BY object_key`,
		authUserID)
	if err != nil {
		t.Fatalf("查待删队列失败: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			t.Fatalf("扫描待删队列失败: %v", err)
		}
		out = append(out, k)
	}
	return out
}

func newGCWorker(
	t *testing.T,
	respond func([]string) imageDeleteResult,
) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/images/delete" || r.Method != http.MethodPost {
			t.Errorf("Worker 收到意外请求: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("x-koinote-internal-token") != "gc-test-token" {
			t.Error("GC 没带正确的内部令牌")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			Keys []string `json:"keys"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("解析 GC 请求失败: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(respond(body.Keys)); err != nil {
			t.Errorf("写 Worker 响应失败: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	return server, &calls
}

func gcTestApp(pool *pgxpool.Pool, workerURL string) *App {
	return &App{
		db: pool,
		cfg: config.Config{
			WorkerURL:     workerURL,
			InternalToken: "gc-test-token",
		},
	}
}

func isolateGCQueue(t *testing.T, pool *pgxpool.Pool, keys []string) func() {
	t.Helper()
	type schedule struct {
		id   int
		next time.Time
	}
	rows, err := pool.Query(context.Background(), `
		SELECT id, next_try_at
		FROM pending_image_deletions
		WHERE next_try_at <= now() AND NOT (object_key = ANY($1))
	`, keys)
	if err != nil {
		t.Fatalf("读取其它 GC 任务失败: %v", err)
	}
	var schedules []schedule
	for rows.Next() {
		var item schedule
		if err := rows.Scan(&item.id, &item.next); err != nil {
			rows.Close()
			t.Fatalf("扫描其它 GC 任务失败: %v", err)
		}
		schedules = append(schedules, item)
	}
	rows.Close()
	if len(schedules) == 0 {
		return func() {}
	}
	ids := make([]int, 0, len(schedules))
	for _, item := range schedules {
		ids = append(ids, item.id)
	}
	if _, err := pool.Exec(context.Background(), `
		UPDATE pending_image_deletions
		SET next_try_at = now() + interval '1 hour'
		WHERE id = ANY($1)
	`, ids); err != nil {
		t.Fatalf("暂挂其它 GC 任务失败: %v", err)
	}
	return func() {
		for _, item := range schedules {
			_, _ = pool.Exec(context.Background(), `
				UPDATE pending_image_deletions SET next_try_at = $2 WHERE id = $1
			`, item.id, item.next)
		}
	}
}

// 从正文里删掉一张图之后，那张图应该进回收队列。
//
// 这条是这个 bug 的直接回归测试。修复前 enqueueOrphanedImages 根本不会被
// documentUpdate 调到，队列是空的。
func TestUpdateEnqueuesRemovedImage(t *testing.T) {
	pool := newGCTestPool(t)

	removed := gcKey("gcuser", gcHexA)
	before := "![](https://img.koinote.app/" + removed + ")\n\n正文"
	user, docID := seedGCUser(t, pool, "gcuser", before)

	ctx := context.Background()
	// 模拟 documentUpdate 做的事：写入新正文，同时把旧正文取回来
	var prev string
	if err := pool.QueryRow(ctx, `
		UPDATE documents SET content = $3, updated_at = now()
		FROM (
			SELECT doc_id, content AS prev_content FROM documents
			WHERE doc_id = $1 AND user_id = $2
			FOR UPDATE
		) AS old
		WHERE documents.doc_id = old.doc_id AND documents.user_id = $2
		RETURNING old.prev_content
	`, docID, user.ID, "图已删除").Scan(&prev); err != nil {
		t.Fatalf("更新文档失败: %v", err)
	}

	// 这一条是关键：拿回来的必须是旧正文。
	// 写成 RETURNING documents.content 的话这里是新正文，下面全部形同虚设
	if prev != before {
		t.Fatalf("拿回来的不是旧正文。\n期望: %q\n实际: %q", before, prev)
	}

	appDB := &App{db: pool}
	appDB.enqueueOrphanedImages(ctx, user, prev)

	got := pendingKeys(t, pool, user.AuthUserID)
	if len(got) != 1 || got[0] != removed {
		t.Fatalf("被删掉的图没有正确入队。期望 [%s]，实际 %v", removed, got)
	}
}

// 仍留在正文里的图不能被回收。
//
// 这条挡的是「一删就全删」：入队用的是旧正文，如果引用检查失效，
// 留在新正文里的图也会被判成孤儿，用户会看到裂图。
func TestUpdateKeepsStillReferencedImage(t *testing.T) {
	pool := newGCTestPool(t)

	base := "https://img.koinote.app/"
	removed := gcKey("gcuser2", gcHexA)
	kept := gcKey("gcuser2", gcHexB)
	before := "![](" + base + removed + ")\n![](" + base + kept + ")"
	after := "![](" + base + kept + ")"
	user, docID := seedGCUser(t, pool, "gcuser2", before)

	ctx := context.Background()
	var prev string
	if err := pool.QueryRow(ctx, `
		UPDATE documents SET content = $3, updated_at = now()
		FROM (
			SELECT doc_id, content AS prev_content FROM documents
			WHERE doc_id = $1 AND user_id = $2
			FOR UPDATE
		) AS old
		WHERE documents.doc_id = old.doc_id AND documents.user_id = $2
		RETURNING old.prev_content
	`, docID, user.ID, after).Scan(&prev); err != nil {
		t.Fatalf("更新文档失败: %v", err)
	}

	appDB := &App{db: pool}
	appDB.enqueueOrphanedImages(ctx, user, prev)

	got := pendingKeys(t, pool, user.AuthUserID)
	if len(got) != 1 || got[0] != removed {
		t.Fatalf("只该回收被删掉的那张。期望 [%s]，实际 %v", removed, got)
	}
	for _, k := range got {
		if k == kept {
			t.Fatal("还在正文里的图被排进了回收队列 —— 会变成裂图")
		}
	}
}

// 别人的图不能因为我在自己文档里写过它的地址就被删掉。
//
// 这是安全边界，不是优化。extractOwnedImageKeys 按 key 前缀判归属，
// 这条测试钉住那个判断在回收路径上真的生效。
func TestUpdateWontRecycleOtherUsersImage(t *testing.T) {
	pool := newGCTestPool(t)

	victim := "u/someoneelse/cccccccc33333333.png"
	before := "![](https://img.koinote.app/" + victim + ")"
	user, _ := seedGCUser(t, pool, "gcuser3", before)

	ctx := context.Background()
	appDB := &App{db: pool}
	// 直接拿旧正文入队：模拟用户把别人的图地址从自己正文里删掉
	appDB.enqueueOrphanedImages(ctx, user, before)

	if got := pendingKeys(t, pool, user.AuthUserID); len(got) != 0 {
		t.Fatalf("别人的图被排进了我的回收队列: %v", got)
	}
}

// 入队之后图片又被重新引用，GC 必须撤销这条删除令。
//
// 这是生产上真实发生过的数据丢失：图入队后，用户撤销删除（Ctrl+Z）或重新粘贴同一张
// 图，正文里那张图回来了，但队列里的删除令仍在倒计时 —— 约 30 秒后图被删掉，用户看到
// "图片加载失败"，而正文里的地址看着完全正常。
//
// 入队时判定一次是不够的：判定与执行之间隔着至少一个轮询周期（退避后可能几十分钟）。
// 所以 runImageGCOnce 必须在真正删之前复查引用。
func TestGCSkipsRevivedImage(t *testing.T) {
	pool := newGCTestPool(t)

	revived := gcKey("gcuser4", gcHexA)
	// 文档正文里有这张图 —— 模拟"删了又撤销回来"的最终状态
	content := "![](https://img.koinote.app/" + revived + ")"
	user, _ := seedGCUser(t, pool, "gcuser4", content)

	worker, calls := newGCWorker(t, func(keys []string) imageDeleteResult {
		return imageDeleteResult{Deleted: keys}
	})
	ctx := context.Background()
	// 直接入队，模拟先前那次"图被删掉"的编辑已经把它排进了回收队列
	app := gcTestApp(pool, worker.URL)
	if err := app.enqueueImageDeletions(ctx, user.ID, []string{revived}); err != nil {
		t.Fatalf("入队失败: %v", err)
	}
	defer isolateGCQueue(t, pool, []string{revived})()
	if got := pendingKeys(t, pool, user.AuthUserID); len(got) != 1 {
		t.Fatalf("前置条件不成立，队列里应该有 1 条，实际 %v", got)
	}

	if err := app.runImageGCOnce(ctx); err != nil {
		t.Fatalf("执行 GC 失败: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatal("同一用户仍在引用图片，GC 却调用了 Worker 删除")
	}
	if got := pendingKeys(t, pool, user.AuthUserID); len(got) != 0 {
		t.Fatalf("复活图片的删除令没有撤销: %v", got)
	}
}

func TestGCIgnoresOtherUsersReference(t *testing.T) {
	pool := newGCTestPool(t)

	key := gcKey("gc-owner", gcHexA)
	owner, _ := seedGCUser(t, pool, "gc-owner", "正文无图")
	_, _ = seedGCUser(t, pool, "gc-viewer", "![](https://img.koinote.app/"+key+")")

	worker, calls := newGCWorker(t, func(keys []string) imageDeleteResult {
		return imageDeleteResult{Deleted: keys}
	})
	app := gcTestApp(pool, worker.URL)
	if err := app.enqueueImageDeletions(context.Background(), owner.ID, []string{key}); err != nil {
		t.Fatalf("入队失败: %v", err)
	}
	defer isolateGCQueue(t, pool, []string{key})()
	if err := app.runImageGCOnce(context.Background()); err != nil {
		t.Fatalf("执行 GC 失败: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("别人的外链引用不该阻止所有者回收，Worker 调用次数 = %d", calls.Load())
	}
	if got := pendingKeys(t, pool, owner.AuthUserID); len(got) != 0 {
		t.Fatalf("已删除对象仍留在队列: %v", got)
	}
}

func TestGCDeletesOrphanAfterOwnerAccountIsGone(t *testing.T) {
	pool := newGCTestPool(t)

	key := gcKey("gc-deleted-owner", gcHexA)
	owner, _ := seedGCUser(t, pool, "gc-deleted-owner", "正文无图")
	appWorker, calls := newGCWorker(t, func(keys []string) imageDeleteResult {
		return imageDeleteResult{Deleted: keys}
	})
	app := gcTestApp(pool, appWorker.URL)
	ctx := context.Background()
	if err := app.enqueueImageDeletions(ctx, owner.ID, []string{key}); err != nil {
		t.Fatalf("入队失败: %v", err)
	}
	defer isolateGCQueue(t, pool, []string{key})()
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, owner.ID); err != nil {
		t.Fatalf("删除所有者失败: %v", err)
	}
	if err := app.runImageGCOnce(ctx); err != nil {
		t.Fatalf("执行 GC 失败: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("user_id 已置 NULL 的孤儿对象仍应回收，Worker 调用次数 = %d", calls.Load())
	}
	if got := pendingKeys(t, pool, owner.AuthUserID); len(got) != 0 {
		t.Fatalf("账号删除后的对象仍留在队列: %v", got)
	}
}

func TestGCSettlesDeletedKeysWhenWorkerRejectsAnother(t *testing.T) {
	pool := newGCTestPool(t)

	first := gcKey("gc-partial", gcHexA)
	second := gcKey("gc-partial", gcHexB)
	user, _ := seedGCUser(t, pool, "gc-partial", "正文无图")
	worker, _ := newGCWorker(t, func(keys []string) imageDeleteResult {
		return imageDeleteResult{Deleted: []string{keys[0]}, Rejected: []string{keys[1]}}
	})
	app := gcTestApp(pool, worker.URL)
	if err := app.enqueueImageDeletions(context.Background(), user.ID, []string{first, second}); err != nil {
		t.Fatalf("入队失败: %v", err)
	}
	defer isolateGCQueue(t, pool, []string{first, second})()
	if err := app.runImageGCOnce(context.Background()); err != nil {
		t.Fatalf("部分拒绝不该让成功项回滚: %v", err)
	}

	got := pendingKeys(t, pool, user.AuthUserID)
	if len(got) != 1 || got[0] != second {
		t.Fatalf("只该留下 Worker 拒绝的 key，实际 %v", got)
	}
	var attempts int
	var lastError string
	if err := pool.QueryRow(context.Background(), `
		SELECT attempts, last_error FROM pending_image_deletions WHERE object_key = $1
	`, second).Scan(&attempts, &lastError); err != nil {
		t.Fatalf("读取拒绝状态失败: %v", err)
	}
	if attempts != 1 || !strings.Contains(lastError, "Worker") && !strings.Contains(lastError, "worker") {
		t.Fatalf("拒绝项没有正确退避: attempts=%d last_error=%q", attempts, lastError)
	}
}

func TestGCContinuesAfterFastRetryLimit(t *testing.T) {
	pool := newGCTestPool(t)

	key := gcKey("gc-slow-retry", gcHexA)
	user, _ := seedGCUser(t, pool, "gc-slow-retry", "正文无图")
	worker, calls := newGCWorker(t, func(keys []string) imageDeleteResult {
		return imageDeleteResult{Deleted: keys}
	})
	app := gcTestApp(pool, worker.URL)
	if err := app.enqueueImageDeletions(context.Background(), user.ID, []string{key}); err != nil {
		t.Fatalf("入队失败: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `
		UPDATE pending_image_deletions
		SET attempts = $2, next_try_at = now()
		WHERE object_key = $1
	`, key, gcFastRetryAttempts); err != nil {
		t.Fatalf("设置慢速重试状态失败: %v", err)
	}

	if err := app.runImageGCOnce(context.Background()); err != nil {
		t.Fatalf("执行 GC 失败: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("超过快速重试次数后仍应处理，Worker 调用次数 = %d", calls.Load())
	}
}

func TestReenqueueResetsFailedGCState(t *testing.T) {
	pool := newGCTestPool(t)

	key := gcKey("gc-reenqueue", gcHexA)
	user, _ := seedGCUser(t, pool, "gc-reenqueue", "正文无图")
	app := &App{db: pool}
	if err := app.enqueueImageDeletions(context.Background(), user.ID, []string{key}); err != nil {
		t.Fatalf("首次入队失败: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `
		UPDATE pending_image_deletions
		SET attempts = 99, last_error = 'old failure', next_try_at = now() + interval '1 day'
		WHERE object_key = $1
	`, key); err != nil {
		t.Fatalf("设置失败状态失败: %v", err)
	}
	if err := app.enqueueImageDeletions(context.Background(), user.ID, []string{key}); err != nil {
		t.Fatalf("重新入队失败: %v", err)
	}

	var attempts int
	var lastError string
	var due bool
	if err := pool.QueryRow(context.Background(), `
		SELECT attempts, COALESCE(last_error, ''), next_try_at <= now()
		FROM pending_image_deletions WHERE object_key = $1
	`, key).Scan(&attempts, &lastError, &due); err != nil {
		t.Fatalf("读取重新入队状态失败: %v", err)
	}
	if attempts != 0 || lastError != "" || !due {
		t.Fatalf("重新入队未恢复任务: attempts=%d last_error=%q due=%v", attempts, lastError, due)
	}
}

func TestWechatExportImageSchedulesAndRenewsCleanup(t *testing.T) {
	pool := newGCTestPool(t)

	key := gcKey("gc-wechat-export", gcHexA)
	user, _ := seedGCUser(t, pool, "gc-wechat-export", "正文无图")
	app := &App{db: pool}
	firstExpiry := time.Now().Add(wechatExportImageTTL)
	if _, err := app.recordImageObject(
		context.Background(), user.ID, key, 1024, 100*1024*1024,
		imagePurposeWechatExport, &firstExpiry,
	); err != nil {
		t.Fatalf("公式图首次记账失败: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `
		UPDATE pending_image_deletions SET attempts = 12, last_error = 'temporary failure'
		WHERE object_key = $1
	`, key); err != nil {
		t.Fatalf("设置公式图失败状态失败: %v", err)
	}

	secondExpiry := firstExpiry.Add(24 * time.Hour)
	if _, err := app.recordImageObject(
		context.Background(), user.ID, key, 1024, 100*1024*1024,
		imagePurposeWechatExport, &secondExpiry,
	); err != nil {
		t.Fatalf("公式图续期失败: %v", err)
	}

	var objects int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM image_objects WHERE object_key = $1
	`, key).Scan(&objects); err != nil {
		t.Fatalf("读取公式图账本失败: %v", err)
	}
	var attempts int
	var lastError string
	var nextTry time.Time
	if err := pool.QueryRow(context.Background(), `
		SELECT attempts, COALESCE(last_error, ''), next_try_at
		FROM pending_image_deletions WHERE object_key = $1
	`, key).Scan(&attempts, &lastError, &nextTry); err != nil {
		t.Fatalf("读取公式图回收任务失败: %v", err)
	}
	if objects != 1 {
		t.Fatalf("相同公式图不应重复计费，账本行数 = %d", objects)
	}
	usage, err := app.storageUsageFor(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("读取用户配额用量失败: %v", err)
	}
	if usage.ImageBytes != 0 {
		t.Fatalf("临时公式图不应挤占正文云存储配额，imageBytes=%d", usage.ImageBytes)
	}
	if attempts != 0 || lastError != "" {
		t.Fatalf("续期应恢复回收任务: attempts=%d last_error=%q", attempts, lastError)
	}
	if nextTry.Before(secondExpiry.Add(-time.Second)) {
		t.Fatalf("续期没有延后回收时间: got=%s want>=%s", nextTry, secondExpiry)
	}
}

func TestWechatExportQuotaIsSeparateFromPersistentStorage(t *testing.T) {
	pool := newGCTestPool(t)
	user, _ := seedGCUser(t, pool, "gc-wechat-quota", "正文无图")
	app := &App{db: pool}
	expiry := time.Now().Add(wechatExportImageTTL)

	_, err := app.recordImageObject(
		context.Background(), user.ID, gcKey(user.AuthUserID, gcHexA),
		wechatExportQuotaBytes+1, 100*1024*1024, imagePurposeWechatExport, &expiry,
	)
	if !errors.Is(err, errWechatExportQuotaExceeded) {
		t.Fatalf("临时公式图必须受独立额度约束，实际错误 %v", err)
	}
	if _, err := app.recordImageObject(
		context.Background(), user.ID, gcKey(user.AuthUserID, gcHexB),
		1024, 100*1024*1024, imagePurposePersistent, nil,
	); err != nil {
		t.Fatalf("临时额度耗尽不应阻止正文图片记账: %v", err)
	}
}

func TestGCBackoffFallsBackToDailyRetries(t *testing.T) {
	if got := gcBackoff(gcFastRetryAttempts - 1); got != 64*time.Minute {
		t.Fatalf("最后一次快速退避 = %s，期望 64m", got)
	}
	if got := gcBackoff(gcFastRetryAttempts); got != gcSlowRetryInterval {
		t.Fatalf("慢速退避 = %s，期望 %s", got, gcSlowRetryInterval)
	}
	if got := gcBackoff(1000); got != gcSlowRetryInterval {
		t.Fatalf("高 attempts 仍应每日重试，实际 %s", got)
	}
}
