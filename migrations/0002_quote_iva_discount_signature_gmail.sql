-- 0002: IVA discriminado + tipo de descuento + firma del vendedor + envío de
-- proforma por Gmail del vendedor. Todo aditivo e idempotente (ADD COLUMN IF
-- NOT EXISTS), así el runner puede re-aplicarlo sin efecto en cada deploy.

-- Cotización: alícuota de IVA (los precios del listado son IVA incluido, se
-- desglosa a partir de esta tasa), tipo de descuento (nominal o porcentual),
-- y quién la cotizó (firma).
ALTER TABLE portal.quote_requests
  ADD COLUMN IF NOT EXISTS iva_rate numeric(5,2) NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS discount_type text NOT NULL DEFAULT 'nominal',
  ADD COLUMN IF NOT EXISTS quoted_by_user_id uuid REFERENCES portal.users(id) ON DELETE SET NULL;

-- Guard del CHECK de discount_type (no existe ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quote_requests_discount_type_check'
  ) THEN
    ALTER TABLE portal.quote_requests
      ADD CONSTRAINT quote_requests_discount_type_check
      CHECK (discount_type IN ('nominal', 'percent'));
  END IF;
END $$;

-- Usuario vendedor: refresh token de Gmail para poder enviar la proforma
-- "desde su casilla" vía Gmail API (autorización incremental, ver
-- /auth/google/gmail). Nunca se expone por la API /api/me ni /admin/users.
ALTER TABLE portal.users
  ADD COLUMN IF NOT EXISTS gmail_refresh_token text,
  ADD COLUMN IF NOT EXISTS gmail_connected_at timestamptz,
  ADD COLUMN IF NOT EXISTS gmail_address text;
