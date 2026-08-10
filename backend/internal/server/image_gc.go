package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// 图片回收：删文档后把不再被引用的 R2 对象排队删掉。
//
// 为什么异步：删 R2 要走一次网络到 Worker。放在删文档的请求里，成功时把响应从几十
// 毫秒拖到几百毫秒，失败时要么让删文档也失败（更坏），要么静默漏掉对象 —— 而漏掉
// 是不可观测的，只会表现为账单上慢慢长出来的存储费。
//
// 队列表 + 轮询 goroutine 而不是引 Redis 队列或作业框架：作业量就是「删文档的频率」，
// 一张表足够，且不增加运维面。表结构见 migrations/0007_image_gc.sql。

const (
	// 轮询间隔。回收不急，间隔长一点省数据库往返
	gcPollInterval = 30 * time.Second
	// 每轮最多处理多少个 key。Worker 的删除端点一次最多收 100 个
	gcBatchSize = 50
	// 放弃前最多重试几次。超过就留在表里并停止重试，last_error 里有原因
	gcMaxAttempts = 8
	// 调 Worker 的超时
	gcRequestTimeout = 15 * time.Second
)

// enqueueImageDeletions 把 key 排进回收队列。
//
// 调用方必须已经确认这些 key 属于当前用户，且没有别的文档在引用（见
// enqueueOrphanedImages）。这里不再判归属 —— 判归属需要 authUserId，而这个函数
// 只拿到 userID。
func (a *App) enqueueImageDeletions(ctx context.Context, userID int, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	safe := make([]string, 0, len(keys))
	for _, key := range keys {
		// 形状兜底。走到这里的 key 都是 extractOwnedImageKeys 产的，本该都合法
		if isSafeImageKey(key) {
			safe = append(safe, key)
		} else {
			log.Printf("image gc: 跳过形状不合法的 key %q", key)
		}
	}
	if len(safe) == 0 {
		return nil
	}

	// ON CONFLICT DO NOTHING：同一个 key 可能被多次入队（同一张图曾被两篇文档引用，
	// 两篇先后被删）。重复入队不是错误，忽略即可
	_, err := a.db.Exec(ctx, `
		INSERT INTO pending_image_deletions (object_key, user_id)
		SELECT unnest($1::text[]), $2
		ON CONFLICT (object_key) DO NOTHING
	`, safe, userID)
	return err
}

// enqueueOrphanedImages 找出 content 里属于该用户、且没有被他其它文档引用的图片，
// 排进回收队列。
//
// 「没被别的文档引用」这一步是必须的：同一张图可以被复制到多篇文档里（用户自己复制
// 粘贴，或从一篇拆成两篇）。删掉其中一篇就把图删了，另一篇的图会变成裂图。
//
// 调用时机是文档已经从表里删掉之后 —— 所以下面那条查询天然不会把自己算进引用方。
func (a *App) enqueueOrphanedImages(ctx context.Context, user userRef, content string) {
	keys := extractOwnedImageKeys(content, user.AuthUserID)
	if len(keys) == 0 {
		return
	}

	orphans := make([]string, 0, len(keys))
	for _, key := range keys {
		var referenced bool
		// 只在该用户自己的文档里找引用。别人的文档里即便出现同一个 key，那也是对方
		// 写在正文里的一个外链地址，不构成「这张图还有人用」—— 图的归属看 key 前缀
		err := a.db.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM documents
				WHERE user_id = $1 AND position($2 in content) > 0
			)
		`, user.ID, key).Scan(&referenced)
		if err != nil {
			// 查不动就别删 —— 宁可留着孤儿对象，也不能删掉还在用的图
			log.Printf("image gc: 检查引用失败，跳过 %s: %v", key, err)
			continue
		}
		if !referenced {
			orphans = append(orphans, key)
		}
	}

	if err := a.enqueueImageDeletions(ctx, user.ID, orphans); err != nil {
		// 入队失败只记日志：文档已经删成功了，不能因为回收失败就把删除也回滚
		log.Printf("image gc: 入队失败（%d 个 key）: %v", len(orphans), err)
	}
}

// userRef 是回收逻辑需要的用户字段。用它而不是整个 model.User，
// 是为了让「回收只需要 id 和 authUserId」这件事在签名上就看得出来。
type userRef struct {
	ID         int
	AuthUserID string
}

// StartImageGC 启动回收循环。ctx 取消时退出。
//
// 没配 WorkerURL 或 InternalToken 时不启动：那种情况下每轮都会失败，只是在日志里
// 刷屏。入队仍然照常 —— 配好之后重启就能把攒下的都回收掉。
func (a *App) StartImageGC(ctx context.Context) {
	if a.cfg.WorkerURL == "" || a.cfg.InternalToken == "" {
		log.Println("图片回收未启动：WORKER_URL 或 BACKEND_INTERNAL_TOKEN 未配置（待删记录会留在队列里）")
		return
	}

	go func() {
		log.Printf("图片回收已启动，每 %s 轮询一次", gcPollInterval)
		ticker := time.NewTicker(gcPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.runImageGCOnce(ctx); err != nil {
					log.Printf("image gc: 本轮出错: %v", err)
				}
			}
		}
	}()
}

// runImageGCOnce 处理一批到期的待删记录。
func (a *App) runImageGCOnce(ctx context.Context) error {
	rows, err := a.db.Query(ctx, `
		SELECT id, object_key, attempts
		FROM pending_image_deletions
		WHERE next_try_at <= now() AND attempts < $1
		ORDER BY next_try_at
		LIMIT $2
	`, gcMaxAttempts, gcBatchSize)
	if err != nil {
		return fmt.Errorf("取待删记录: %w", err)
	}

	type pending struct {
		id       int
		key      string
		attempts int
	}
	var batch []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.key, &p.attempts); err != nil {
			rows.Close()
			return fmt.Errorf("扫描待删记录: %w", err)
		}
		batch = append(batch, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("遍历待删记录: %w", err)
	}
	if len(batch) == 0 {
		return nil
	}

	// 删之前复查一次引用，把重新被用起来的图从这批里剔掉。
	//
	// 入队时判定过一次，但那是至少 30 秒前的事（轮询间隔），退避后可能是几十分钟前。
	// 这中间图可能重新回到正文里：
	//   · 用户删了图又按 Ctrl+Z 撤销
	//   · 把同一张图重新粘贴/复制到别处
	//   · 多标签编辑，另一篇文档引用了它
	// 少了这道复查，上面任一情形都会在 30 秒后把一张正在显示的图删掉 —— 用户看到
	// 的是"图片加载失败"，而正文里的地址看着完全正常。实测在生产上发生过。
	//
	// 复查放在这里而不是入队时加锁：加锁要横跨一次 HTTP 调用（删 R2），
	// 而这里只要在删之前的最后一刻确认一次，代价是一条查询。
	keys := make([]string, 0, len(batch))
	ids := make([]int, 0, len(batch))
	var revived []int
	for _, p := range batch {
		var referenced bool
		err := a.db.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM documents WHERE position($1 in content) > 0
			)
		`, p.key).Scan(&referenced)
		if err != nil {
			// 查不动就跳过这一个，留到下轮 —— 宁可晚点回收，也不能删掉可能还在用的图
			log.Printf("image gc: 删除前复查引用失败，跳过 %s: %v", p.key, err)
			continue
		}
		if referenced {
			// 重新被引用了，撤销这条删除令
			revived = append(revived, p.id)
			continue
		}
		keys = append(keys, p.key)
		ids = append(ids, p.id)
	}

	// 复活的直接从队列里删掉。留着的话每轮都要复查一次，且 attempts 到上限后
	// 会以"失败"的形态永久留在表里，看起来像有问题
	if len(revived) > 0 {
		if _, err := a.db.Exec(ctx,
			`DELETE FROM pending_image_deletions WHERE id = ANY($1)`, revived,
		); err != nil {
			log.Printf("image gc: 移除已复活记录失败: %v", err)
		} else {
			log.Printf("image gc: %d 个对象重新被引用，已撤销删除", len(revived))
		}
	}

	if len(keys) == 0 {
		return nil
	}

	if err := a.deleteImagesViaWorker(ctx, keys); err != nil {
		// 整批退避。逐个重试的话一个坏 key 会让整批一直卡着，而分不清是哪个坏
		// 也没关系 —— attempts 到上限后这批会各自停下，last_error 里有原因
		backoff := gcBackoff(batch[0].attempts)
		if _, uerr := a.db.Exec(ctx, `
			UPDATE pending_image_deletions
			SET attempts = attempts + 1, last_error = $2, next_try_at = now() + $3::interval
			WHERE id = ANY($1)
		`, ids, err.Error(), backoff.String()); uerr != nil {
			log.Printf("image gc: 记录失败状态时又出错: %v", uerr)
		}
		return fmt.Errorf("调 Worker 删除: %w", err)
	}

	// 对象已从 R2 删掉，把它们从用量账本里移除 —— 用户的已用空间到这一步才真正下降。
	//
	// 放在 R2 删除之后：反过来先减账本的话，中间失败会让这些对象永远不再计入配额，
	// 而它们还占着存储。宁可用量短暂偏高（下轮会补上），也不能让配额算漏。
	// 账本没减成功就保留队列记录，退避后重试 —— 不能往下走。
	//
	// 原来这里只记日志然后继续删队列记录，那等于把"用量永久偏高"固化下来：
	// 队列记录一删就再没人来减这几行账，而对象已经不在 R2 里了。用户为不存在的
	// 图付配额，最坏情况是配额被占满、再也传不了新图，且没有任何自救途径。
	//
	// 重试是安全的：R2 的 delete 幂等，重复删不报错；forgetImageObjects 是按 key
	// 删行，重复执行也是幂等的。
	if err := a.forgetImageObjects(ctx, keys); err != nil {
		backoff := gcBackoff(batch[0].attempts)
		if _, uerr := a.db.Exec(ctx, `
			UPDATE pending_image_deletions
			SET attempts = attempts + 1, last_error = $2, next_try_at = now() + $3::interval
			WHERE id = ANY($1)
		`, ids, "账本移除失败: "+err.Error(), backoff.String()); uerr != nil {
			log.Printf("image gc: 记录账本失败状态时又出错: %v", uerr)
		}
		return fmt.Errorf("从用量账本移除（%d 个 key）: %w", len(keys), err)
	}

	// 删成功就把记录清掉，不留档 —— 留着只会让表无限长
	if _, err := a.db.Exec(ctx,
		`DELETE FROM pending_image_deletions WHERE id = ANY($1)`, ids,
	); err != nil {
		// 对象已经删了但记录没清掉。下轮会重试，R2 的 delete 是幂等的，
		// 重复删不会报错
		return fmt.Errorf("清理已删记录: %w", err)
	}

	log.Printf("image gc: 已回收 %d 个对象", len(keys))
	return nil
}

// gcBackoff 按尝试次数算退避时长：1、2、4…最多 64 分钟。
func gcBackoff(attempts int) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	return time.Duration(1<<min(attempts, 6)) * time.Minute
}

// deleteImagesViaWorker 调 Worker 的删除端点。
//
// 为什么经 Worker 而不是后端直连 R2：R2 的凭证只在 Worker 那边（它有 bucket 绑定，
// 不需要密钥）。让后端直连要在 VPS 上再放一份 S3 凭证，并引一个 S3 SDK —— 多一份
// 要轮转的密钥、多一处泄露面。
func (a *App) deleteImagesViaWorker(ctx context.Context, keys []string) error {
	payload, err := json.Marshal(map[string]any{"keys": keys})
	if err != nil {
		return err
	}

	endpoint := a.cfg.WorkerURL + "/api/images/delete"
	reqCtx, cancel := context.WithTimeout(ctx, gcRequestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-koinote-internal-token", a.cfg.InternalToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("worker 返回 %d", resp.StatusCode)
	}

	var result struct {
		Deleted  int      `json:"deleted"`
		Rejected []string `json:"rejected"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("解析响应: %w", err)
	}
	if len(result.Rejected) > 0 {
		// Worker 拒了某些 key，说明两边的 isSafeImageKey 漂开了。
		//
		// 必须返回错误而不是只记日志：调用方把"没返回错误"理解成整批都删掉了，
		// 于是这些 key 会被清出队列，而对象还在 R2 里 —— 成了没人再回收的孤儿，
		// 且账本也跟着被减掉，用量比实际占用少，配额从此算不准。
		// 报错会让整批退避重试，attempts 到上限后 last_error 里留着这条线索。
		log.Printf("image gc: Worker 拒绝了 %d 个 key: %v", len(result.Rejected), result.Rejected)
		return fmt.Errorf("worker 拒绝了 %d 个 key（两端 isSafeImageKey 不一致）: %v",
			len(result.Rejected), result.Rejected)
	}
	return nil
}
