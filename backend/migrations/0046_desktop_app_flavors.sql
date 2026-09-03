-- Keep the production and local desktop clients isolated. Existing pending
-- OAuth rows are browser flows, so they use the empty scheme.
ALTER TABLE x_oauth2_pending
    ADD COLUMN IF NOT EXISTS desktop_scheme text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE x_oauth2_pending
    DROP CONSTRAINT IF EXISTS x_oauth2_pending_desktop_scheme_check;
--> statement-breakpoint
ALTER TABLE x_oauth2_pending
    ADD CONSTRAINT x_oauth2_pending_desktop_scheme_check
    CHECK (desktop_scheme IN ('', 'koinote', 'koinote-local'));
