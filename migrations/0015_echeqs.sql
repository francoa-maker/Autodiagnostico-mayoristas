-- 0015 (Tanda 4): eCheqs con flujo de dos fases (aceptación bancaria !=
-- acreditación del dinero). Un eCheq es un payment con method='echeq' + esta
-- fila de detalle. Recién al ACREDITAR se genera el crédito contable.
-- También agrega documents.invoice_id / documents.echeq_id para vincular
-- comprobantes. Aditivo e idempotente. Revertir: drop table echeq_details +
-- drop columns en documents.
CREATE TABLE IF NOT EXISTS portal.echeq_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES portal.payments(id) ON DELETE CASCADE,
  echeq_number text,
  bank_name text,
  issuer_name text,
  issuer_tax_id text,
  issue_date date,
  payment_date date,
  received_at timestamptz,
  accepted_at timestamptz,
  expected_credit_date date,
  actual_credit_date date,
  status text NOT NULL DEFAULT 'received',
  rejection_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_echeq_payment ON portal.echeq_details(payment_id);

ALTER TABLE portal.documents ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES portal.invoices(id) ON DELETE SET NULL;
ALTER TABLE portal.documents ADD COLUMN IF NOT EXISTS echeq_id uuid REFERENCES portal.echeq_details(id) ON DELETE SET NULL;
