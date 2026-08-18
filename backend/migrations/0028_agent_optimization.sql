-- AI optimization is a paid lifetime-member benefit. Credits use a
-- cached balance plus an immutable ledger; active reservations prevent two
-- concurrent reviews from spending the same balance.
ALTER TABLE document_versions
    DROP CONSTRAINT IF EXISTS document_versions_source_check;
--> statement-breakpoint
ALTER TABLE document_versions
    ADD CONSTRAINT document_versions_source_check
    CHECK (source IN ('web', 'mcp', 'restore', 'agent'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS credit_accounts (
    user_id     integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance     bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
    reserved    bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= balance),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS credit_transactions (
    entry_id       text PRIMARY KEY,
    user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind           varchar(32) NOT NULL CHECK (kind IN (
        'membership_grant', 'purchase', 'agent_usage', 'adjustment', 'refund'
    )),
    amount         bigint NOT NULL CHECK (amount <> 0),
    balance_after  bigint NOT NULL CHECK (balance_after >= 0),
    reference_key  text NOT NULL UNIQUE,
    metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_transactions_user_created_idx
    ON credit_transactions (user_id, created_at DESC, entry_id DESC);
--> statement-breakpoint

-- Users may keep more than one provider profile, but only one can be the
-- default. api_key_ciphertext is encrypted by the backend with an independent
-- credential key; plaintext is never returned after the write request.
CREATE TABLE IF NOT EXISTS llm_channels (
    id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    channel_id          text NOT NULL UNIQUE,
    user_id             integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                varchar(80) NOT NULL,
    protocol            varchar(16) NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
    base_url            text NOT NULL,
    model               varchar(160) NOT NULL,
    api_key_ciphertext  bytea NOT NULL,
    api_key_hint        varchar(24) NOT NULL,
    is_default          boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS llm_channels_one_default_idx
    ON llm_channels (user_id) WHERE is_default;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS llm_channels_user_created_idx
    ON llm_channels (user_id, created_at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_reviews (
    id                 bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    review_id          text NOT NULL UNIQUE,
    user_id            integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id        integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    base_revision      bigint NOT NULL CHECK (base_revision > 0),
    current_revision   bigint NOT NULL CHECK (current_revision > 0),
    provider_mode      varchar(16) NOT NULL CHECK (provider_mode IN ('builtin', 'byok')),
    provider_protocol  varchar(16) NOT NULL CHECK (provider_protocol IN ('openai', 'anthropic')),
    channel_id         bigint REFERENCES llm_channels(id) ON DELETE SET NULL,
    model              varchar(160) NOT NULL,
    status             varchar(24) NOT NULL CHECK (status IN (
        'running', 'ready', 'partially_applied', 'applied', 'dismissed', 'failed', 'stale'
    )),
    summary            text,
    title_score        smallint CHECK (title_score BETWEEN 0 AND 100),
    title_assessment   text,
    input_tokens       integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens      integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    total_tokens       integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
    credits_charged    integer NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
    error_code         varchar(64),
    created_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_reviews_user_created_idx
    ON agent_reviews (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_reviews_document_created_idx
    ON agent_reviews (document_id, created_at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS credit_reservations (
    reservation_id    text PRIMARY KEY,
    user_id           integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Review 随文档删除时保留活动预留，等过期回收去回减账户 reserved；
    -- 若在这里 CASCADE，reservation 行没了但缓存计数仍在，会永久冻结余额。
    review_id         bigint UNIQUE REFERENCES agent_reviews(id) ON DELETE SET NULL,
    reserved_credits  integer NOT NULL CHECK (reserved_credits > 0),
    committed_credits integer CHECK (committed_credits > 0),
    status            varchar(16) NOT NULL CHECK (status IN ('active', 'committed', 'released')),
    expires_at        timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_reservations_active_expiry_idx
    ON credit_reservations (expires_at) WHERE status = 'active';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_review_suggestions (
    id             bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    suggestion_id  text NOT NULL UNIQUE,
    review_id      bigint NOT NULL REFERENCES agent_reviews(id) ON DELETE CASCADE,
    ordinal        integer NOT NULL CHECK (ordinal >= 0),
    target         varchar(16) NOT NULL CHECK (target IN ('title', 'body')),
    category       varchar(32) NOT NULL,
    before_text    text NOT NULL,
    after_text     text NOT NULL,
    reason         text NOT NULL,
    status         varchar(16) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'applied', 'dismissed')),
    applied_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (review_id, ordinal)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_review_suggestions_review_status_idx
    ON agent_review_suggestions (review_id, status, ordinal);
--> statement-breakpoint

-- Credit packs have their own immutable payment table. Keeping it separate
-- from lifetime membership avoids weakening the existing plan_code constraint.
CREATE TABLE IF NOT EXISTS stripe_credit_payments (
    checkout_session_id text PRIMARY KEY,
    payment_intent_id   text NOT NULL UNIQUE,
    customer_id         text NOT NULL,
    user_id             integer REFERENCES users(id) ON DELETE SET NULL,
    pack_code           varchar(32) NOT NULL CHECK (pack_code IN (
        'credits_3000', 'credits_10000', 'credits_30000'
    )),
    credits             integer NOT NULL CHECK (credits > 0),
    amount              bigint NOT NULL CHECK (amount > 0),
    currency            varchar(3) NOT NULL,
    status              varchar(16) NOT NULL CHECK (status IN ('paid')),
    source_event_id     text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS stripe_credit_checkout_attempts (
    user_id             integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    checkout_session_id text NOT NULL UNIQUE,
    checkout_url        text NOT NULL,
    pack_code           varchar(32) NOT NULL CHECK (pack_code IN (
        'credits_3000', 'credits_10000', 'credits_30000'
    )),
    client              varchar(16) NOT NULL CHECK (client IN ('web', 'desktop')),
    expires_at          timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stripe_credit_checkout_attempts_expires_idx
    ON stripe_credit_checkout_attempts (expires_at);
--> statement-breakpoint

-- Existing lifetime members receive the same one-time grant as future buyers.
INSERT INTO credit_accounts (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;
--> statement-breakpoint
WITH inserted AS (
    INSERT INTO credit_transactions (
        entry_id, user_id, kind, amount, balance_after, reference_key, metadata
    )
    SELECT
        'membership-grant:' || users.id,
        users.id,
        'membership_grant',
        1000,
        credit_accounts.balance + 1000,
        'membership-grant:' || users.id,
        jsonb_build_object('source', 'migration')
    FROM users
    JOIN credit_accounts ON credit_accounts.user_id = users.id
    WHERE users.membership_tier = 'lifetime'
    ON CONFLICT (reference_key) DO NOTHING
    RETURNING user_id, amount
)
UPDATE credit_accounts
SET balance = credit_accounts.balance + inserted.amount,
    updated_at = now()
FROM inserted
WHERE credit_accounts.user_id = inserted.user_id;
