UPDATE agent_workspace_files
SET size_bytes = octet_length(content),
    sha256 = encode(digest(content, 'sha256'), 'hex')
WHERE size_bytes <> octet_length(content)
   OR sha256 <> encode(digest(content, 'sha256'), 'hex');
