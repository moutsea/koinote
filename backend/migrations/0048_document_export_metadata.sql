CREATE TABLE IF NOT EXISTS document_export_metadata (
    document_id       integer PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    wechat_cover_image text NOT NULL DEFAULT '',
    wechat_cover_ratio varchar(8) NOT NULL DEFAULT '2.35:1',
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT document_export_metadata_cover_ratio_check
        CHECK (wechat_cover_ratio IN ('2.35:1', '1:1'))
);
