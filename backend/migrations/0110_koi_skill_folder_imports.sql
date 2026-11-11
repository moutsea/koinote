-- Only folder preview storage. Existing Skill tables and account modes stay intact.
CREATE TABLE koi_skill_imports (
    id uuid PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    input_hash text NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('github','folder','hub','migration')),
    source jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','analyzing','ready','committed','failed','cancelled','expired')),
    revision bigint NOT NULL DEFAULT 1,
    declared_paths text[] NOT NULL DEFAULT '{}',
    candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    error_code text NOT NULL DEFAULT '',
    result jsonb,
    expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id,request_id)
);
CREATE INDEX koi_skill_imports_expiry ON koi_skill_imports(expires_at)
    WHERE status IN ('pending','analyzing','ready','failed');

CREATE TABLE koi_skill_import_files (
    import_id uuid NOT NULL REFERENCES koi_skill_imports(id) ON DELETE CASCADE,
    path text NOT NULL,
    sha256 text,
    size_bytes bigint,
    content bytea,
    -- Rejected uploads retain only their path and reason, never their bytes.
    error_code text NOT NULL DEFAULT ''
        CHECK (error_code IN ('','file_too_large','sensitive_data_detected')),
    PRIMARY KEY (import_id,path),
    CHECK (
        (error_code='' AND sha256 IS NOT NULL AND sha256 ~ '^[0-9a-f]{64}$'
         AND size_bytes IS NOT NULL AND size_bytes BETWEEN 0 AND 131072
         AND content IS NOT NULL AND octet_length(content)=size_bytes)
        OR (error_code<>'' AND sha256 IS NULL AND size_bytes IS NULL AND content IS NULL)
    )
);
