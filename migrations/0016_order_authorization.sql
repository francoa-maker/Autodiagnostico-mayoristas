-- 0016 (Tanda 5): autorización del pedido para Logística. La liberación es
-- MANUAL: Ventas/Administración/Superadmin autoriza (no exige pago total).
-- Logística solo ve "autorizado para preparación", sin datos financieros.
-- Aditivo e idempotente. logistics_status: pending/authorized/preparing/ready/
-- dispatched/delivered (Tanda 8 usa preparing/ready). Revertir: DROP COLUMN.
ALTER TABLE portal.quote_requests
  ADD COLUMN IF NOT EXISTS authorized_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS authorized_at timestamptz,
  ADD COLUMN IF NOT EXISTS authorization_reason text,
  ADD COLUMN IF NOT EXISTS authorization_notes text,
  ADD COLUMN IF NOT EXISTS logistics_status text NOT NULL DEFAULT 'pending';
