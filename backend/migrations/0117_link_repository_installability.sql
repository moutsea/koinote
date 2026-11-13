-- Links were previously marked incompatible without inspecting their Skills.
-- Queue unknown/legacy false results, preserving links already verified usable.
-- Keep retry attempts separate from the last definitive compatibility result.
ALTER TABLE agent_repository_publications ADD COLUMN IF NOT EXISTS koi_installability_attempted_at TIMESTAMPTZ;
UPDATE agent_repository_publications SET koi_installable=NULL,
    koi_installability_checked_at=NULL,koi_installability_attempted_at=NULL,koi_installability_xid=NULL
WHERE github_source->>'linkOnly'='true' AND koi_installable IS DISTINCT FROM true;
