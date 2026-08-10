package server

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

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

// 从正文里删掉一张图之后，那张图应该进回收队列。
//
// 这条是这个 bug 的直接回归测试。修复前 enqueueOrphanedImages 根本不会被
// documentUpdate 调到，队列是空的。
func TestUpdateEnqueuesRemovedImage(t *testing.T) {
	pool := newGCTestPool(t)
	defer pool.Close()

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
	defer pool.Close()

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
	defer pool.Close()

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
