# Autodiagnóstico — Portal de distribuidores

Portal privado para distribuidores mayoristas: login con Google + aprobación manual, catálogo con precios
por 4 tramos (PVP/1u/4u/8u), carrito de solicitud de cotización, y panel administrador.

**Dos bases de datos separadas, a propósito:**

- **Propia (`DATABASE_URL`, Postgres en Render)** — todo lo que el portal es dueño de administrar: schema
  `portal.*` (productos, precios 1u/4u/8u, usuarios, cotizaciones, auditoría).
- **Supabase existente (`STOCK_DATABASE_URL`, solo lectura)** — alimentada por una integración con Ninox
  que este repo **no** toca ni reimplementa. El portal solo lee de ahí, por SKU normalizado, dos cosas:
  stock (nunca se expone la cantidad exacta a clientes, solo un estado cualitativo) y **PVP** (ese sí es
  visible al cliente, se lee en vivo para todos los productos, y no se edita desde el panel — a diferencia
  de 1u/4u/8u, que sí son propios del portal después de la importación inicial).

Como son bases distintas, `src/stock/stockRepository.js` no puede hacer un `JOIN` SQL directo — trae
`portal.products` de una conexión y el stock/PVP de la otra, y los combina en JS por SKU normalizado.

Ver `C:\Users\franc\.claude\plans\quirky-sparking-crayon.md` para el plan de implementación completo y el
estado de cada paso.

## Stack

Node.js + Express, `pg` (sin ORM), HTML/CSS/JS plano sin build step (`public/`).

## Arrancar en local

```bash
npm install
cp .env.example .env   # completar DATABASE_URL, STOCK_DATABASE_URL, GOOGLE_CLIENT_ID/SECRET, etc.
npm run db:migrate      # aplica migrations/*.sql SOLO contra DATABASE_URL (la base propia)
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

1. `scripts/inspect_supabase_stock.js` contra el Supabase real (usa `STOCK_DATABASE_URL`, no `DATABASE_URL`)
   para confirmar `STOCK_TABLE`/`STOCK_COLUMN_SKU`/`STOCK_COLUMN_QTY`/`STOCK_COLUMN_UPDATED_AT`/`STOCK_COLUMN_PVP`.
2. Validar `parsePriceCell`/el mapeo de columnas contra filas reales del Sheet legacy (ver el comentario
   "inferido, no validado" en `src/imports/legacyCatalogImporter.js`). Nota: el PVP que trae el importador
   del Sheet es solo referencia para el reporte de dry-run — nunca se guarda; el PVP real siempre sale de
   Supabase en vivo.
3. Cliente OAuth de Google nuevo (pantalla de consentimiento externa, no restringida por dominio).
4. Crear el servicio + base propia en Render desde `render.yaml` (Blueprint) y cargar `STOCK_DATABASE_URL`
   y el resto de las variables reales.
