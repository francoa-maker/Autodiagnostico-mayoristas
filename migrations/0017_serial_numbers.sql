-- 0017 (Tanda 8): números de serie por unidad para Logística/Depósito. El
-- serial NO es obligatorio (algunos productos no tienen). serial_count <=
-- prepared_quantity <= confirmed_quantity(=quote_items.quantity). Historial: no
-- se borra físicamente; se marca removed/returned/replaced. Aditivo e
-- idempotente. Revertir: drop table + drop columns.
ALTER TABLE portal.quote_items ADD COLUMN IF NOT EXISTS prepared_quantity integer NOT NULL DEFAULT 0;
-- Ayuda visual futura (none/optional/required). Nullable => se trata como optional.
ALTER TABLE portal.products ADD COLUMN IF NOT EXISTS serial_tracking_mode text;

CREATE TABLE IF NOT EXISTS portal.order_item_serial_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES portal.quote_requests(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES portal.quote_items(id) ON DELETE SET NULL,
  product_id uuid REFERENCES portal.products(id) ON DELETE SET NULL,
  serial_number text NOT NULL,
  status text NOT NULL DEFAULT 'assigned',
  notes text,
  visible_to_customer boolean NOT NULL DEFAULT false,
  registered_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removal_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (length(btrim(serial_number)) > 0)
);
-- Un mismo serial no puede estar 'assigned' en dos lugares a la vez (evita
-- duplicado dentro del pedido y colisión entre pedidos activos). El historial
-- (removed/returned/replaced) puede repetir el número.
CREATE UNIQUE INDEX IF NOT EXISTS uq_serial_assigned ON portal.order_item_serial_numbers (serial_number) WHERE status = 'assigned';
CREATE INDEX IF NOT EXISTS idx_serial_order ON portal.order_item_serial_numbers(order_id);
CREATE INDEX IF NOT EXISTS idx_serial_item ON portal.order_item_serial_numbers(order_item_id);
