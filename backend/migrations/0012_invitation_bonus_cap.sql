-- 邀请奖励是运营赠送额度，必须有数据库级天花板，避免应用层遗漏或并发写入
-- 把 R2 成本放大到无限。5 GiB 等于十次完整的 500 MiB 奖励。
UPDATE users
SET bonus_storage_bytes = LEAST(bonus_storage_bytes, 5368709120);
--> statement-breakpoint
ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_bonus_storage_bytes_check;
--> statement-breakpoint
ALTER TABLE users
    ADD CONSTRAINT users_bonus_storage_bytes_check
    CHECK (bonus_storage_bytes >= 0 AND bonus_storage_bytes <= 5368709120);
--> statement-breakpoint
-- 邀请人在到达上限后，邀请关系仍然成立，但该笔实际发放额为 0；最后一笔也可能
-- 只发剩余额度。因此账本记录实际发放额，允许 0 但不允许超过单次奖励。
ALTER TABLE invitations
    DROP CONSTRAINT IF EXISTS invitations_reward_bytes_check;
--> statement-breakpoint
ALTER TABLE invitations
    ADD CONSTRAINT invitations_reward_bytes_check
    CHECK (reward_bytes >= 0 AND reward_bytes <= 524288000);
