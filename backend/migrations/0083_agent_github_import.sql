-- Provenance is populated only by the GitHub importer and inherited by Fork.
-- Normal repository edits, restores and publication requests cannot overwrite it.
ALTER TABLE agent_workspaces
    ADD COLUMN github_source JSONB CHECK (github_source IS NULL OR jsonb_typeof(github_source) = 'object'),
    ADD COLUMN github_import_request_id UUID,
    ADD COLUMN github_import_fingerprint TEXT;
CREATE UNIQUE INDEX agent_workspace_github_import_request_idx
    ON agent_workspaces(user_id, github_import_request_id) WHERE github_import_request_id IS NOT NULL;

ALTER TABLE agent_repository_publications
    ADD COLUMN github_source JSONB CHECK (github_source IS NULL OR jsonb_typeof(github_source) = 'object');

CREATE TABLE agent_github_credentials (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_ciphertext BYTEA NOT NULL,
    token_hint TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
