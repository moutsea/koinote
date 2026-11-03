-- A full-document replacement must not be generated from an unread tail.
ALTER TABLE agent_document_reads ADD COLUMN read_chars integer NOT NULL DEFAULT 0 CHECK(read_chars >= 0);
