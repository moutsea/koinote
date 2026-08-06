package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"koinote/backend/internal/config"
	"koinote/backend/internal/httpx"
)

// 图片存储配额。
//
// 上限来自 IMAGE_QUOTA_MB 环境变量（见 config.imageQuotaBytes），默认 500 MB。
// 放配置而不是代码常量：这是运营旋钮，改它不该要重新编译，dev、自部署、生产也本该
// 能给不同的值。
//
// 还没做订阅，所以是全局一个值，不按用户区分 —— 那才需要数据库里加一列。
//
// errQuotaExceeded 由 recordImageObject 在超额时返回。
var errQuotaExceeded = errors.New("image quota exceeded")

// imageQuota 返回当前生效的配额上限。
//
// 包一层而不是各处直接读 a.cfg.ImageQuotaBytes：配额为 0 或负数意味着谁都传不了图，
// 而 Config 是可以被测试或将来别的加载路径构造出来的。这里兜一道底，
// 保证「配额永远是个正数」这件事只在一个地方保证。
func (a *App) imageQuota() int64 {
	if a.cfg.ImageQuotaBytes > 0 {
		return a.cfg.ImageQuotaBytes
	}
	return config.DefaultImageQuotaMB * 1024 * 1024
}

// storageBreakdown 是用户占用的云端存储，按来源分开。
//
// 分开而不是只给一个总数：用户看到"满了"之后要知道该删什么。只报总数的话，
// 一个存了 400 MB 图片的人可能会去删文档，白费功夫。
type storageBreakdown struct {
	// DocumentBytes 是文档正文与标题的字节数（Postgres 里的 text）
	DocumentBytes int64
	// ImageBytes 是图床对象的字节数（R2）
	ImageBytes int64
}

func (s storageBreakdown) Total() int64 {
	return s.DocumentBytes + s.ImageBytes
}

// storageUsageFor 查某用户占用的云端存储。
//
// 两项都算：图片在 R2，文档正文在 Postgres —— 两者都是"用户存在云端的东西"，
// 只算前者会让一个写了几百篇长文的人看到"用量 0"。
//
// 文档用 octet_length 而不是 length：后者按字符数算，中文正文会少算三分之二
// （UTF-8 下一个汉字 3 字节）。存储占用要的是字节。
//
// 每次都 SUM 而不是维护计数器：见 migrations/0008_image_quota.sql 里的说明。
// 文档那一项无法维护计数器 —— 自动保存每几秒就改一次正文长度。
func (a *App) storageUsageFor(ctx context.Context, userID int) (storageBreakdown, error) {
	var out storageBreakdown
	// COALESCE：没有任何行时 SUM 返回 NULL，直接 Scan 进 int64 会报错
	err := a.db.QueryRow(ctx, `
		SELECT
			COALESCE((
				SELECT SUM(octet_length(content) + octet_length(title))
				FROM documents WHERE user_id = $1
			), 0),
			COALESCE((
				SELECT SUM(bytes) FROM image_objects WHERE user_id = $1
			), 0)
	`, userID).Scan(&out.DocumentBytes, &out.ImageBytes)
	return out, err
}

// recordImageObject 把一个刚写进 R2 的对象记进账本，超额则拒绝。
//
// 校验与写入是同一条语句，这是这个函数存在的理由：
//
//	先 SELECT SUM 判断、再 INSERT 的话，两个并发上传会各自读到同一个 used，各自认为
//	"还差一点才满"，然后都插进去 —— 配额被突破的幅度取决于并发数。把判断写进
//	INSERT ... SELECT ... WHERE 里，这一句本身是原子的。
//
// 这仍不是完美串行化：默认的 READ COMMITTED 下，并发事务的子查询看不到对方未提交的行，
// 所以极端并发仍可能略微超出，上界是「并发数 × 单图上限」。单图上限 10 MiB、配额
// 500 MiB，这个误差不值得上 SERIALIZABLE 或表锁 —— 那要让每次正常上传都付锁竞争的代价。
//
// 返回记账后的用量。超额时返回 errQuotaExceeded，调用方据此让 Worker 把对象删掉。
func (a *App) recordImageObject(
	ctx context.Context,
	userID int,
	key string,
	bytes int64,
) (storageBreakdown, error) {
	// ON CONFLICT DO NOTHING：Worker 重试报账时同一个 key 可能报两次，不能重复计费。
	// key 是主键，冲突即说明已经记过了。
	//
	// 判定里要把文档正文也算上 —— 配额是"云端存储"而不是"图床"，
	// 少算文档会让一个写了几百篇长文的人凭空多出配额
	tag, err := a.db.Exec(ctx, `
		INSERT INTO image_objects (object_key, user_id, bytes)
		SELECT $1, $2, $3
		WHERE COALESCE(
			(SELECT SUM(bytes) FROM image_objects WHERE user_id = $2), 0
		) + COALESCE(
			(SELECT SUM(octet_length(content) + octet_length(title))
			 FROM documents WHERE user_id = $2), 0
		) + $3 <= $4
		ON CONFLICT (object_key) DO NOTHING
	`, key, userID, bytes, a.imageQuota())
	if err != nil {
		return storageBreakdown{}, err
	}

	used, uerr := a.storageUsageFor(ctx, userID)
	if uerr != nil {
		return storageBreakdown{}, uerr
	}

	if tag.RowsAffected() == 0 {
		// 没插进去有两种原因：超额，或 key 已存在（重试）。
		// 用 key 在不在账本里区分 —— 已存在就是重试，不算失败
		var exists bool
		if err := a.db.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM image_objects WHERE object_key = $1)`, key,
		).Scan(&exists); err != nil {
			return storageBreakdown{}, err
		}
		if !exists {
			return used, errQuotaExceeded
		}
	}

	return used, nil
}

// forgetImageObjects 从账本里移除若干对象，用量随之下降。
//
// 由回收任务在对象真的从 R2 删掉之后调用 —— 顺序很重要：先删账本再删 R2 的话，中间
// 失败会让那些对象永远不再计入配额，而它们还在占着存储。
func (a *App) forgetImageObjects(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	_, err := a.db.Exec(ctx,
		`DELETE FROM image_objects WHERE object_key = ANY($1)`, keys,
	)
	return err
}

// storageUsage 处理 GET /api/storage/usage —— 控制台展示用量。
//
// 路径不挂在 /api/images/ 下：Worker 把 /api/images/<key> 当作取图处理
// （见 worker/index.ts 的分派），/api/images/usage 会被它当成一个 key 截走，
// 永远到不了后端。
func (a *App) storageUsage(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	used, err := a.storageUsageFor(r.Context(), user.ID)
	if err != nil {
		log.Printf("storage usage: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	// 分项一起给：用户看到"满了"之后要知道该删什么。只报总数的话，
	// 一个存了 400 MB 图片的人可能会去删文档，白费功夫
	httpx.JSON(w, http.StatusOK, map[string]any{
		"usedBytes":     used.Total(),
		"documentBytes": used.DocumentBytes,
		"imageBytes":    used.ImageBytes,
		"quotaBytes":    a.imageQuota(),
	})
}

// imageRecord 处理 POST /api/images/record —— Worker 写完 R2 后来报账。
//
// 鉴权走既有的那条路：内部令牌 + X-Auth-User-Id 头，requireUser 会解析出用户
// （见 authUserIDFromRequest）。所以这里不需要另一套令牌校验。
//
// 它必须能拒绝：超额时返回 409，Worker 收到后把刚写的对象删掉。配额判定因此只有一个
// 实现，在数据库里。
func (a *App) imageRecord(w http.ResponseWriter, r *http.Request) {
	// 必须带内部令牌 —— 只有 Worker 该调这个端点。
	//
	// 光用 requireUser 不够：它也接受浏览器的会话 cookie，于是任何登录用户都能自己
	// 报账。危害具体是这样的：对一个记账曾经失败的 key 报 bytes=1，ON CONFLICT
	// DO NOTHING 会把这个错误的大小固定下来，之后再没人纠正 —— 等于绕过配额。
	if !a.hasInternalToken(r) {
		httpx.ErrorCode(w, http.StatusUnauthorized, "unauthorized", "Not logged in")
		return
	}

	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	var body struct {
		Key   string `json:"key"`
		Bytes int64  `json:"bytes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	if body.Key == "" || body.Bytes <= 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "missing_fields", "Key and bytes are required")
		return
	}

	// key 的归属必须与报账的用户一致。否则一个用户能把对象记到别人账上 ——
	// 既能耗尽别人的配额，也能让自己的用量不涨
	owner, ok := imageKeyOwner(body.Key)
	if !ok || owner != user.AuthUserID {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Key does not belong to this user")
		return
	}

	used, err := a.recordImageObject(r.Context(), user.ID, body.Key, body.Bytes)
	if errors.Is(err, errQuotaExceeded) {
		// 409 而不是 413：413 是"这一张太大"，这里是"总量满了"。
		// Worker 要据此区分回给前端哪个错误码
		httpx.JSON(w, http.StatusConflict, map[string]any{
			"code":          "image_quota_exceeded",
			"usedBytes":     used.Total(),
			"documentBytes": used.DocumentBytes,
			"imageBytes":    used.ImageBytes,
			"quotaBytes":    a.imageQuota(),
		})
		return
	}
	if err != nil {
		log.Printf("image record: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"usedBytes":     used.Total(),
		"documentBytes": used.DocumentBytes,
		"imageBytes":    used.ImageBytes,
		"quotaBytes":    a.imageQuota(),
	})
}
