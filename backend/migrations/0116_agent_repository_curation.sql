-- Curation is operational data, restored with the database rather than shipped
-- as a repository catalog. NULL packages leaves normal validation in place;
-- an empty object records an explicit review that allows no packages.
CREATE TABLE IF NOT EXISTS agent_repository_curation (
    repository_id BIGINT PRIMARY KEY CHECK (repository_id > 0),
    repository_url TEXT NOT NULL,
    category TEXT CHECK (category IN ('development','writing','research','design','product','media','agents','other')),
    packages JSONB CHECK (jsonb_typeof(packages) = 'object'),
    required_capabilities JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(required_capabilities) = 'object')
);
