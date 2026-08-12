-- 付款通知独立于权益发放：飞书不可用时保留待重试状态，但绝不回滚已提交的会员。
ALTER TABLE stripe_payments
    ADD COLUMN IF NOT EXISTS notified_at timestamptz;
--> statement-breakpoint
ALTER TABLE stripe_payments
    ADD COLUMN IF NOT EXISTS notification_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE stripe_payments
    ADD COLUMN IF NOT EXISTS notification_next_try_at timestamptz;
--> statement-breakpoint
ALTER TABLE stripe_payments
    ADD COLUMN IF NOT EXISTS notification_locked_until timestamptz;
--> statement-breakpoint
ALTER TABLE stripe_payments
    ADD COLUMN IF NOT EXISTS notification_last_error text;
--> statement-breakpoint
-- 迁移前的付款可能已经通知过，不能在部署后把全部历史订单重新推一遍。
UPDATE stripe_payments
SET notified_at = COALESCE(notified_at, now())
WHERE notified_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stripe_payments_notification_pending_idx
    ON stripe_payments (notification_next_try_at)
    WHERE notified_at IS NULL AND notification_next_try_at IS NOT NULL;
