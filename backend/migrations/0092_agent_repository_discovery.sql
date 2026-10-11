-- Keep acquisition history even after an administrator deletes a workspace.
-- This is both the daily budget ledger and the cross-run GitHub identity index.
CREATE TABLE agent_repository_discoveries (
    github_id BIGINT PRIMARY KEY CHECK (github_id > 0),
    repository_url TEXT NOT NULL,
    github_stars INTEGER NOT NULL CHECK (github_stars >= 0),
    code TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    retry_after TIMESTAMPTZ,
    accepted_on DATE,
    workspace_id BIGINT REFERENCES agent_workspaces(id) ON DELETE SET NULL
);
CREATE INDEX agent_repository_discoveries_day_idx
    ON agent_repository_discoveries(accepted_on) WHERE accepted_on IS NOT NULL;
CREATE INDEX agent_workspace_system_github_url_idx
    ON agent_workspaces(lower(github_source->>'repositoryUrl')) WHERE is_system;
