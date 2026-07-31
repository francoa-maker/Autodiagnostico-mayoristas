-- 0018_quote_status_5_estados.sql
-- Simplifica el ciclo de venta de 7 a 5 estados (decisión del usuario, guía §11.2).
--
--   submitted + reviewing        -> cotizacion   (Cotización / Pre-compra borrador)
--   quoted                       -> enviada      (Cotización enviada / Pre-compra)
--   accepted                     -> orden        (Orden de venta / Compra)
--   (nuevo, lo marca Logística)  -> despachado   (Compra despachada)
--   rejected + expired + cancelled -> cancelado
--
-- 'despachado' NO se setea acá: lo dispara Logística al marcar el pedido como
-- despachado (logistics_status='dispatched'), acoplado desde el código.
--
-- IDEMPOTENTE: run_migrations.js corre TODOS los .sql en cada `db:migrate`, así
-- que este bloque solo actúa cuando el ENUM todavía tiene los valores viejos
-- (chequea que exista la etiqueta 'submitted'). En una segunda corrida es no-op.
-- Corre dentro de la transacción por-archivo del runner.
--
-- ⚠️ PROBAR EN STAGING/LOCAL ANTES DE PRODUCCIÓN. Revertir no es trivial
-- (habría que recrear el ENUM viejo y remapear los datos a mano).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'quote_status'
      AND t.typnamespace = 'portal'::regnamespace
      AND e.enumlabel = 'submitted'
  ) THEN
    -- 1. Quitar el default para poder cambiar el tipo de la columna.
    ALTER TABLE portal.quote_requests ALTER COLUMN status DROP DEFAULT;

    -- 2. Pasar a text para remapear los valores existentes.
    ALTER TABLE portal.quote_requests
      ALTER COLUMN status TYPE text USING status::text;

    -- 3. Remapear los datos al nuevo modelo.
    UPDATE portal.quote_requests SET status = CASE status
      WHEN 'submitted' THEN 'cotizacion'
      WHEN 'reviewing' THEN 'cotizacion'
      WHEN 'quoted'    THEN 'enviada'
      WHEN 'accepted'  THEN 'orden'
      WHEN 'rejected'  THEN 'cancelado'
      WHEN 'expired'   THEN 'cancelado'
      WHEN 'cancelled' THEN 'cancelado'
      ELSE status
    END;

    -- 4. Reemplazar el tipo: renombrar el viejo y crear el nuevo de 5 estados.
    ALTER TYPE portal.quote_status RENAME TO quote_status_old;
    CREATE TYPE portal.quote_status AS ENUM
      ('cotizacion', 'enviada', 'orden', 'despachado', 'cancelado');

    -- 5. Volver la columna al ENUM nuevo.
    ALTER TABLE portal.quote_requests
      ALTER COLUMN status TYPE portal.quote_status USING status::portal.quote_status;

    -- 6. Nuevo default: toda cotización nace en 'cotizacion'.
    ALTER TABLE portal.quote_requests ALTER COLUMN status SET DEFAULT 'cotizacion';

    -- 7. Borrar el tipo viejo (ya nadie lo referencia).
    DROP TYPE portal.quote_status_old;
  END IF;
END $$;
