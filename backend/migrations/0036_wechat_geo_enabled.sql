ALTER TABLE document_wechat_geo_summaries
    ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false;
