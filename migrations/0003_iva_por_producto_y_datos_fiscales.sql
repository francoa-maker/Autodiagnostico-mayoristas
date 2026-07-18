-- 0003: IVA por producto (no ya por cotización) + datos fiscales y dirección
-- de entrega del cliente (formato Andreani). Aditivo e idempotente.

-- Alícuota de IVA por producto (default 10,5%). El item de cotización congela
-- su propia alícuota al momento de cotizar, igual que congela el precio.
ALTER TABLE portal.products
  ADD COLUMN IF NOT EXISTS iva_rate numeric(5,2) NOT NULL DEFAULT 10.5;

ALTER TABLE portal.quote_items
  ADD COLUMN IF NOT EXISTS iva_rate numeric(5,2);

-- Datos fiscales del cliente (se completan en "Mis datos", requeridos antes
-- del primer pedido). El CUIT se valida sólo por formato acá; AFIP lo verá
-- facturación más adelante.
ALTER TABLE portal.users
  ADD COLUMN IF NOT EXISTS tax_cuit text,
  ADD COLUMN IF NOT EXISTS tax_condition text,
  -- Dirección de entrega, campo por campo tal como la pide Andreani, para
  -- copiar/pegar hoy y mapear a su API el día de mañana.
  ADD COLUMN IF NOT EXISTS ship_street text,
  ADD COLUMN IF NOT EXISTS ship_number text,
  ADD COLUMN IF NOT EXISTS ship_floor text,
  ADD COLUMN IF NOT EXISTS ship_apartment text,
  ADD COLUMN IF NOT EXISTS ship_postal_code text,
  ADD COLUMN IF NOT EXISTS ship_city text,
  ADD COLUMN IF NOT EXISTS ship_province text,
  ADD COLUMN IF NOT EXISTS ship_phone text,
  ADD COLUMN IF NOT EXISTS ship_notes text;
