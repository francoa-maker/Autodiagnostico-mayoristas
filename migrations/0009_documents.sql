-- 0009: metadatos de documentos. El ARCHIVO nunca se guarda en Postgres: acá
-- van solo los metadatos y la referencia al archivo en el proveedor de storage
-- (Google Drive por ahora). Aditivo e idempotente.
-- Revertir: drop table portal.documents;
--
-- order_id referencia la cotización/pedido (quote_requests). payment_id y
-- shipment_id quedan como columnas nullable SIN FK: todavía no existen tablas
-- de pagos/envíos; se conectarán en una etapa futura.
CREATE TABLE IF NOT EXISTS portal.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  order_id uuid REFERENCES portal.quote_requests(id) ON DELETE SET NULL,
  payment_id uuid,
  shipment_id uuid,
  document_type text NOT NULL,
  google_drive_file_id text,
  google_drive_folder_id text,
  original_filename text NOT NULL,
  stored_filename text NOT NULL,
  mime_type text NOT NULL,
  file_size bigint NOT NULL DEFAULT 0,
  visible_to_customer boolean NOT NULL DEFAULT false,
  uploaded_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_documents_order ON portal.documents(order_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_portal_documents_client ON portal.documents(client_id) WHERE deleted_at IS NULL;
