-- 0007: favoritos por usuario. Cada cliente puede marcar productos como
-- favoritos para encontrarlos rápido en el catálogo. Aditivo y reversible
-- (drop table user_favorites). Idempotente: seguro de re-correr.
--
-- La restricción unique(user_id, product_id) evita duplicados; ambos FKs
-- borran en cascada, así que si se elimina un usuario o un producto sus
-- favoritos se limpian solos.

CREATE TABLE IF NOT EXISTS portal.user_favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES portal.products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_user_favorites_user ON portal.user_favorites(user_id);
