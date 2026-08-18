-- Editorial suggestions and Markdown layout suggestions share the same review
-- lifecycle, but the UI and audit trail must be able to distinguish them.
ALTER TABLE agent_reviews
    ADD COLUMN IF NOT EXISTS layout_assessment jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE agent_review_suggestions
    ADD COLUMN IF NOT EXISTS suggestion_kind varchar(16) NOT NULL DEFAULT 'content';
--> statement-breakpoint
ALTER TABLE agent_review_suggestions
    ADD COLUMN IF NOT EXISTS operation varchar(32);
--> statement-breakpoint
ALTER TABLE agent_review_suggestions
    DROP CONSTRAINT IF EXISTS agent_review_suggestions_suggestion_kind_check;
--> statement-breakpoint
ALTER TABLE agent_review_suggestions
    ADD CONSTRAINT agent_review_suggestions_suggestion_kind_check
    CHECK (suggestion_kind IN ('content', 'layout'));
--> statement-breakpoint
ALTER TABLE agent_review_suggestions
    DROP CONSTRAINT IF EXISTS agent_review_suggestions_operation_check;
--> statement-breakpoint
ALTER TABLE agent_review_suggestions
    ADD CONSTRAINT agent_review_suggestions_operation_check
    CHECK (
        (suggestion_kind = 'content' AND operation IS NULL)
        OR
        (suggestion_kind = 'layout' AND operation IN (
            'change_block_type', 'split_paragraph', 'convert_to_list',
            'emphasize_block', 'insert_divider'
        ))
    );
