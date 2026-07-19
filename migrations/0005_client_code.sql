-- 0005: código único por cliente (ej. CL-7K2Q9), usado como identificador
-- corto en la marca de agua de la proforma y del catálogo. Aditivo. El backfill
-- de los usuarios existentes y la generación de nuevos códigos se hacen en JS
-- (auth.js + script de backfill); acá sólo se crea la columna y el índice único.
ALTER TABLE portal.users
  ADD COLUMN IF NOT EXISTS client_code text;

CREATE UNIQUE INDEX IF NOT EXISTS users_client_code_key ON portal.users (client_code);
