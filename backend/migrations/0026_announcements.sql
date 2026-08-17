CREATE TABLE IF NOT EXISTS announcements (
    id             bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    kind           varchar(16) NOT NULL CHECK (kind IN ('release', 'manual')),
    version        varchar(32),
    created_by     integer REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (kind = 'release' AND version IS NOT NULL AND btrim(version) <> '') OR
        (kind = 'manual' AND version IS NULL)
    ),
    UNIQUE (version)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS announcements_published_idx
    ON announcements (published_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS announcement_translations (
    announcement_id bigint NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    locale          varchar(2) NOT NULL CHECK (locale IN ('en', 'zh', 'fr', 'ja')),
    title           varchar(160) NOT NULL CHECK (btrim(title) <> ''),
    summary         varchar(600) NOT NULL CHECK (btrim(summary) <> ''),
    highlights      text[] NOT NULL CHECK (
        cardinality(highlights) BETWEEN 1 AND 8
    ),
    PRIMARY KEY (announcement_id, locale)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS announcement_reads (
    user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    announcement_id bigint NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    read_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, announcement_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS announcement_reads_announcement_idx
    ON announcement_reads (announcement_id, user_id);
