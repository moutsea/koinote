CREATE TABLE IF NOT EXISTS user_feedback (
    id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_id    integer REFERENCES users(id) ON DELETE SET NULL,
    category   varchar(16) NOT NULL CHECK (category IN ('bug', 'experience')),
    message    text NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 4000),
    page_path  varchar(512) NOT NULL DEFAULT '',
    client     varchar(16) NOT NULL CHECK (client IN ('web', 'desktop')),
    user_agent varchar(512) NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_feedback_created_idx
    ON user_feedback (created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_feedback_user_idx
    ON user_feedback (user_id, created_at DESC);
