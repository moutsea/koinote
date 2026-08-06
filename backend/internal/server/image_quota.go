package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"koinote/backend/internal/httpx"
)

// 图片存储配额。
//
// 还没做订阅，所以每个用户一个固定上限。上限放在代码里而不是数据库：现在没有"按用户设
// 不同额度"的需求，加一列 quota_bytes 只会多一处要维护的状态。等真有订阅了再搬。
const ImageQuotaBytes int64 = 500 * 1024 * 1024 // 500 MiB

// errQuotaExceeded 由 recordImageObject 在超额时返回。
var errQuotaExceeded = errors.New("image quota exceeded")

// imageUsage 查某用户已占用的字节数。
//
// 每次都 SUM 而不是维护计数器：见 migrations/0008_image_quota.sql 里的说明。
// user_id 上有索引，这个查询在几千行的量级下是微秒级的。
func (a *App) imageUsage(ctx context.Context, userID int) (int64, error) {
	var used int64
	// COALESCE：没有任何图时 SUM 返回 NULL，直接 Scan 进 int64 会报错
	err := a.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(bytes), 0) FROM image_objects WHERE user_id = $1
	`, userID).Scan(&used)
	return used, err
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
) (int64, error) {
	// ON CONFLICT DO NOTHING：Worker 重试报账时同一个 key 可能报两次，不能重复计费。
	// key 是主键，冲突即说明已经记过了
	tag, err := a.db.Exec(ctx, `
		INSERT INTO image_objects (object_key, user_id, bytes)
		SELECT $1, $2, $3
		WHERE COALESCE(
			(SELECT SUM(bytes) FROM image_objects WHERE user_id = $2), 0
		) + $3 <= $4
		ON CONFLICT (object_key) DO NOTHING
	`, key, userID, bytes, ImageQuotaBytes)
	if err != nil {
		return 0, err
	}

	used, uerr := a.imageUsage(ctx, userID)
	if uerr != nil {
		return 0, uerr
	}

	if tag.RowsAffected() == 0 {
		// 没插进去有两种原因：超额，或 key 已存在（重试）。
		// 用 key 在不在账本里区分 —— 已存在就是重试，不算失败
		var exists bool
		if err := a.db.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM image_objects WHERE object_key = $1)`, key,
		).Scan(&exists); err != nil {
			return 0, err
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

	used, err := a.imageUsage(r.Context(), user.ID)
	if err != nil {
		log.Printf("storage usage: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"usedBytes":  used,
		"quotaBytes": ImageQuotaBytes,
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
			"code":       "image_quota_exceeded",
			"usedBytes":  used,
			"quotaBytes": ImageQuotaBytes,
		})
		return
	}
	if err != nil {
		log.Printf("image record: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"usedBytes":  used,
		"quotaBytes": ImageQuotaBytes,
	})
}
