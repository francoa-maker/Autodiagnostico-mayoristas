-- 0019_quote_payment_terms_and_line_types.sql
-- Aditivo e idempotente (ADD COLUMN IF NOT EXISTS). No borra ni altera datos.
--
-- 1) Términos de pago + vencimiento en la cotización (guía §11.1): se muestran
--    en la Pre-compra/Compra. Ambos opcionales.
-- 2) Tipo de línea en los ítems: 'product' (default, lo que hay hoy), 'section'
--    (encabezado de agrupación) o 'note' (aclaración). Las líneas section/note
--    NO cuentan en los totales ni van a Logística; guardan su texto en
--    product_name_snapshot. Mientras no se creen filas section/note, todo sigue
--    igual (todas las filas existentes quedan como 'product').

ALTER TABLE portal.quote_requests
  ADD COLUMN IF NOT EXISTS payment_terms text,
  ADD COLUMN IF NOT EXISTS due_date date;

ALTER TABLE portal.quote_items
  ADD COLUMN IF NOT EXISTS line_type text NOT NULL DEFAULT 'product';
