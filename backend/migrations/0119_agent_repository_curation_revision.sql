-- Cache results belong to the exact installation-policy snapshot used to check
-- them. A rule edit invalidates mirrors and links, including in-flight checks.
CREATE TABLE agent_repository_curation_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    revision BIGINT NOT NULL
);
INSERT INTO agent_repository_curation_state (revision) VALUES (1);
ALTER TABLE agent_repository_publications
    ADD COLUMN koi_installability_curation_revision BIGINT NOT NULL DEFAULT 0;

CREATE FUNCTION advance_agent_repository_curation_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.repository_id = NEW.repository_id
           AND OLD.packages IS NOT DISTINCT FROM NEW.packages
           AND (NEW.packages IS NULL OR OLD.required_capabilities = NEW.required_capabilities) THEN
            RETURN NULL;
        END IF;
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW.packages IS NULL THEN RETURN NULL; END IF;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.packages IS NULL THEN RETURN NULL; END IF;
    END IF;
    UPDATE agent_repository_curation_state SET revision = revision + 1;
    RETURN NULL;
END;
$$;
CREATE TRIGGER agent_repository_curation_revision
AFTER INSERT OR UPDATE OR DELETE ON agent_repository_curation
FOR EACH ROW EXECUTE FUNCTION advance_agent_repository_curation_revision();
