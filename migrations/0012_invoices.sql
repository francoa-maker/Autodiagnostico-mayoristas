-- 0012 (Tanda 1): facturas + vencimientos (cuotas). Aditivo e idempotente.
-- La factura se carga manualmente (PDF en Drive vía documents.document_id). Aun
-- con un solo vencimiento se crea 1 cuota por el total. paid_amount lo actualiza
-- la aplicación de pagos (Tanda 3). Revertir: drop table invoice_installments;
-- drop table invoices;
CREATE TABLE IF NOT EXISTS portal.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  order_id uuid REFERENCES portal.quote_requests(id) ON DELETE SET NULL,
  invoice_type text NOT NULL DEFAULT 'factura',
  point_of_sale text,
  invoice_number text,
  issue_date date NOT NULL DEFAULT current_date,
  total_amount numeric(18,2) NOT NULL CHECK (total_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'ARS',
  status text NOT NULL DEFAULT 'issued',
  document_id uuid REFERENCES portal.documents(id) ON DELETE SET NULL,
  visible_to_customer boolean NOT NULL DEFAULT false,
  notes text,
  uploaded_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_portal_invoices_order ON portal.invoices(order_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_portal_invoices_client ON portal.invoices(client_id) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS portal.invoice_installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES portal.invoices(id) ON DELETE CASCADE,
  installment_number integer NOT NULL DEFAULT 1,
  due_date date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount >= 0),
  paid_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, installment_number)
);
CREATE INDEX IF NOT EXISTS idx_portal_installments_invoice ON portal.invoice_installments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_portal_installments_due ON portal.invoice_installments(due_date) WHERE status <> 'paid';
