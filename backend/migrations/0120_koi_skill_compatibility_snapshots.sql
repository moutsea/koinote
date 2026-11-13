-- Freeze existing tasks before current library capabilities are recalculated.
ALTER TABLE agent_task_skill_versions ADD COLUMN compatibility JSONB;
UPDATE agent_task_skill_versions refs SET compatibility=v.compatibility
FROM koi_skill_versions v WHERE v.id=refs.version_id;

-- Keep validation evidence so policy-only edits can be checked locally, without
-- downloading upstream archives or spending users' anonymous GitHub quota.
ALTER TABLE agent_repository_publications ADD COLUMN koi_installability_evidence JSONB;
