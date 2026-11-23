-- A committed retirement marker precedes physical R2 deletion. All durable
-- image-reference writers serialize with the collector on the existing user lock.
CREATE FUNCTION protect_retired_image_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    value jsonb := to_jsonb(NEW);
    owner_id integer;
BEGIN
    owner_id := (value->>'user_id')::integer;
    IF owner_id IS NULL AND value ? 'task_id' THEN
        SELECT user_id INTO owner_id FROM writing_agent_tasks WHERE id=(value->>'task_id')::uuid;
    END IF;
    IF owner_id IS NULL AND value ? 'document_id' THEN
        SELECT user_id INTO owner_id FROM documents WHERE id=(value->>'document_id')::integer;
    END IF;
    IF owner_id IS NULL THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(owner_id::bigint);
    IF EXISTS (
        SELECT 1 FROM regexp_matches(value::text,
            'u/[A-Za-z0-9_-]{1,128}/[0-9a-f]{8,64}\.(?:png|jpg|gif|webp)', 'g') AS image_match
        JOIN pending_image_deletions p ON p.object_key=image_match[1]
        WHERE p.user_id=owner_id AND p.upload_aborted_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE='KNI01', MESSAGE='image_unavailable';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER documents_image_references BEFORE INSERT OR UPDATE OF content,cover_image_source ON documents
    FOR EACH ROW EXECUTE FUNCTION protect_retired_image_references();
CREATE TRIGGER versions_image_references BEFORE INSERT OR UPDATE OF content ON document_versions
    FOR EACH ROW EXECUTE FUNCTION protect_retired_image_references();
CREATE TRIGGER tasks_image_references BEFORE INSERT OR UPDATE OF source,proposal,message,result ON writing_agent_tasks
    FOR EACH ROW EXECUTE FUNCTION protect_retired_image_references();
CREATE TRIGGER reads_image_references BEFORE INSERT OR UPDATE OF snapshot ON agent_document_reads
    FOR EACH ROW EXECUTE FUNCTION protect_retired_image_references();
CREATE TRIGGER operations_image_references BEFORE INSERT OR UPDATE OF input,before_state ON agent_operations
    FOR EACH ROW EXECUTE FUNCTION protect_retired_image_references();
CREATE TRIGGER publications_image_references BEFORE INSERT OR UPDATE OF snapshot ON agent_publications
    FOR EACH ROW EXECUTE FUNCTION protect_retired_image_references();
