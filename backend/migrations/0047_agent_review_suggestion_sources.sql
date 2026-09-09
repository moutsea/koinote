ALTER TABLE agent_review_suggestions
    ADD COLUMN IF NOT EXISTS source_task varchar(16);
--> statement-breakpoint
ALTER TABLE agent_review_suggestions
    DROP CONSTRAINT IF EXISTS agent_review_suggestions_source_task_check;
--> statement-breakpoint
ALTER TABLE agent_review_suggestions
    ADD CONSTRAINT agent_review_suggestions_source_task_check
    CHECK (source_task IS NULL OR source_task IN ('title', 'proofread', 'structure', 'paragraph'));
