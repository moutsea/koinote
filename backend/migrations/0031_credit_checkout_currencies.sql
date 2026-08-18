ALTER TABLE stripe_credit_checkout_attempts
    ADD COLUMN IF NOT EXISTS currency varchar(3) NOT NULL DEFAULT 'usd'
    CHECK (currency IN ('usd', 'cny', 'eur', 'jpy'));
