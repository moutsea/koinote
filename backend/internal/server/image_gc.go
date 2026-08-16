package server

import (
	"bytes"
	"context"
	"database/sql"
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
// 队列表 + 轮询 goroutine 而不是引外部队列或作业框架：作业量就是「删文档的频率」，
// 一张表足够，且不增加运维面。表结构见 migrations/0007_image_gc.sql。

const (
	// 轮询间隔。回收不急，间隔长一点省数据库往返
	gcPollInterval = 30 * time.Second
	// 每轮最多处理多少个 key。Worker 的删除端点一次最多收 100 个
	gcBatchSize = 50
	// 前 8 次指数退避，之后每天慢速重试，不让任务永久停摆
	gcFastRetryAttempts = 8
	gcSlowRetryInterval = 24 * time.Hour
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

	// 重新入队时恢复尝试次数。旧任务可能因长期故障累计了很多 attempts；既然对象再次
	// 被确认成孤儿，就应立即给它一次新的回收机会。
	_, err := a.db.Exec(ctx, `
		INSERT INTO pending_image_deletions (object_key, user_id)
		SELECT unnest($1::text[]), $2
		ON CONFLICT (object_key) DO UPDATE SET
			user_id = EXCLUDED.user_id,
			attempts = 0,
			last_error = NULL,
			next_try_at = now()
	`, safe, userID)
	return err
}

// cancelPendingImageDeletions 撤销正文里仍在引用的待删对象。
//
// GC 真正执行前还会复查一次；这里额外主动撤销，是为了把「撤销删除 / 重新粘贴」到
// 下一轮 GC 之间的窗口尽量缩短，也避免复活记录一直占着队列。只按 user_id 撤销，
// 别人把这个 URL 当外链写进正文不能替所有者续命。
func (a *App) cancelPendingImageDeletions(ctx context.Context, user userRef, content string) {
	keys := extractOwnedImageKeys(content, user.AuthUserID)
	if len(keys) == 0 {
		return
	}
	if _, err := a.db.Exec(ctx, `
		DELETE FROM pending_image_deletions
		WHERE user_id = $1 AND object_key = ANY($2)
	`, user.ID, keys); err != nil {
		// 取消失败不该让正文保存失败；GC 的删除前复查仍是最后一道安全网。
		log.Printf("image gc: 撤销仍被引用的待删记录失败: %v", err)
	}
}

// enqueueOrphanedImages 找出 content 里属于该用户、且没有被他的当前文档或保留的
// 历史版本引用的图片，
// 排进回收队列。
//
// 「没被别的文档引用」这一步是必须的：同一张图可以被复制到多篇文档里（用户自己复制
// 粘贴，或从一篇拆成两篇）。删掉其中一篇就把图删了，另一篇的图会变成裂图。
//
// 调用时机是文档已经从表里删掉之后 —— 所以下面那条查询天然不会把自己算进引用方。
func (a *App) enqueueOrphanedImages(ctx context.Context, user userRef, content string) {
	keys := extractOwnedImageKeys(content, user.AuthUserID)
	a.enqueueOrphanedImageKeys(ctx, user, keys)
}

// enqueueOrphanedImageKeys 批量确认候选 key 是否仍被引用。
//
// 先从该用户的当前文档和历史版本中一次性抽出全部图片 key，再与候选集合做差集。
// 这样删除一篇含多张图片的文档时只扫描一次正文，而不是每个 key 都全表扫描一遍。
func (a *App) enqueueOrphanedImageKeys(ctx context.Context, user userRef, keys []string) {
	queued, err := a.enqueueOrphanedImageKeysChecked(ctx, user, keys)
	if err != nil {
		// 入队失败只记日志：触发回收的文档写操作已经成功，不能再回滚正文。
		log.Printf("image gc: 入队失败（候选 %d 个）: %v", len(keys), err)
		return
	}
	if queued > 0 {
		log.Printf("image gc: 已排队 %d 个孤儿对象", queued)
	}
}

// enqueueOrphanedImageKeysChecked 与 enqueueOrphanedImageKeys 做同样的归属和引用复查，
// 但把错误返回给需要向用户确认结果的调用方（例如失败导入的图片回滚接口）。
func (a *App) enqueueOrphanedImageKeysChecked(ctx context.Context, user userRef, keys []string) (int, error) {
	if len(keys) == 0 {
		return 0, nil
	}

	candidates := make([]string, 0, len(keys))
	seen := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		owner, ok := imageKeyOwner(key)
		if !ok || owner != user.AuthUserID {
			continue
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		candidates = append(candidates, key)
	}
	if len(candidates) == 0 {
		return 0, nil
	}

	rows, err := a.db.Query(ctx, `
		WITH owned_contents AS (
			SELECT content
			FROM documents
			WHERE user_id = $1
			UNION ALL
			SELECT v.content
			FROM document_versions v
			JOIN documents d ON d.id = v.document_id
			WHERE d.user_id = $1
		), referenced_keys AS (
			SELECT DISTINCT 'u/' || matches[1] || '/' || matches[2] || '.' || matches[3] AS object_key
			FROM owned_contents
			CROSS JOIN LATERAL regexp_matches(content, $2, 'g') AS matches
			WHERE matches[1] = $3
		)
		SELECT candidate
		FROM unnest($4::text[]) AS candidate
		WHERE NOT EXISTS (
			SELECT 1 FROM referenced_keys WHERE object_key = candidate
		)
	`, user.ID, imageKeyPattern.String(), user.AuthUserID, candidates)
	if err != nil {
		// 查不动就别删 —— 宁可留着孤儿对象，也不能删掉还在用的图。
		return 0, fmt.Errorf("批量检查引用: %w", err)
	}
	defer rows.Close()
	orphans := make([]string, 0, len(candidates))
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return 0, fmt.Errorf("扫描孤儿 key: %w", err)
		}
		orphans = append(orphans, key)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("遍历孤儿 key: %w", err)
	}

	if err := a.enqueueImageDeletions(ctx, user.ID, orphans); err != nil {
		return 0, fmt.Errorf("写入回收队列: %w", err)
	}
	return len(orphans), nil
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
		SELECT id, object_key, user_id, attempts
		FROM pending_image_deletions
		WHERE next_try_at <= now()
		ORDER BY next_try_at
		LIMIT $1
	`, gcBatchSize)
	if err != nil {
		return fmt.Errorf("取待删记录: %w", err)
	}

	type pending struct {
		id       int
		key      string
		userID   sql.NullInt64
		attempts int
	}
	var batch []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.key, &p.userID, &p.attempts); err != nil {
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
	//   · 多标签编辑，自己的另一篇文档引用了它
	// 少了这道复查，上面任一情形都会在 30 秒后把一张正在显示的图删掉 —— 用户看到
	// 的是"图片加载失败"，而正文里的地址看着完全正常。实测在生产上发生过。
	//
	// 复查放在这里而不是入队时加锁：加锁要横跨一次 HTTP 调用（删 R2），
	// 而这里只要在删之前的最后一刻确认一次，代价是一条查询。
	keys := make([]string, 0, len(batch))
	ids := make([]int, 0, len(batch))
	var revived []int
	userIDs := make([]int64, 0, len(batch))
	ownedKeys := make([]string, 0, len(batch))
	for _, pendingImage := range batch {
		if pendingImage.userID.Valid {
			userIDs = append(userIDs, pendingImage.userID.Int64)
			ownedKeys = append(ownedKeys, pendingImage.key)
		}
	}
	referencedKeys, referenceErr := a.referencedImageKeys(ctx, userIDs, ownedKeys)
	if referenceErr != nil {
		// 用户仍存在的对象全部留到下轮。user_id 已为 NULL 的账号删除遗留对象不需要
		// 查引用，仍可继续回收。
		log.Printf("image gc: 删除前批量复查引用失败: %v", referenceErr)
	}
	for _, p := range batch {
		if p.userID.Valid && referenceErr != nil {
			continue
		}
		// user_id 为 NULL 说明账号已经删除。此时已没有「所有者自己的文档」，
		// 别人正文里的同 URL 只是外链，不能让这个对象永久占着存储。
		if _, referenced := referencedKeys[p.key]; referenced {
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

	pendingByKey := make(map[string]pending, len(batch))
	for _, p := range batch {
		pendingByKey[p.key] = p
	}

	result, err := a.deleteImagesViaWorker(ctx, keys)
	if err != nil {
		backoff := gcBackoff(pendingByKey[keys[0]].attempts)
		if _, uerr := a.db.Exec(ctx, `
			UPDATE pending_image_deletions
			SET attempts = attempts + 1, last_error = $2, next_try_at = now() + $3::interval
			WHERE id = ANY($1)
		`, ids, err.Error(), backoff.String()); uerr != nil {
			log.Printf("image gc: 记录失败状态时又出错: %v", uerr)
		}
		return fmt.Errorf("调 Worker 删除: %w", err)
	}

	if len(result.Rejected) > 0 {
		rejectedIDs := make([]int, 0, len(result.Rejected))
		for _, key := range result.Rejected {
			rejectedIDs = append(rejectedIDs, pendingByKey[key].id)
		}
		backoff := gcBackoff(pendingByKey[result.Rejected[0]].attempts)
		message := fmt.Sprintf("worker 拒绝 key（两端 isSafeImageKey 不一致）: %v", result.Rejected)
		if _, uerr := a.db.Exec(ctx, `
			UPDATE pending_image_deletions
			SET attempts = attempts + 1, last_error = $2, next_try_at = now() + $3::interval
			WHERE id = ANY($1)
		`, rejectedIDs, message, backoff.String()); uerr != nil {
			log.Printf("image gc: 记录 Worker 拒绝状态失败: %v", uerr)
		}
		log.Printf("image gc: Worker 拒绝了 %d 个 key，已与成功项分开退避", len(result.Rejected))
	}

	// Worker 逐项返回结果。成功项继续清账本，拒绝项只退避自己，不能让一个
	// 毒丸 key 拖着同批已经从 R2 删除的对象重复到 attempts 上限。
	keys = result.Deleted
	ids = ids[:0]
	for _, key := range keys {
		ids = append(ids, pendingByKey[key].id)
	}
	if len(keys) == 0 {
		return nil
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
		backoff := gcBackoff(pendingByKey[keys[0]].attempts)
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

func (a *App) referencedImageKeys(ctx context.Context, userIDs []int64, keys []string) (map[string]struct{}, error) {
	referenced := make(map[string]struct{})
	if len(keys) == 0 {
		return referenced, nil
	}
	rows, err := a.db.Query(ctx, `
		WITH candidates AS (
			SELECT user_id, object_key
			FROM unnest($1::bigint[], $2::text[]) AS candidate(user_id, object_key)
		), owned_contents AS (
			SELECT document.user_id, document.content
			FROM documents AS document
			WHERE document.user_id IN (SELECT DISTINCT user_id FROM candidates)
			UNION ALL
			SELECT document.user_id, version.content
			FROM document_versions AS version
			JOIN documents AS document ON document.id = version.document_id
			WHERE document.user_id IN (SELECT DISTINCT user_id FROM candidates)
		), extracted_keys AS (
			SELECT DISTINCT content.user_id,
				'u/' || matches[1] || '/' || matches[2] || '.' || matches[3] AS object_key
			FROM owned_contents AS content
			CROSS JOIN LATERAL regexp_matches(content.content, $3, 'g') AS matches
		)
		SELECT DISTINCT candidate.object_key
		FROM candidates AS candidate
		JOIN extracted_keys AS extracted
		  ON extracted.user_id = candidate.user_id
		 AND extracted.object_key = candidate.object_key
	`, userIDs, keys, imageKeyPattern.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		referenced[key] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return referenced, nil
}

// gcBackoff 前 8 次按 1、2、4…分钟退避，之后每天慢速重试。
func gcBackoff(attempts int) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	if attempts >= gcFastRetryAttempts {
		return gcSlowRetryInterval
	}
	return time.Duration(1<<min(attempts, 6)) * time.Minute
}

// deleteImagesViaWorker 调 Worker 的删除端点。
//
// 为什么经 Worker 而不是后端直连 R2：R2 的凭证只在 Worker 那边（它有 bucket 绑定，
// 不需要密钥）。让后端直连要在 VPS 上再放一份 S3 凭证，并引一个 S3 SDK —— 多一份
// 要轮转的密钥、多一处泄露面。
type imageDeleteResult struct {
	Deleted  []string `json:"deleted"`
	Rejected []string `json:"rejected"`
}

func (a *App) deleteImagesViaWorker(ctx context.Context, keys []string) (imageDeleteResult, error) {
	var result imageDeleteResult
	payload, err := json.Marshal(map[string]any{"keys": keys})
	if err != nil {
		return result, err
	}

	endpoint := a.cfg.WorkerURL + "/api/images/delete"
	reqCtx, cancel := context.WithTimeout(ctx, gcRequestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return result, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-koinote-internal-token", a.cfg.InternalToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return result, fmt.Errorf("worker 返回 %d", resp.StatusCode)
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return result, fmt.Errorf("解析响应: %w", err)
	}

	requested := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		requested[key] = struct{}{}
	}
	seen := make(map[string]struct{}, len(keys))
	allResults := append(append([]string(nil), result.Deleted...), result.Rejected...)
	for _, key := range allResults {
		if _, ok := requested[key]; !ok {
			return imageDeleteResult{}, fmt.Errorf("worker 返回了未请求的 key %q", key)
		}
		if _, duplicate := seen[key]; duplicate {
			return imageDeleteResult{}, fmt.Errorf("worker 重复返回 key %q", key)
		}
		seen[key] = struct{}{}
	}
	if len(seen) != len(requested) {
		return imageDeleteResult{}, fmt.Errorf("worker 响应不完整：请求 %d，返回 %d", len(requested), len(seen))
	}
	return result, nil
}
