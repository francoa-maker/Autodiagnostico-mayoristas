# Brief de arranque — Implementación del rediseño UI (Portal Autodiagnóstico)

> **Para otra instancia de Claude Code.** Pegá este archivo como primer mensaje. Es la orden de trabajo: leé las referencias que indica ANTES de tocar código. No tenés el historial de la conversación donde se diseñó esto — todo lo que necesitás está en el repo y en la guía.

## Tu misión
Implementar en el repositorio el **rediseño de UI** (dashboard del cliente + panel interno) que ya está definido en **maquetas HTML navegables**, **sin perder ninguna función** de la versión actual y **sin reescribir el backend** salvo lo que se indica explícitamente. Trabajás en una **rama nueva**, nunca sobre producción.

## Contexto del proyecto (imprescindible)
- **Repo**: `https://github.com/francoa-maker/Autodiagnostico-mayoristas` (público). Rama de producción = **`master`**. Rama de trabajo = **`rediseno-ui-2026`** (ya creada; contiene las maquetas + guía en `docs/rediseno-ui/`). La rama `main` solo tiene README; `rediseno-catalogo-cliente` está **obsoleta**: ignorala.
- **Stack**: Node.js ≥20 + Express, `pg` (sin ORM), **HTML/CSS/JS plano en `public/` sin build step**. Dos bases de datos separadas: la propia del portal (Postgres) y **Supabase** (stock + PVP, **solo lectura**, por SKU normalizado). 
- **CSP estricta** (`src/securityHeaders.js`): **prohibido JS inline y recursos externos**. Los `onclick` de las maquetas son solo para el prototipo — al portar, usá `addEventListener`/delegación (ya existe `public/assets/doc-actions.js` como patrón).
- **Negocio**: equipos de diagnóstico automotriz, venta mayorista B2B. **Precios por 4 tramos PVP / 1u / 4u / 8u** con quantity breaks (≥8→8u, ≥4→4u) — **ya implementado en el backend** (`src/pricing.js`, `catalog.js`). PVP viene en vivo de Supabase; 1u/4u/8u son del portal. Stock **cualitativo** (nunca la cantidad exacta al cliente).

## PASO 1 — Leé esto ANTES de codear (no lo saltees)
1. **La guía detallada**: `docs/rediseno-ui/GUIA-implementacion-rediseno.md`. Tiene el **mapa mockup→repo**, los pasos, la **checklist de paridad de funciones**, los riesgos, y las secciones **11.x** con las features nuevas. Es tu fuente de verdad.
2. **Las maquetas objetivo** (abrilas en el navegador — son el target visual/UX exacto):
   - `docs/rediseno-ui/portal-mockup-v4.html` — **dashboard del cliente**.
   - `docs/rediseno-ui/portal-admin-mockup.html` — **panel interno** (usá el selector "Ver como rol").
3. La **UI actual** corriendo local (ver PASO 2), para comparar y no perder nada.

> **Plan B — si el repo todavía NO tiene `docs/rediseno-ui/`** (el usuario aún no corrió el script de subida): las maquetas y la guía están en la carpeta local del usuario:
> `C:\Users\Patagonia - Franco\Desktop\autodiagnostico mayoristas\mockup\`
> Archivos: `portal-mockup-v4.html`, `portal-admin-mockup.html`, `GUIA-implementacion-rediseno.md`, `ARRANQUE-implementacion.md` (este brief). Copialos vos a `docs/rediseno-ui/` dentro del repo y commitéalos como primer paso (ver PASO 2). Confirmá con el usuario la ruta si tu working directory es distinto.

## PASO 2 — Setup del entorno
```bash
git clone https://github.com/francoa-maker/Autodiagnostico-mayoristas.git
cd Autodiagnostico-mayoristas

# CASO A — la rama ya existe (el usuario corrió subir-cambios.ps1):
git checkout rediseno-ui-2026            # trae docs/rediseno-ui/ con maquetas + guía

# CASO B — arranque en limpio (la rama NO existe todavía):
git checkout -b rediseno-ui-2026 master
# y copiá las maquetas + guía + este brief desde la carpeta local del usuario a docs/rediseno-ui/:
#   origen: C:\Users\Patagonia - Franco\Desktop\autodiagnostico mayoristas\mockup\
#   destino en el repo: docs/rediseno-ui/
# luego: git add docs/rediseno-ui && git commit -m "docs: maquetas y guia del rediseno UI"

npm install
cp .env.example .env                     # completar con los valores reales (NO commitear .env)
```
Variables mínimas en `.env`: `DATABASE_URL` (Postgres del portal — puede apuntar a prod o a una base local con `npm run db:migrate`), `STOCK_DATABASE_URL` + `STOCK_*` (Supabase), `SESSION_SECRET`. Para ver los módulos financieros/logística: `ENABLE_FINANCIAL_MODULE=true`, `ENABLE_CURRENT_ACCOUNT_MODULE=true`, `ENABLE_ECHEQ_MODULE=true`, `ENABLE_SERIAL_NUMBERS_MODULE=true`. Google OAuth/Drive pueden quedar vacíos (se usa dev-login).
```bash
npm start
# probar cada rol (en otra terminal), NODE_ENV != production:
curl -X POST http://localhost:3000/auth/dev-login -H "content-type: application/json" -d '{"email":"vos@ej.com","role":"superadmin","status":"approved"}' -c cookies.txt
# roles: client | sales_billing | administration | logistics | superadmin
```

## REGLA DE ORO
El backend y la lógica **ya existen** (precios por tramo, filtros, favoritos, cotizaciones, finanzas, logística, documentos, marca de agua). Esto es **refactor de vista + CSS**, no lógica nueva. **No rompas endpoints ni el wiring de API.** Reusá el estado y las llamadas `fetch` existentes; cambiá el markup que emiten las funciones `render*` y el CSS.

## Plan por fases (hacé commits chicos por fase)
- **Fase 1 — Design system.** Portá el bloque `<style>` de las maquetas a `public/assets/styles.css` como **tokens + componentes** (paleta rojo `#C8102E` / negro `#111` / blanco, modo claro; botones, tablas thead negro, pills, tarjetas con tabla de 4 tramos, chips, modales, toasts, chatter, stepper, chipbox de emails).
- **Fase 2 — Cliente** (`public/index.html` + `public/assets/catalog.js`). Layout de `portal-mockup-v4.html`: hub + filtros con contadores + grilla con **4 tramos y estimado por cantidad** + carrito "solicitud de cotización" + notificaciones + perfil fiscal/Andreani + cuenta corriente + informar transferencia + **PDF que respeta filtros** (§4 de la guía). Mover `onclick`→listeners.
- **Fase 3 — Interno** (`public/admin.html` + `public/assets/admin.js` + `logistics.js`). Las **8 secciones por rol** (respetar `SECTIONS_BY_ROLE` + gating por capability), editor de catálogo, productos/precios, clientes, cotizaciones, facturación, logística, configuración.
- **Fase 4 — Features nuevas** (detalle en §11 de la guía):
  - **Estados de venta simplificados a 5** (Cotización → Cotización enviada → Orden de venta → Despachado, + Cancelado) con **migración de datos** de los estados viejos (§11.2). Toca `QUOTE_STATUSES`, la columna de estado, y los labels en `catalog.js`/`admin.js`.
  - **Chatter lateral** en el detalle de cotización/pedido, alimentado por **`portal.audit_log`** (§11.1).
  - **Mail multi-destinatario + configuración de avisos automáticos**: compositor con Para + CC/CCO (chips), y panel en Configuración (`app_settings` key `email_recipients`). **"Enviar a depósito" (`sendWarehouse`) se deja como está** (§11.1).
  - **Secciones y notas + términos de pago/vencimiento** en la cotización.
  - **Vista de compras por cliente** con stepper de estado.
  - **Programar envíos** (única con algo de backend: cola/cron de envíos pendientes).
- **Fase 5 — Verificación.** Recorré la **checklist de paridad** (guía) contra cada pantalla y rol.

## Guardrails (no negociables)
- Trabajá **solo en `rediseno-ui-2026`**, nunca en `master`. **Nunca** `--force`.
- **No** expongas la cantidad exacta de stock al cliente (solo estado cualitativo).
- PVP y stock: **solo lectura** de Supabase; 1u/4u/8u son del portal.
- Respetá el **gating por rol/capability** (`permissions.js`) y los **feature flags**.
- CSP: **nada de JS inline** ni recursos de terceros sin habilitar el dominio en `securityHeaders.js`.
- Antes de cada commit: `npm test` (vitest) en verde y probar la pantalla con `dev-login` del rol afectado. `npm run test:e2e` (Playwright) si tocaste flujos.
- Commits chicos y descriptivos. Terminá los mensajes con:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Al terminar
Dejá todo en `rediseno-ui-2026` y avisá al usuario para que revise y decida el merge a `master` / deploy en Render. Si algo de la guía no cierra con el código real, **preguntá al usuario** en vez de asumir (ej. precios reales 1u/4u/8u, mapeo exacto de estados viejos, quién recibe cada aviso).
