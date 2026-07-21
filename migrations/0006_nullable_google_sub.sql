-- 0006: permitir crear un cliente manualmente desde el panel admin, sin que
-- haya iniciado sesión con Google todavía. google_sub pasa a ser opcional
-- (NULL hasta el primer login real); portal.users.email sigue siendo la
-- clave única real. Ver findOrCreateUser en src/auth.js: si el login por
-- Google no matchea por google_sub pero sí existe una ficha con el mismo
-- email y google_sub NULL, se vincula esa ficha (no se crea una duplicada,
-- que además violaría el unique(email)).
ALTER TABLE portal.users ALTER COLUMN google_sub DROP NOT NULL;
