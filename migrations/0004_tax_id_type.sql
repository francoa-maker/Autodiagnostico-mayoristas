-- 0004: tipo de documento fiscal del cliente (CUIT/CUIL/DNI), que depende de
-- su condición de IVA. El número sigue guardándose en users.tax_cuit; este
-- campo dice cómo interpretarlo/validarlo/mostrarlo. Aditivo e idempotente.
ALTER TABLE portal.users
  ADD COLUMN IF NOT EXISTS tax_id_type text NOT NULL DEFAULT 'CUIT';
