-- 0022_payments_payer.sql
-- Revertir: ALTER TABLE portal.payments DROP COLUMN payer_name,
-- DROP COLUMN payer_tax_id, DROP COLUMN payer_bank_ref.
ALTER TABLE portal.payments
  ADD COLUMN IF NOT EXISTS payer_name text,
  ADD COLUMN IF NOT EXISTS payer_tax_id text,
  ADD COLUMN IF NOT EXISTS payer_bank_ref text;
