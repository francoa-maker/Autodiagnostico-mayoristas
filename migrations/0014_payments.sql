-- 0014 (Tanda 3): pagos + aplicación a facturas/cuotas. Aditivo e idempotente.
-- Un pago confirmado genera un crédito en el mayor (account_movements). La
-- aplicación (payment_allocations) actualiza invoice_installments.paid_amount.
-- Revertir: drop table payment_allocations; drop table payments;
CREATE TABLE IF NOT EXISTS portal.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
  order_id uuid REFERENCES portal.quote_requests(id) ON DELETE SET NULL,
  payment_method text NOT NULL,   -- cash/bank_transfer/echeq/current_account/customer_credit/other
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'ARS',
  payment_date date,
  accounting_date date,
  status text NOT NULL DEFAULT 'draft',  -- draft/informed/confirmed/pending_accreditation/rejected/reversed
  reference_number text,
  notes text,
  document_id uuid REFERENCES portal.documents(id) ON DELETE SET NULL,
  created_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_payments_client ON portal.payments(client_id);
CREATE INDEX IF NOT EXISTS idx_portal_payments_order ON portal.payments(order_id);

CREATE TABLE IF NOT EXISTS portal.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES portal.payments(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES portal.invoices(id) ON DELETE SET NULL,
  installment_id uuid REFERENCES portal.invoice_installments(id) ON DELETE SET NULL,
  amount_applied numeric(18,2) NOT NULL CHECK (amount_applied > 0),
  created_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_portal_alloc_payment ON portal.payment_allocations(payment_id) WHERE reversed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_portal_alloc_installment ON portal.payment_allocations(installment_id) WHERE reversed_at IS NULL;
