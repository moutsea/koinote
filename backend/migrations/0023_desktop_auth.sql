-- Desktop authorization codes are short-lived, single-use, and bound to a PKCE
-- challenge. Only the SHA-256 hash is stored, so a database read cannot turn an
-- unconsumed code into a desktop session.
CREATE TABLE IF NOT EXISTS desktop_authorization_codes (
    id             bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    code_hash      bytea NOT NULL UNIQUE,
    user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_challenge varchar(128) NOT NULL,
    expires_at     timestamptz NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS desktop_authorization_codes_expires_idx
    ON desktop_authorization_codes (expires_at);
--> statement-breakpoint
-- Refresh tokens are opaque, rotated on every use, and tied to the account's
-- session_version. Password changes and "sign out other devices" therefore
-- invalidate desktop sessions as well as browser cookies.
CREATE TABLE IF NOT EXISTS desktop_refresh_tokens (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    token_id        text NOT NULL UNIQUE,
    family_id       text NOT NULL,
    user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      bytea NOT NULL UNIQUE,
    session_version bigint NOT NULL CHECK (session_version > 0),
    expires_at      timestamptz NOT NULL,
    last_used_at    timestamptz,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS desktop_refresh_tokens_user_created_idx
    ON desktop_refresh_tokens (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS desktop_refresh_tokens_family_idx
    ON desktop_refresh_tokens (family_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS desktop_refresh_tokens_expires_idx
    ON desktop_refresh_tokens (expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS desktop_refresh_tokens_revoked_idx
    ON desktop_refresh_tokens (revoked_at) WHERE revoked_at IS NOT NULL;
--> statement-breakpoint
-- Access tokens are deliberately short lived. Keeping them opaque makes
-- revocation and session-version checks authoritative at the backend.
CREATE TABLE IF NOT EXISTS desktop_access_tokens (
    id               bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    token_hash       bytea NOT NULL UNIQUE,
    refresh_token_id bigint NOT NULL REFERENCES desktop_refresh_tokens(id) ON DELETE CASCADE,
    user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_version  bigint NOT NULL CHECK (session_version > 0),
    expires_at       timestamptz NOT NULL,
    last_used_at     timestamptz,
    revoked_at       timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS desktop_access_tokens_user_expires_idx
    ON desktop_access_tokens (user_id, expires_at);
