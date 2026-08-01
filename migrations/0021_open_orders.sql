-- 0021_open_orders.sql
-- Revertir: DROP INDEX portal.idx_quote_requests_open_period; ALTER TABLE portal.quote_requests
-- DROP COLUMN period_month, DROP COLUMN closed_at, DROP COLUMN closed_by,
-- DROP COLUMN accepted_at, DROP COLUMN accepted_by. quoted_unit_price puede volver
-- a NOT NULL sólo después de completar los precios faltantes.
ALTER TABLE portal.quote_requests
  ADD COLUMN IF NOT EXISTS period_month date,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_by uuid REFERENCES portal.users(id) ON DELETE SET NULL;

ALTER TABLE portal.quote_items
  ALTER COLUMN quoted_unit_price DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_requests_open_period
  ON portal.quote_requests(user_id, period_month)
  WHERE status = 'abierto';
