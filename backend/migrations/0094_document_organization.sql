ALTER TABLE documents
    ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
    ADD COLUMN organized_at timestamptz,
    ADD COLUMN organization_version bigint NOT NULL DEFAULT 0;

-- Detect changes to classification, including moving away and back. Ordering
-- and trash state are independent: undo preserves them instead of blocking.
CREATE FUNCTION bump_document_organization_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.folder_id, NEW.tags, NEW.organized_at)
        IS DISTINCT FROM ROW(OLD.folder_id, OLD.tags, OLD.organized_at) THEN
        NEW.organization_version := OLD.organization_version + 1;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER document_organization_version BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION bump_document_organization_version();

CREATE TABLE document_organizations (
    organization_id uuid PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('running', 'ready', 'applied', 'undone', 'failed')),
    data jsonb NOT NULL,
    reservation_id text NOT NULL DEFAULT '',
    credits_charged bigint NOT NULL DEFAULT 0,
    error_code text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_organizations_running ON document_organizations(user_id) WHERE status = 'running';
CREATE INDEX document_organizations_history ON document_organizations(user_id, created_at DESC);
CREATE INDEX document_organizations_last_mutation ON document_organizations(user_id, updated_at DESC, organization_id DESC)
    WHERE status IN ('applied', 'undone');
