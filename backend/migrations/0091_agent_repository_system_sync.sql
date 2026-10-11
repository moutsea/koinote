ALTER TABLE agent_repository_system_events
    DROP CONSTRAINT agent_repository_system_events_action_check,
    ADD CONSTRAINT agent_repository_system_events_action_check
        CHECK (action IN ('adopt','import','publish','unpublish','sync'));
