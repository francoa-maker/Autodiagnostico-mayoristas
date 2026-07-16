# Migraciones

## Regla de oro

El Supabase de este proyecto es **producción**. Ninguna migración se aplica
ahí sin correr antes contra una base de staging/local y sin autorización
explícita para el paso productivo.

## Orden expand/contract

1. Crear types/schema/tablas `portal.*` (este archivo `0001_portal_schema.sql`).
2. Desplegar código compatible sin habilitar usuarios nuevos.
3. Capturar snapshot del catálogo legacy (`npm run capture:legacy`).
4. Dry-run del importador (`npm run import:legacy:dry-run`).
5. Verificar el reporte de paridad de precios.
6. Aplicar el importador (`npm run import:legacy:apply`) — una sola vez, es idempotente por hash.
7. Habilitar el piloto de usuarios aprobados.
8. Desplegar a producción.

## Cómo correr localmente

```bash
DATABASE_URL=postgres://... npm run db:migrate
```

`scripts/run_migrations.js` aplica los archivos de `migrations/*.sql` en
orden y dentro de una transacción cada uno. No hay `db push` automático a
producción: eso requiere autorización explícita y se hace manualmente.

## No tocar

Ninguna migración de este directorio debe crear triggers, constraints, FKs
ni columnas nuevas sobre la tabla existente que resuelve el stock. El
`portal` es un schema aparte, sin relaciones de base de datos hacia esa
tabla — la relación es una consulta de aplicación (`LEFT JOIN` por SKU
normalizado en `src/stock/stockRepository.js`), no una FK.
