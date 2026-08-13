-- Authentication keeps using the irreversible SHA-256 hash. This encrypted copy exists
-- only so an authenticated account owner can explicitly reveal a token again.
-- Existing tokens remain valid but cannot be recovered because their plaintext was never stored.
ALTER TABLE mcp_tokens
    ADD COLUMN IF NOT EXISTS token_ciphertext bytea;
