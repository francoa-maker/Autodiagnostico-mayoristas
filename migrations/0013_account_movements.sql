-- 0013 (Tanda 2): libro mayor de cuenta corriente. APPEND-ONLY: el saldo se
-- calcula sumando movimientos activos, nunca se edita un saldo guardado. Para
-- corregir se inserta un movimiento inverso (reversed_movement_id) y el original
-- pasa a status='reversed'. Aditivo e idempotente. Revertir: drop table.
-- Débito ↑ deuda del cliente; crédito ↓ deuda / genera saldo a favor.
CREATE TABLE IF NOT EXISTS portal.account_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
  order_id uuid REFERENCES portal.quote_requests(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES portal.invoices(id) ON DELETE SET NULL,
  payment_id uuid,  -- FK a portal.payments recién en Tanda 3 (todavía no existe)
  movement_type text NOT NULL,
  description text,
  debit_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
  credit_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'ARS',
  effective_date date NOT NULL DEFAULT current_date,
  due_date date,
  status text NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  reversed_movement_id uuid REFERENCES portal.account_movements(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_movements_client ON portal.account_movements(client_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_portal_movements_order ON portal.account_movements(order_id);
CREATE INDEX IF NOT EXISTS idx_portal_movements_invoice ON portal.account_movements(invoice_id);
