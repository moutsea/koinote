CREATE TABLE IF NOT EXISTS media_platform_settings (
    user_id        integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    wechat_enabled boolean NOT NULL DEFAULT true,
    zhihu_enabled  boolean NOT NULL DEFAULT true,
    x_enabled      boolean NOT NULL DEFAULT true,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custom_media_platforms (
    platform_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                     varchar(80) NOT NULL,
    endpoint_url             text NOT NULL,
    auth_token_ciphertext    bytea,
    auth_token_hint          varchar(32) NOT NULL DEFAULT '',
    enabled                  boolean NOT NULL DEFAULT true,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_media_platforms_user_name_idx
    ON custom_media_platforms (user_id, lower(name));
CREATE INDEX IF NOT EXISTS custom_media_platforms_user_idx
    ON custom_media_platforms (user_id, created_at, platform_id);
