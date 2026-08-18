ALTER TABLE users
    ADD COLUMN IF NOT EXISTS agent_provider_mode varchar(16) NOT NULL DEFAULT 'builtin';
--> statement-breakpoint
ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_agent_provider_mode_check;
--> statement-breakpoint
ALTER TABLE users
    ADD CONSTRAINT users_agent_provider_mode_check
    CHECK (agent_provider_mode IN ('builtin', 'byok'));
