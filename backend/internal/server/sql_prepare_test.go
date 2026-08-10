package server

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/migrations"
)

// 把源码里的 SQL 拿到真实 Postgres 上 PREPARE 一遍。
//
// 为什么必须有这一层：新建文档的那条 INSERT 曾经**必然失败**，而所有已有的测试都
// 是绿的 —— 因为它们只断言源码文本里有没有某些字符串（见
// TestQuotaChecksIncludeDocumentBytes），而这是个类型推导错误，只有 Postgres 的
// 解析器知道。
//
// 那个 bug 的具体形态：title 列是 varchar(255)，所以 INSERT 的目标列把 $3 推成
// character varying；而 octet_length() 有 bit/bytea/character/text 四个重载，
// 解析器从那里把 $3 推成 text。同一参数两种类型 →
// 「inconsistent types deduced for parameter $3」（SQLSTATE 42P08）。
//
// 表现有多误导：新建文档 500，而前端在 /editor 无文档时会自动建一篇并在失败后重试
// —— 于是成了无限重试（实测 9 秒 1546 次），页面永远停在「加载中」，界面上看不出
// 任何与 SQL 有关的线索。而 UPDATE 那条恰好不冲突（两处都推 text），所以症状是
// 「能保存、不能新建」，更难联想到是同一个函数的重载问题。
//
// PREPARE 而不是真的执行：只要语句能被解析和规划，类型推导就是自洽的。
// 不必造数据、不必清理，也不会因为约束冲突产生假失败。
//
// 没有 TEST_DATABASE_URL 时跳过 —— 本地 go test 不该强依赖数据库。CI 里挂了
// postgres service 并设了这个变量，所以那边一定会跑到。
func TestDocumentSQLPrepares(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设 TEST_DATABASE_URL，跳过真实数据库校验（CI 里会跑）")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("连库失败: %v", err)
	}
	defer pool.Close()

	// 先建表：PREPARE 会解析表名与列类型，空库上一律报 relation does not exist。
	// 由测试自己跑迁移而不是让 CI 多加一步 —— 这样本地设了 TEST_DATABASE_URL
	// 也能直接跑，且用的就是生产那套迁移，不会出现「测试库的 schema 和真实的不一样」。
	if err := migrations.Apply(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("取连接失败: %v", err)
	}
	defer conn.Release()

	stmts := documentSQLStatements(t)
	if len(stmts) < 3 {
		t.Fatalf("只抽到 %d 条 SQL，抽取逻辑可能失效了", len(stmts))
	}

	for _, s := range stmts {
		t.Run(s.name, func(t *testing.T) {
			// pgx 的 Prepare 走的是 Postgres 的 extended protocol，
			// 参数类型推导与真实查询完全一致
			if _, err := conn.Conn().Prepare(ctx, "", s.sql); err != nil {
				t.Errorf("这条 SQL 在 Postgres 上 prepare 失败 —— 它在运行时必然报错。\n"+
					"错误: %v\n语句:\n%s", err, s.sql)
			}
		})
	}
}

type namedSQL struct {
	name string
	sql  string
}

// 从 documents.go 与 folders.go 里抽出所有反引号包着的 SQL 字面量。
//
// 只收看起来像完整语句的（以 SELECT/INSERT/UPDATE/DELETE/WITH 开头），
// 跳过带 %s 之类格式化占位的 —— 那些不是能直接 prepare 的完整语句。
func documentSQLStatements(t *testing.T) []namedSQL {
	t.Helper()

	verb := regexp.MustCompile(`(?is)^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b`)
	var out []namedSQL

	// 用正则匹配成对反引号，而不是 Split("`") 后隔一取一 —— 后者靠索引奇偶
	// 判断内容段，多一个反引号就整体错位
	literal := regexp.MustCompile("(?s)`([^`]*)`")

	for _, file := range []string{"documents.go", "folders.go", "folder_move.go", "share.go"} {
		src := readSourceFile(t, file)
		for _, m := range literal.FindAllStringSubmatch(src, -1) {
			sql := m[1]
			if !verb.MatchString(sql) {
				continue
			}
			if strings.Contains(sql, "%s") || strings.Contains(sql, "%d") {
				continue // 拼接式语句，prepare 不了
			}
			// 用语句开头几个词当名字，便于失败时定位
			name := strings.Join(strings.Fields(sql)[:min(4, len(strings.Fields(sql)))], " ")
			out = append(out, namedSQL{name: file + ": " + name, sql: sql})
		}
	}
	return out
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
