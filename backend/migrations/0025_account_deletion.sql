-- Paid order records may need to survive account deletion for financial,
-- fraud-prevention, and dispute handling. Remove the live account link while
-- preserving the minimal immutable payment record.
ALTER TABLE stripe_payments
    DROP CONSTRAINT IF EXISTS stripe_payments_user_id_fkey;
--> statement-breakpoint
ALTER TABLE stripe_payments
    ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE stripe_payments
    ADD CONSTRAINT stripe_payments_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
