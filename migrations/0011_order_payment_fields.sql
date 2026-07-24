-- 0011 (Tanda 1): condición de pago y estado de pago a nivel pedido
-- (quote_requests). Aditivo e idempotente. La condición se define por operación
-- (default del cliente en users.default_payment_term, agregado en 0010); el
-- snapshot guarda lo acordado para que cambios futuros no alteren pedidos viejos.
-- payment_state es una cache derivada de facturas/pagos (se recalcula; nunca se
-- edita a mano). Revertir: ALTER TABLE ... DROP COLUMN de cada una.
ALTER TABLE portal.quote_requests
  ADD COLUMN IF NOT EXISTS payment_condition text,
  ADD COLUMN IF NOT EXISTS payment_condition_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS payment_state text NOT NULL DEFAULT 'unpaid';
