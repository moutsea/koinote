-- A user may have only one payable lifetime-membership Checkout Session at a
-- time. This prevents repeated clicks, concurrent clients, or currency changes
-- from leaving multiple sessions that can all charge the same account.
CREATE TABLE IF NOT EXISTS stripe_checkout_attempts (
    user_id             integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    checkout_session_id text NOT NULL UNIQUE,
    checkout_url        text NOT NULL,
    currency            varchar(3) NOT NULL,
    client              varchar(16) NOT NULL,
    expires_at          timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stripe_checkout_attempts_client_check CHECK (client IN ('web', 'desktop'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stripe_checkout_attempts_expires_idx
    ON stripe_checkout_attempts (expires_at);
