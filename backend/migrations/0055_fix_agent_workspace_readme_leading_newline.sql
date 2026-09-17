-- The human README migration accidentally included the newline immediately
-- after the dollar-quote delimiter in the stored content. Remove that byte
-- and restore metadata to match the bytes returned by the read API.
UPDATE agent_workspace_files
SET content = substring(content FROM 2),
    size_bytes = size_bytes - 1,
    sha256 = CASE sha256
        WHEN '8a1139e8d3b96bf45312f2ef42c4be8a9a425c964129178a19b26898a051d9b5' THEN '8a1139e8d3b96bf45312f2ef42c4be8a9a425c964129178a19b26898a051d9b5'
        WHEN '98ff175ed06f96531a67e84e1b974466ec5d85f57bc146234858370496f7ebe4' THEN '98ff175ed06f96531a67e84e1b974466ec5d85f57bc146234858370496f7ebe4'
        WHEN 'efd1b9dc6b13157bcbbbe266c1b7a731df32bc8421941d2814e89d0b0ec5ee33' THEN 'efd1b9dc6b13157bcbbbe266c1b7a731df32bc8421941d2814e89d0b0ec5ee33'
        WHEN 'da4e094c2ed884c88b5d151fe3bbdffa3deb3cfdbaa2e41c01cedf7997a06f5f' THEN 'da4e094c2ed884c88b5d151fe3bbdffa3deb3cfdbaa2e41c01cedf7997a06f5f'
        ELSE sha256
    END
WHERE path = 'README.md'
  AND get_byte(content, 0) = 10
  AND size_bytes = octet_length(content) - 1;
