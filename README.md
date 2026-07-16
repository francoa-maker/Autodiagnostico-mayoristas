# Autodiagnóstico — Portal de distribuidores

Portal privado para distribuidores mayoristas: login con Google + aprobación manual, catálogo con precios
por 4 tramos (PVP/1u/4u/8u), carrito de solicitud de cotización, y panel administrador. El stock exacto
vive en una tabla de Supabase ya existente (alimentada por una integración con Ninox que este repo **no**
toca ni reimplementa) — el portal solo la lee, por SKU normalizado, y nunca expone la cantidad exacta a
clientes.

Ver `C:\Users\franc\.claude\plans\quirky-sparking-crayon.md` para el plan de implementación completo y el
estado de cada paso.

## Stack

Node.js + Express, `pg` (sin ORM), HTML/CSS/JS plano sin build step (`public/`). Postgres de Supabase,
schema propio `portal.*`.

## Arrancar en local

```bash
npm install
cp .env.example .env   # completar DATABASE_URL, GOOGLE_CLIENT_ID/SECRET, etc.
npm run db:migrate      # aplica migrations/*.sql
npm start
```

Sin `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, el botón de Google redirige con
`?error=google_not_configured`. Para probar el flujo completo sin credenciales reales de Google, con
`NODE_ENV` distinto de `production`:

```bash
curl -X POST http://localhost:3000/auth/dev-login -H "content-type: application/json" \
  -d '{"email":"vos@ejemplo.com","role":"admin","status":"approved"}' -c cookies.txt
curl -b cookies.txt http://localhost:3000/api/me
```

## Importación inicial de precios legacy

```bash
LEGACY_CATALOG_SOURCE_URL=... npm run capture:legacy      # o LEGACY_SHEET_ID, o --input <archivo>
npm run import:legacy:dry-run -- --snapshot snapshots/<archivo>.json
npm run import:legacy:apply -- --snapshot snapshots/<archivo>.json
```

Es transaccional e idempotente por hash del snapshot — reaplicar el mismo archivo no duplica nada.

## Tests

```bash
npm test          # vitest - funciones puras, sin DB (26 tests)
npm run test:e2e  # Playwright - necesita Postgres local + `npx playwright install` (ver tests/e2e/README.md)
```

## Antes de producción

1. `scripts/inspect_supabase_stock.js` contra el Supabase real para confirmar `STOCK_TABLE`/`STOCK_COLUMN_*`.
2. Validar `parsePriceCell`/el mapeo de columnas contra filas reales del Sheet legacy (ver el comentario
   "inferido, no validado" en `src/imports/legacyCatalogImporter.js`).
3. Cliente OAuth de Google nuevo (pantalla de consentimiento externa, no restringida por dominio).
4. Crear el servicio en Render desde `render.yaml` y cargar las variables de entorno reales.
