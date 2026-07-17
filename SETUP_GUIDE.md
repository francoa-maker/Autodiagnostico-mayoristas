# Guía de puesta en marcha — Portal Autodiagnóstico

Esta guía cubre todo lo que falta para llevar el repo `Autodiagnostico-mayoristas` de "código en GitHub" a
"portal funcionando en producción con login real, precios reales y stock real". Pensada para seguirse
paso a paso, en orden — cada paso dice exactamente qué click hacer o qué comando correr, y qué resultado
esperar antes de pasar al siguiente.

Si estás usando otro asistente (Codex, etc.) para que te acompañe: pegale esta guía completa y decile que
vaya paso por paso, confirmando el resultado de cada uno antes de seguir. Todos los comandos se corren
desde la raíz de este repo (`autodiagnostico-portal/`), salvo que se indique lo contrario.

## 0. Qué ya está hecho

- Código completo en GitHub: `francoa-maker/Autodiagnostico-mayoristas`, rama `master`.
- 26 tests unitarios pasando (`npm test`).
- Servidor arranca y sirve todas las páginas sin base de datos configurada (para desarrollo/pruebas de humo).

## 1. Arquitectura en una imagen

```text
                    ┌─────────────────────────────┐
Google OAuth ──────▶│  Portal (este repo, Render)  │
                    │  server.js + Express         │
                    └───────────┬─────────┬────────┘
                                │         │
                   DATABASE_URL │         │ STOCK_DATABASE_URL
                    (propia)    ▼         ▼   (Supabase, solo lectura)
                    ┌───────────────┐   ┌──────────────────────────┐
                    │ Postgres      │   │ Supabase existente        │
                    │ portal.*      │   │ (alimentado por Ninox,    │
                    │ productos,    │   │  ajeno a este repo)       │
                    │ precios 1u/   │   │ stock + PVP, por SKU,     │
                    │ 4u/8u,        │   │ SOLO LECTURA              │
                    │ usuarios,     │   └──────────────────────────┘
                    │ cotizaciones, │
                    │ auditoría     │
                    └───────────────┘
```

Dos bases separadas, dos variables de entorno separadas. `DATABASE_URL` es la que este repo migra y
escribe. `STOCK_DATABASE_URL` nunca se migra ni se escribe — solo se lee.

## 2. Prerrequisitos

- [ ] Cuenta de Render con acceso para crear servicios.
- [ ] Acceso de lectura al proyecto Supabase existente (`hazlhbyogrtxscbtfqrz` o el que corresponda) —
      idealmente una cadena de conexión con un rol de solo lectura, no el rol de servicio completo.
- [ ] Cuenta de Google Cloud (puede ser la misma que ya usan, o una nueva) para crear el cliente OAuth.
- [ ] Node 20+ instalado localmente si vas a correr los scripts de importación/inspección desde tu máquina
      en vez de desde Render.

## 3. Crear el servicio en Render (Blueprint)

1. Render dashboard → **New +** → **Blueprint**.
2. Conectá el repo `francoa-maker/Autodiagnostico-mayoristas`, rama `master`.
3. Render lee `render.yaml` y va a proponer:
   - un **Web Service** llamado `autodiagnostico-portal` (Node, `npm install` / `npm start`, health check `/health`);
   - una **base Postgres** llamada `autodiagnostico-portal-db` (la base propia del portal).
4. Te va a pedir valores para las variables marcadas `sync: false`. En este paso, dejá en blanco las que
   todavía no tenemos (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STOCK_DATABASE_URL`,
   `STOCK_TABLE`/`STOCK_COLUMN_*`, `LEGACY_CATALOG_SOURCE_URL`) — el servidor arranca igual sin ellas,
   simplemente esas funciones no van a andar todavía.
5. `APP_BASE_URL` también dejalo en blanco por ahora (lo vamos a completar en el paso 7, cuando ya
   sepamos la URL real que Render asignó).
6. Deploy. Verificá:
   ```bash
   curl https://<lo-que-render-haya-asignado>.onrender.com/health
   # esperado: {"ok":true}
   ```

## 4. Migrar la base propia

Con `DATABASE_URL` ya resuelta por Render (Render la conecta sola desde la base que creó en el paso 3),
corré las migraciones. Se puede hacer desde el **Shell** de Render (pestaña del servicio) o desde tu
máquina apuntando a esa misma `DATABASE_URL` (copiala del dashboard de la base → "Connect" → "External
Connection String"):

```bash
DATABASE_URL="<la-connection-string-de-la-base-render>" npm run db:migrate
```

Resultado esperado: cada archivo de `migrations/*.sql` se aplica sin error (por ahora es solo
`0001_portal_schema.sql`). Esto crea el schema `portal.*` completo — productos, precios, usuarios,
cotizaciones, auditoría. **No toca Supabase para nada.**

## 5. Confirmar el stock/PVP real en Supabase

Antes de configurar `STOCK_TABLE`/`STOCK_COLUMN_*` "a ciegas", corré la inspección de solo lectura contra
Supabase (nunca escribe nada):

```bash
STOCK_DATABASE_URL="<connection-string-de-supabase-solo-lectura>" \
STOCK_TABLE=public.productos \
node scripts/inspect_supabase_stock.js
```

Mirá la salida:

- **Columnas** — confirmá el nombre real de la columna de SKU, de cantidad de stock, de fecha de
  actualización, y de PVP. Si `STOCK_TABLE` no es `public.productos`, corré el script de nuevo con el
  nombre correcto (`STOCK_TABLE=schema.tabla`).
- **SKUs duplicados** / **SKU nulo o vacío** — si hay muchos, es esperable (el repositorio de stock ya los
  agrega de forma determinística), pero vale la pena saber cuántos hay.
- **RLS / Policies** — si la tabla tiene RLS habilitado, vas a necesitar un rol/policy que le permita `SELECT`
  a la cadena de conexión que uses en `STOCK_DATABASE_URL`.

Con eso confirmado, anotá los 5 valores reales para el paso siguiente:
`STOCK_TABLE`, `STOCK_COLUMN_SKU`, `STOCK_COLUMN_QTY`, `STOCK_COLUMN_UPDATED_AT`, `STOCK_COLUMN_PVP`.

## 6. Cargar las variables de stock en Render

En el dashboard del servicio (`autodiagnostico-portal` → Environment):

- `STOCK_DATABASE_URL` = la cadena de conexión de Supabase (solo lectura, del paso anterior).
- `STOCK_TABLE`, `STOCK_COLUMN_SKU`, `STOCK_COLUMN_QTY`, `STOCK_COLUMN_UPDATED_AT`, `STOCK_COLUMN_PVP` = los
  valores confirmados en el paso 5.

Redeploy. Con esto, si ya hubiera productos en `portal.products` (todavía no los hay — eso es el paso 8),
el catálogo mostraría stock y PVP reales.

## 7. Cliente OAuth de Google

Este es un cliente **nuevo**, separado de cualquier login interno que ya tengan — los distribuidores son
cuentas externas, no del Workspace de la empresa.

1. [Google Cloud Console](https://console.cloud.google.com/) → elegí o creá un proyecto.
2. **APIs & Services → OAuth consent screen**:
   - Tipo: **External**.
   - Nombre de la app: "Autodiagnóstico — Portal Distribuidores" (o el que prefieran).
   - Scopes: `openid`, `email`, `profile` (los que ya pide el código, no hace falta agregar nada más).
   - Mientras la app esté en modo "Testing", solo van a poder loguearse los emails que agregues como
     "Test users" — para producción real hay que publicarla (Google puede pedir verificación si agregan
     scopes sensibles, pero con estos tres no debería).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Tipo de aplicación: **Web application**.
   - **Authorized redirect URIs**: `https://<tu-url-de-render-o-dominio>/auth/google/callback`
     (tiene que ser exactamente esa ruta — así está codeada en `src/routes/auth.js`).
4. Copiá el **Client ID** y el **Client secret**.
5. En Render: cargá `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, y ahora sí `APP_BASE_URL` con la URL real
   (`https://<tu-url>.onrender.com` o tu dominio propio, sin barra final). Redeploy.
6. Probá: entrá a `https://<tu-url>/login`, click en "Continuar con Google". Te debería loguear y mandarte
   a la pantalla de "pendiente de aprobación" (todo usuario nuevo arranca así, incluso vos).

## 8. Primer administrador (bootstrap manual)

Todavía no hay un mecanismo automático para el primer admin — es correcto que sea así (nadie queda admin
por accidente), pero significa que el primer admin se promueve a mano, una sola vez:

1. Logueate una vez con tu cuenta de Google (paso 7.6) - esto crea tu fila en `portal.users` con
   `role='customer'`, `status='pending'`.
2. Conectate a la base propia del portal (`DATABASE_URL`, **no** Supabase) con `psql` o el cliente que
   prefieras, y corré:
   ```sql
   update portal.users set role = 'admin', status = 'approved' where email = 'tu-email@ejemplo.com';
   ```
3. Refrescá el portal - deberías caer en el dashboard de administrador.

De acá en adelante, cualquier otro admin se aprueba desde el panel mismo (Usuarios pendientes → Aprobar,
con rol `admin` si corresponde vía la misma pantalla).

## 9. Importación inicial de precios legacy

Esto reemplaza los precios 1u/4u/8u actuales del catálogo viejo (HTML/Sheet) por datos reales en
`portal.products`/`portal.product_prices`. Es transaccional e idempotente — no hay drama en correr el
dry-run varias veces.

**Antes de todo**, si todavía no lo hicimos: conseguí ~20 filas reales del Sheet (una fila con precio ARS
normal, una "Consultar", una vacía, una en U$S si existe, cualquier caso raro) para confirmar que
`parsePriceCell` en `src/imports/legacyCatalogImporter.js` las interpreta bien - hay un comentario en ese
archivo marcado "inferido, no validado" que señala exactamente esto.

```bash
# 1. Capturar un snapshot (elegí UNA de las tres formas):
LEGACY_CATALOG_SOURCE_URL="<la url del Web App, nunca la subas a git>" npm run capture:legacy
# o, si no hay Web App todavía:
LEGACY_SHEET_ID="<id-del-sheet>" LEGACY_SHEET_GID="0" npm run capture:legacy
# o, para probar con datos de muestra sin tocar la red:
node scripts/capture_legacy_catalog.js --input ruta/a/muestra.json

# 2. Dry-run - imprime el reporte, no escribe nada en la base:
DATABASE_URL="<la-de-render>" npm run import:legacy:dry-run -- --snapshot snapshots/<archivo>.json

# 3. Revisá el reporte a mano: nuevos/actualizados/sin-cambios/duplicados, y sobre todo la sección
#    "custom" (celdas de precio que no se pudieron interpretar como número). Si hay algo raro ahí, es acá
#    donde hay que ajustar parsePriceCell antes de seguir.

# 4. Aplicar (una sola vez; si corrés el mismo snapshot de nuevo, no duplica nada):
DATABASE_URL="<la-de-render>" npm run import:legacy:apply -- --snapshot snapshots/<archivo>.json
```

## 10. Verificación end-to-end

Con todo lo anterior hecho:

- [ ] `GET /health` → `{"ok":true}`.
- [ ] Login con una cuenta de prueba (no la tuya de admin) → cae en "pendiente de aprobación".
- [ ] Como admin: aprobás esa cuenta desde el dashboard.
- [ ] Esa cuenta ahora ve el catálogo con marcas/categorías reales, PVP real (de Supabase), stock
      cualitativo real, y precios 1u/4u/8u reales (de la importación).
- [ ] Agregar un producto al carrito y enviar una cotización → aparece en "Cotizaciones" del admin.
- [ ] Como admin: el dashboard muestra el estado de la fuente de stock (saludable/con SKUs sin match) y la
      tabla de bajo stock con cantidad exacta.

## 11. Dominio propio (opcional)

Si van a usar un dominio propio en vez de `*.onrender.com`: Render → servicio → Settings → Custom Domain,
seguir las instrucciones de DNS que da Render, y después actualizar `APP_BASE_URL` y el redirect URI del
paso 7.3 al dominio nuevo (los dos tienen que coincidir exactamente o el login de Google va a fallar con
`redirect_uri_mismatch`).

## Anexo — variables de entorno, una por una

| Variable | Dónde se usa | Quién la genera |
|---|---|---|
| `APP_BASE_URL` | Construye las URLs de OAuth y cookies | Vos, una vez que sabés la URL real de Render/dominio |
| `DATABASE_URL` | Base propia del portal (`portal.*`) | Render (automático, del recurso `databases:` en render.yaml) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Login OAuth | Google Cloud Console (paso 7) |
| `SESSION_SECRET` | Firma nada en realidad hoy (la sesión es un token opaco), reservado | Render (`generateValue: true`, automático) |
| `STOCK_DATABASE_URL` | Conexión de solo lectura a Supabase | Vos (dashboard de Supabase, rol de solo lectura) |
| `STOCK_TABLE` / `STOCK_COLUMN_SKU` / `STOCK_COLUMN_QTY` / `STOCK_COLUMN_UPDATED_AT` / `STOCK_COLUMN_PVP` | Nombres reales de tabla/columnas en Supabase | Vos, confirmados con `scripts/inspect_supabase_stock.js` (paso 5) |
| `LOW_STOCK_THRESHOLD` | Umbral cualitativo de "poco stock" | Ya tiene default (10) en render.yaml; configurable después desde `portal.app_settings` |
| `LEGACY_CATALOG_SOURCE_URL` | Fuente del catálogo legacy para la importación única | Vos - nunca se commitea, solo vive en env vars |

## Troubleshooting rápido

- **Login de Google redirige con `?error=google_not_configured`** → faltan `GOOGLE_CLIENT_ID`/`SECRET` en Render.
- **`?error=invalid_state`** → normalmente cookies bloqueadas o `APP_BASE_URL` mal configurado (tiene que
  coincidir con la URL real, sin barra final).
- **Catálogo se ve pero todo dice "Sin stock"** → `STOCK_DATABASE_URL` no está seteado o
  `STOCK_TABLE`/`STOCK_COLUMN_*` no coinciden con la tabla real - correr `scripts/inspect_supabase_stock.js`
  de nuevo.
- **La importación dice "ya fue aplicado antes"** → es el comportamiento esperado si el snapshot tiene el
  mismo hash que uno ya aplicado (idempotencia). Si de verdad cambió algo, volvé a capturar un snapshot
  nuevo (paso 9.1).
