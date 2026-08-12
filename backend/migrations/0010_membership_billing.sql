-- 会员权益保存在本站数据库中，Stripe 只负责收款与支付凭证。
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS membership_tier varchar(16) NOT NULL DEFAULT 'free';
--> statement-breakpoint
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS membership_granted_at timestamptz;
--> statement-breakpoint
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS stripe_customer_id text;
--> statement-breakpoint
ALTER TABLE users
    ADD CONSTRAINT users_membership_tier_check
    CHECK (membership_tier IN ('free', 'lifetime'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_idx
    ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
--> statement-breakpoint
-- 每个已支付 Checkout Session 只落一行。Webhook 重试和成功页主动确认都会命中
-- 同一个主键，因此发放权益天然幂等。
CREATE TABLE IF NOT EXISTS stripe_payments (
    checkout_session_id text PRIMARY KEY,
    payment_intent_id   text NOT NULL,
    customer_id         text NOT NULL,
    user_id             integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    plan_code           varchar(32) NOT NULL CHECK (plan_code IN ('lifetime')),
    amount              bigint NOT NULL CHECK (amount > 0),
    currency            varchar(3) NOT NULL,
    status              varchar(16) NOT NULL CHECK (status IN ('paid')),
    source_event_id     text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS stripe_payments_intent_idx
    ON stripe_payments (payment_intent_id);
