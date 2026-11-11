-- Immutable Skill installation storage. No account mode or runtime changes.
-- Installation APIs, task references and quota integration are deployed in later
-- migrations before enabling writes to these tables.

CREATE TABLE koi_skill_installations (
    id uuid PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Normalized upstream identity. Folder installs use their installation UUID;
    -- older content-derived keys remain valid but are not used for matching.
    source_key text NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('github','folder','hub','migration')),
    source jsonb NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    enabled boolean NOT NULL DEFAULT true,
    revision bigint NOT NULL DEFAULT 1,
    current_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE UNIQUE INDEX koi_skill_installations_source ON koi_skill_installations(user_id,source_key)
    WHERE deleted_at IS NULL;
CREATE INDEX koi_skill_installations_user ON koi_skill_installations(user_id,updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE koi_skill_versions (
    id uuid PRIMARY KEY,
    installation_id uuid NOT NULL REFERENCES koi_skill_installations(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    entry_path text NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    -- Raw frontmatter bytes decoded from SKILL.md, including unknown extensions.
    raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata_format text NOT NULL DEFAULT 'agent-skills' CHECK (metadata_format IN ('agent-skills','plain-markdown')),
    file_count integer NOT NULL CHECK (file_count BETWEEN 1 AND 32),
    size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 524288),
    source_fixed jsonb NOT NULL DEFAULT '{}'::jsonb,
    license text NOT NULL DEFAULT '',
    compatibility jsonb NOT NULL,
    rules_version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (installation_id,content_sha256)
);
CREATE INDEX koi_skill_versions_user ON koi_skill_versions(user_id,created_at DESC);

ALTER TABLE koi_skill_installations ADD CONSTRAINT koi_skill_installation_version
    FOREIGN KEY (current_version_id) REFERENCES koi_skill_versions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE koi_skill_version_files (
    version_id uuid NOT NULL REFERENCES koi_skill_versions(id) ON DELETE CASCADE,
    -- Stable ordinal exposed to clients instead of an internal object key.
    position integer NOT NULL CHECK (position BETWEEN 1 AND 32),
    path text NOT NULL,
    mime_type text NOT NULL DEFAULT 'application/octet-stream',
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 131072),
    content bytea,
    r2_object_key text,
    PRIMARY KEY (version_id,position),
    UNIQUE (version_id,path),
    CONSTRAINT koi_skill_file_storage CHECK (
        (content IS NOT NULL AND r2_object_key IS NULL) OR
        (content IS NULL AND r2_object_key IS NOT NULL)
    ),
    CONSTRAINT koi_skill_file_object_fk FOREIGN KEY (r2_object_key,sha256,size_bytes)
        REFERENCES agent_repository_objects(object_key,sha256,size_bytes)
);
CREATE INDEX koi_skill_version_files_object ON koi_skill_version_files(r2_object_key)
    WHERE r2_object_key IS NOT NULL;

-- A database backup restores version files through their object references, so
-- keep those objects for the same window as repository objects.
CREATE FUNCTION retain_koi_skill_object() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
    IF TG_OP <> 'DELETE' AND NEW.r2_object_key IS NOT NULL THEN
        UPDATE agent_repository_objects SET committed=true,
            delete_after=GREATEST(delete_after, now()+interval '401 days') WHERE object_key=NEW.r2_object_key;
    END IF;
    IF TG_OP <> 'INSERT' AND OLD.r2_object_key IS NOT NULL THEN
        UPDATE agent_repository_objects SET committed=true,
            delete_after=GREATEST(delete_after, now()+interval '401 days') WHERE object_key=OLD.r2_object_key;
    END IF;
    RETURN NULL;
END;
$function$;
CREATE TRIGGER retain_koi_skill_object AFTER INSERT OR DELETE OR UPDATE OF r2_object_key
    ON koi_skill_version_files FOR EACH ROW EXECUTE FUNCTION retain_koi_skill_object();
