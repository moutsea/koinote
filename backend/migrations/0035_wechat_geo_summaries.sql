CREATE TABLE IF NOT EXISTS document_wechat_geo_summaries (
    document_id   integer PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    source_hash   char(64) NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    summary       text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 600),
    topics        jsonb NOT NULL CHECK (jsonb_typeof(topics) = 'array'),
    keywords      jsonb NOT NULL CHECK (jsonb_typeof(keywords) = 'array'),
    rendered_text text NOT NULL CHECK (char_length(rendered_text) BETWEEN 1 AND 2400),
    provider_mode varchar(16) NOT NULL CHECK (provider_mode IN ('builtin', 'byok')),
    model         varchar(160) NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON COLUMN document_wechat_geo_summaries.summary IS
    'AI-generated snapshot; manual edits only update rendered_text';
--> statement-breakpoint
COMMENT ON COLUMN document_wechat_geo_summaries.topics IS
    'AI-generated snapshot; manual edits only update rendered_text';
--> statement-breakpoint
COMMENT ON COLUMN document_wechat_geo_summaries.keywords IS
    'AI-generated snapshot; manual edits only update rendered_text';
