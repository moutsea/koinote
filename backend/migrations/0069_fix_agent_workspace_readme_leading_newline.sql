CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The human README migration accidentally included the newline immediately
-- after the dollar-quote delimiter in the stored content. Remove that byte
-- and restore metadata to match the bytes returned by the read API.
UPDATE agent_workspace_files
SET content = substring(content FROM 2),
    size_bytes = octet_length(substring(content FROM 2)),
    sha256 = encode(digest(substring(content FROM 2), 'sha256'), 'hex')
WHERE path = 'README.md'
  AND substring(content FROM 1 FOR 1) = decode('0a', 'hex')
  AND size_bytes = octet_length(content) - 1;
