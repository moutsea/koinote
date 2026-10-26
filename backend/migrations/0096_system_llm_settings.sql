CREATE TABLE system_llm_settings (
    kind text PRIMARY KEY CHECK (kind IN ('text', 'image')),
    enabled boolean NOT NULL DEFAULT false,
    protocol text NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
    base_url text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    api_key_ciphertext bytea,
    api_key_hint text NOT NULL DEFAULT '',
    thinking boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by integer REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (kind <> 'image' OR (protocol = 'openai' AND NOT thinking))
);
--> statement-breakpoint
-- Keep historical channel credentials/reviews, but retire personal routing.
UPDATE users SET agent_provider_mode = 'builtin' WHERE agent_provider_mode <> 'builtin';
