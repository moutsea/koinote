-- NULL denotes the existing general-purpose Koi conversation.
ALTER TABLE agent_sessions ADD COLUMN write_document_id text;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_article_review_permission
    CHECK (write_document_id IS NULL OR permission = 'review');
CREATE UNIQUE INDEX agent_article_session ON agent_sessions(user_id, write_document_id)
    WHERE write_document_id IS NOT NULL AND deleted_at IS NULL;
