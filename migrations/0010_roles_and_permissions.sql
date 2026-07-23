-- 0010: fundación de roles ampliados + permisos granulares (Tanda 0 del módulo
-- financiero). ADITIVO e idempotente. Agrega valores al enum portal.user_role y
-- dos columnas a users. La MIGRACIÓN DE DATOS (mapear roles legacy admin/customer
-- a los nuevos) se hace por separado (scripts/backfill_roles.js), porque un valor
-- de enum recién agregado no puede usarse en la MISMA transacción que lo crea.
-- Revertir: no se pueden quitar valores de un enum; las columnas se dropean con
-- ALTER TABLE portal.users DROP COLUMN extra_permissions, DROP COLUMN default_payment_term.
--
-- Compatibilidad: los valores legacy 'admin' y 'customer' se conservan en el enum
-- y el código los normaliza (admin->superadmin, customer->client) en src/permissions.js,
-- así nada se rompe aunque los datos todavía no estén migrados.

ALTER TYPE portal.user_role ADD VALUE IF NOT EXISTS 'superadmin';
ALTER TYPE portal.user_role ADD VALUE IF NOT EXISTS 'sales_billing';
ALTER TYPE portal.user_role ADD VALUE IF NOT EXISTS 'administration';
ALTER TYPE portal.user_role ADD VALUE IF NOT EXISTS 'logistics';
ALTER TYPE portal.user_role ADD VALUE IF NOT EXISTS 'client';

ALTER TABLE portal.users ADD COLUMN IF NOT EXISTS extra_permissions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE portal.users ADD COLUMN IF NOT EXISTS default_payment_term text;
