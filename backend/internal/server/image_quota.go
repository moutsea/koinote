package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/config"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

// 图片存储配额。
//
// 上限来自 IMAGE_QUOTA_MB 环境变量（见 config.imageQuotaBytes），默认 500 MB。
// 放配置而不是代码常量：这是运营旋钮，改它不该要重新编译，dev、自部署、生产也本该
// 能给不同的值。
//
// 这里是免费用户的基础值；会员基础配额和邀请奖励由 storageQuotaFor 叠加。
//
// errQuotaExceeded 由 recordImageObject 在超额时返回。
var (
	errQuotaExceeded             = errors.New("image quota exceeded")
	errWechatExportQuotaExceeded = errors.New("wechat export image quota exceeded")
)

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

const lifetimeStorageQuotaBytes int64 = 10 * 1024 * 1024 * 1024

const (
	imagePurposePersistent   = "persistent"
	imagePurposeWechatExport = "wechat-export"
	wechatExportImageTTL     = 7 * 24 * time.Hour
	// purpose 由浏览器请求头传入，不能把它当成可信的“不计费”标记。公式图走独立的小额度：
	// 不挤占正文云存储，同时也不能被伪造 purpose 用来无限上传任意图片。
	wechatExportQuotaBytes int64 = 100 * 1024 * 1024
)

// storageQuotaFor 把会员等级映射为基础配额，再叠加有硬上限的永久邀请奖励。
// 数据库也有同样的约束；这里再次截断，避免迁移前旧数据或手工构造的模型绕过配额。
// 未来 AI 权益也读取同一个 membership_tier，避免支付状态在各功能里各自实现一遍。
func (a *App) storageQuotaFor(user model.User) int64 {
	baseQuota := a.imageQuota()
	if user.MembershipTier == membershipTierLifetime {
		baseQuota = lifetimeStorageQuotaBytes
	}
	return baseQuota + boundedInvitationBonus(user.BonusStorageBytes)
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
	return storageUsageForQuerier(ctx, a.db, userID)
}

type imageUsageQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func storageUsageForQuerier(
	ctx context.Context,
	querier imageUsageQuerier,
	userID int,
) (storageBreakdown, error) {
	var out storageBreakdown
	// COALESCE：没有任何行时 SUM 返回 NULL，直接 Scan 进 int64 会报错
	err := querier.QueryRow(ctx, `
		SELECT
			COALESCE((
				SELECT SUM(octet_length(content) + octet_length(title))
				FROM documents WHERE user_id = $1
			), 0),
			COALESCE((
				SELECT SUM(bytes) FROM image_objects
				WHERE user_id = $1 AND purpose = 'persistent'
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
// 与文档创建/更新共用用户级 advisory transaction lock。这样同一用户的图片记账和
// 文档扩容会串行读取配额，不会各自看见对方尚未提交前的旧用量。不同用户使用不同
// 锁键，彼此不阻塞。
//
// 返回记账后的用量。超额时返回 errQuotaExceeded，调用方据此让 Worker 把对象删掉。
func (a *App) recordImageObject(
	ctx context.Context,
	userID int,
	key string,
	bytes int64,
	quotaBytes int64,
	purpose string,
	deleteAt *time.Time,
) (storageBreakdown, error) {
	if purpose != imagePurposePersistent && purpose != imagePurposeWechatExport {
		return storageBreakdown{}, fmt.Errorf("invalid image purpose %q", purpose)
	}
	// ON CONFLICT DO NOTHING：Worker 重试报账时同一个 key 可能报两次，不能重复计费。
	// key 是主键，冲突即说明已经记过了。
	//
	// 判定里要把文档正文也算上 —— 配额是"云端存储"而不是"图床"，
	// 少算文档会让一个写了几百篇长文的人凭空多出配额
	// $3 必须显式标注 ::bigint，否则整条语句在 Postgres 侧 prepare 就失败。
	//
	// 原因：bytes 列是 bigint，所以 INSERT 的目标列把 $3 推成 bigint；而下面
	// WHERE 里 SUM(bytes) 返回的是 numeric（Postgres 对 bigint 求和会提升类型，
	// 防溢出），于是 `+ $3` 那处把 $3 推成 numeric。同一参数两种类型 →
	// 「inconsistent types deduced for parameter $3」（SQLSTATE 42P08）。
	//
	// 后果是这个功能**从来没工作过**：记账每次都 500，image_objects 全库 0 条，
	// 于是图片体积完全不计入配额 —— 用户看到的"云端存储用量"只有文档正文。
	// 而 Worker 侧对记账失败的处理是「放行上传，只记一行日志」（见 images.ts 的
	// recordUsage：宁可少算也不让用户贴不了图），所以前端完全无感，
	// 唯一的痕迹是 Worker 日志里的一行 warn。
	//
	// 与 documents.go 里新建文档那条是同一类错误（同一天发现的两处），
	// 都由 TestDocumentSQLPrepares 之外的 TestImageQuotaSQLPrepares 兜住。
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return storageBreakdown{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return storageBreakdown{}, err
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO image_objects (object_key, user_id, bytes, purpose)
		SELECT $1, $2, $3::bigint, $5::text
		WHERE (
			$5::text = 'persistent'
			AND COALESCE(
				(SELECT SUM(bytes) FROM image_objects
				 WHERE user_id = $2 AND purpose = 'persistent'), 0)
			+ COALESCE(
				(SELECT SUM(octet_length(content) + octet_length(title))
				 FROM documents WHERE user_id = $2), 0)
			+ $3::bigint <= $4
		) OR (
			$5::text = 'wechat-export'
			AND COALESCE(
				(SELECT SUM(bytes) FROM image_objects
				 WHERE user_id = $2 AND purpose = 'wechat-export'), 0)
			+ $3::bigint <= $6
		)
		ON CONFLICT (object_key) DO NOTHING
	`, key, userID, bytes, quotaBytes, purpose, wechatExportQuotaBytes)
	if err != nil {
		return storageBreakdown{}, err
	}

	used, uerr := storageUsageForQuerier(ctx, tx, userID)
	if uerr != nil {
		return storageBreakdown{}, uerr
	}

	if tag.RowsAffected() == 0 {
		// 没插进去有两种原因：超额，或 key 已存在（重试）。
		// 用 key 在不在账本里区分 —— 已存在就是重试，不算失败
		var existingUserID int
		var existingBytes int64
		var existingPurpose string
		err := tx.QueryRow(ctx,
			`SELECT user_id, bytes, purpose FROM image_objects WHERE object_key = $1`, key,
		).Scan(&existingUserID, &existingBytes, &existingPurpose)
		if errors.Is(err, pgx.ErrNoRows) {
			if purpose == imagePurposeWechatExport {
				return used, errWechatExportQuotaExceeded
			}
			return used, errQuotaExceeded
		}
		if err != nil {
			return storageBreakdown{}, err
		}
		if existingUserID != userID || existingBytes != bytes || existingPurpose != purpose {
			return storageBreakdown{}, fmt.Errorf("image object metadata mismatch for %q", key)
		}
	}

	if deleteAt != nil {
		if _, err := tx.Exec(ctx, `
			INSERT INTO pending_image_deletions (
				object_key, user_id, attempts, last_error, next_try_at
			) VALUES ($1, $2, 0, NULL, $3)
			ON CONFLICT (object_key) DO UPDATE SET
				user_id = EXCLUDED.user_id,
				attempts = 0,
				last_error = NULL,
				next_try_at = GREATEST(
					pending_image_deletions.next_try_at,
					EXCLUDED.next_try_at
				)
		`, key, userID, *deleteAt); err != nil {
			return storageBreakdown{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return storageBreakdown{}, err
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
		"quotaBytes":    a.storageQuotaFor(user),
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
		Key     string `json:"key"`
		Bytes   int64  `json:"bytes"`
		Purpose string `json:"purpose"`
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

	purpose := body.Purpose
	var deleteAt *time.Time
	switch body.Purpose {
	case "":
		purpose = imagePurposePersistent
	case imagePurposePersistent:
	case imagePurposeWechatExport:
		expires := time.Now().Add(wechatExportImageTTL)
		deleteAt = &expires
	default:
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid image purpose")
		return
	}

	quotaBytes := a.storageQuotaFor(user)
	used, err := a.recordImageObject(
		r.Context(), user.ID, body.Key, body.Bytes, quotaBytes, purpose, deleteAt,
	)
	if errors.Is(err, errQuotaExceeded) {
		// 409 而不是 413：413 是"这一张太大"，这里是"总量满了"。
		// Worker 要据此区分回给前端哪个错误码
		httpx.JSON(w, http.StatusConflict, map[string]any{
			"code":          "image_quota_exceeded",
			"usedBytes":     used.Total(),
			"documentBytes": used.DocumentBytes,
			"imageBytes":    used.ImageBytes,
			"quotaBytes":    quotaBytes,
		})
		return
	}
	if errors.Is(err, errWechatExportQuotaExceeded) {
		httpx.JSON(w, http.StatusConflict, map[string]any{
			"code":       "temporary_image_quota_exceeded",
			"quotaBytes": wechatExportQuotaBytes,
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
		"quotaBytes":    quotaBytes,
	})
}
