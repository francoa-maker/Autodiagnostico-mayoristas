-- 0008: orden manual de las líneas dentro de una cotización. Aditivo e
-- idempotente. Las filas existentes quedan en NULL y se ordenan por created_at
-- (su orden actual); las nuevas y las reordenadas reciben un valor explícito.
-- Revertir: alter table portal.quote_items drop column sort_order;
ALTER TABLE portal.quote_items
  ADD COLUMN IF NOT EXISTS sort_order integer;
