# Guía de implementación — Rediseño UI Portal Autodiagnóstico

> **Para retomar en otra sesión.** Pegá este archivo como contexto (o pedí que lo lea) junto con el repo clonado. Resume qué se diseñó, con qué criterios, y **exactamente qué tocar en el código** para llevar las maquetas a producción sin perder funciones.
> Fecha: 2026-07-29 · Autor del rediseño: sesión de Claude Code.

---

## 1. Objetivo

Rediseñar la interfaz del portal mayorista **Autodiagnóstico** (equipos de diagnóstico automotriz) inspirándose en el gestor de la droguería Disval, **conservando TODAS las funciones de la versión actual** (rama `master`). Se trabajó **maqueta primero** (prototipos HTML navegables), sin tocar el repo. Esta guía es el puente para implementarlo.

**Regla de oro:** el backend y la lógica ya existen (precios por tramo, filtros, favoritos, cotizaciones, finanzas, logística, etc.). El rediseño es principalmente **refactor de vista + CSS**, NO lógica nueva. No romper endpoints ni el wiring de API.

---

## 2. Entregables (maquetas)

Carpeta: `Desktop\autodiagnostico mayoristas\mockup\`

| Archivo | Qué es |
|---|---|
| `portal-mockup-v4.html` | **Dashboard del CLIENTE** (vigente). Estética real + catálogo real 358 prod. + todas las funciones del cliente. |
| `portal-admin-mockup.html` | **Panel INTERNO** (vigente). Paleta clara, 8 secciones por rol + selector "Ver como rol". |
| `portal-mockup-v3.html` | Cliente sin precios por tramo (histórico). |
| `portal-mockup-v2.html`, `portal-mockup.html` | Iteraciones previas (v1 tenía rubro equivocado). |

Artifacts (privados, para ver/compartir):
- Cliente v4: https://claude.ai/code/artifact/a237a1f1-3b4d-4156-8bd1-9c273d86cdd3
- Panel interno: https://claude.ai/code/artifact/ff7609c2-8c17-48b4-9863-ec54abfea2b8

Datos: `scratchpad\products.json` (358 productos reales del CSV `Documents\scrapping descrips\outputs\autodiagnostico_productos_todos.csv`, marcas/categorías normalizadas). **Las maquetas son solo UI: datos de cuenta/pedidos ficticios y precios 1u/4u/8u ilustrativos.**

---

## 3. Sistema de diseño (tokens)

Paleta **real del portal** (extraída del catálogo actual), modo claro únicamente (sin dark mode):

```css
--red:#C8102E; --red-600:#a60d26; --red-050:#fff0f2; --red-100:#fbdbe0;
--dark:#111111; --mid:#2C2C2C; --light:#F4F4F4; --card:#ffffff;
--border:#E4E4E7; --muted:#8a8a90;
--ok:#166534/#dcfce7; --warn:#854d0e/#fef9c3; --out:#991b1b/#fee2e2; --green:#16a34a; --blue:#2563eb;
--sans: system-ui / -apple-system / Segoe UI (SIN webfonts externas — CSP)
```

- Logo: texto **Auto**(negro/blanco)+**diagnostico**(rojo). Header cliente negro `#111`; barra superior roja. Panel interno: sidebar clara blanca con activo rojo.
- Componentes ya definidos en las maquetas (copiar el bloque `<style>`): botones (`.btn-red/.btn-dark/.btn-ghost`), tablas (thead negro), pills de estado, tarjetas de producto con **tabla de 4 tramos**, chips de filtros, modales, toasts, KPIs, drawers responsive.

---

## 4. Cliente — qué cambia (mapea a `public/index.html` + `public/assets/catalog.js` + `styles.css`)

La maqueta `portal-mockup-v4.html` es el objetivo visual. Funciones que DEBEN quedar (todas ya existen en `catalog.js`):

- **Catálogo**: hub con stats + accesos rápidos (Todos / Con disponibilidad / Novedades / Favoritos / Pedidos frecuentes) + tarjetas de marca; sidebar de filtros (Marca, Categoría con buscador + "Ver más", Disponibilidad, Precio) con contadores; buscador; orden; grilla/lista; chips de filtros activos.
- **Precios 4 tramos PVP / 1u / 4u / 8u** con quantity breaks (≥8→8u, ≥4→4u, si no 1u) y "Estimado" en vivo por cantidad. **Ya está en `pricing.js` / `catalog.js:resolveDisplay/tierForQuantity`** — solo re-estilar la tabla de precios de la tarjeta. Fallback PVP−15% y "Consultar" ya implementados: respetarlos.
- **Solicitud de cotización** (carrito): observaciones, total estimado, aclaración "pre-cotización sujeta a confirmación"; `POST /api/quotes`.
- **Favoritos** (corazón, persistentes), **Notificaciones** (campana), **Mis solicitudes/Mis cotizaciones** con estados reales (submitted/reviewing/quoted/accepted/rejected) y "Ver Pre-compra/Compra".
- **Cuenta corriente** (banner: deuda/vencido/a vencer/a favor/eCheqs) + estado de cuenta; **Ver facturas + cuotas** e **Informar transferencia** por pedido (gated por flags `financial`/`currentAccount`).
- **Mis datos**: fiscal (razón social, condición IVA, tipo+nº doc) + dirección de entrega **formato Andreani**.
- **Marca de agua confidencial por usuario** (empresa · email · fecha) — ya existe (`catalog.js:renderWatermark`).
- **Descargar catálogo (PDF) que respeta los filtros activos** (mejora nueva). Hoy el botón es un `<a href="/api/catalog/pdf">` fijo (`index.html:65`) y la ruta consulta `where active and visible` sin filtros (`routes/catalog.js:130-143`), por eso siempre lista todo. Cambio propuesto:
  - **Cliente**: reemplazar el `<a>` por un botón con listener que arma la URL desde la lista visible `computeFiltered()`. Si hay filtro activo → `/api/catalog/pdf?skus=<sku1,sku2,...>`; si no → `/api/catalog/pdf` (completo). Label dinámico: "Descargar catálogo (PDF)" vs "Descargar filtrado (N)".
  - **Backend** (`routes/catalog.js` `/catalog/pdf`): si viene `skus`, agregar `and sku = any($1)` a la query y un subtítulo con los filtros aplicados; el agrupado por marca, la marca de agua y la fecha quedan igual.
  - Enviar los SKU del resultado (no re-implementar los filtros en el server) mantiene la fidelidad total: respeta marca, categoría, disponibilidad, precio, favoritos, frecuentes y búsqueda, porque sale exactamente de lo que ve el cliente. Los sets filtrados son chicos → sin problema de largo de URL; si alguna vez fuera enorme, pasar ese caso a POST. Está demostrado en la maqueta v4 (botón "Descargar (PDF)" en la barra de productos + vista previa `openCatalogPdf`).

> Nota: la maqueta usa `<button onclick="...">` inline. **La CSP del portal prohíbe JS inline** (`securityHeaders.js`; por eso existe `doc-actions.js`). Al portar, mover handlers a `catalog.js` con `addEventListener`/delegación por `data-*`, NO usar `onclick` en el HTML.

---

## 5. Interno — qué cambia (mapea a `public/admin.html` + `public/assets/admin.js` + `logistics.js`)

La maqueta `portal-admin-mockup.html` es el objetivo. **8 secciones, visibilidad por rol** (`SECTIONS_BY_ROLE`, ya en `admin.js`): superadmin/sales_billing ven todo; administración solo Facturación; logística solo Logística.

1. **Dashboard**: KPIs, clientes pendientes (aprobar/rechazar), últimas cotizaciones, bajo/sin stock (cantidad exacta solo admin), auditoría.
2. **Catálogo (editor)**: grilla de tarjetas, drag&drop de orden, ojito visible/oculto, editar/borrar, selección múltiple + reasignación masiva, modal marcas/categorías (renombrar/fusionar/ordenar), modal logos de marca.
3. **Productos y precios**: tabla editable (orden, SKU, nombre, marca, IVA, 1u/4u/8u, visible). **PVP solo lectura** (viene de Supabase).
4. **Clientes**: tabla + filtros; aprobar/rechazar; **cambio de rol solo superadmin** (deshabilitado para el resto); editar datos fiscales/envío; alta manual; eliminar (con protecciones anti-lockout).
5. **Cotizaciones (worklist)**: lista + editor de detalle (ítems editables, descuento/envío/notas, estado), **Ver Pre-compra**, **Enviar Pre-compra** (Gmail del vendedor), **Enviar hoja de armado** al depósito.
6. **Facturación** (flag): worklist + por pedido: facturas+cuotas, pagos (confirmar informados), eCheqs, cuenta corriente (ajustes/estado), **autorizar a Logística**.
7. **Logística**: pedidos autorizados (sin datos financieros) + carga de **números de serie por unidad** + marcar despachado.
8. **Configuración**: perfil de empresa (nombre, razón social, dirección, tel, email, web, CUIT, casilla depósito, validez pre-compra en días, texto al pie), integraciones.

Mantener el **gating por capability** del backend (`permissions.js`, `requireCapability`). No exponer mutaciones a roles sin permiso.

---

## 6. Mapa mockup → repo (rama `master`)

| Mockup | Archivos del repo a modificar |
|---|---|
| `portal-mockup-v4.html` (cliente) | `public/index.html` (markup), `public/assets/catalog.js` (render), `public/assets/styles.css` (tokens+componentes) |
| `portal-admin-mockup.html` (interno) | `public/admin.html`, `public/assets/admin.js`, `public/assets/logistics.js` |
| — | `public/login.html` / `pending.html` (aplicar misma estética, opcional) |
| Backend | **No tocar** salvo que falte algo. Los 4 tramos, filtros, finanzas, etc. ya existen. |

Repo público: `https://github.com/francoa-maker/Autodiagnostico-mayoristas` · rama de producción **`master`** (la default `main` solo tiene README; `rediseno-catalogo-cliente` está **desactualizada**, NO usarla).

---

## 7. Pasos de implementación (próxima sesión)

1. **Clonar y ramificar** desde master:
   ```bash
   git clone https://github.com/francoa-maker/Autodiagnostico-mayoristas.git
   cd Autodiagnostico-mayoristas && git checkout master && git checkout -b rediseno-ui-2026
   ```
2. **Correr local** (sin Google, con dev-login) para ver la UI actual y comparar:
   ```bash
   npm install
   npm start
   # en otra terminal:
   curl -X POST http://localhost:3000/auth/dev-login -H "content-type: application/json" -d '{"email":"vos@ejemplo.com","role":"superadmin","status":"approved"}' -c cookies.txt
   ```
   (cambiar `role` por `client`, `sales_billing`, `administration`, `logistics` para probar cada vista).
3. **Portar el CSS**: llevar el bloque `<style>` de las maquetas a `public/assets/styles.css` como tokens + componentes.
4. **Cliente**: reestructurar `public/index.html` al layout de v4 y adaptar las funciones `render*` de `catalog.js` para emitir el nuevo markup, **reusando el estado y las llamadas a API existentes**. Reemplazar `onclick` inline por listeners (CSP).
5. **Interno**: ídem con `admin.html` / `admin.js`. Respetar `SECTIONS_BY_ROLE` y el gating por capability.
6. **Precios**: NO tocar `pricing.js`. La maqueta calcula 1u/4u/8u ilustrativos; en real vienen de la DB — solo re-estilar cómo se muestran.
7. **Probar**: comparar cada pantalla contra el checklist (sección 8). Verificar CSP (sin errores de inline script en consola), responsive, y los flujos: solicitud→pre-compra, cotización (interno)→enviar, informar transferencia, seriales en logística.
8. **Tests**:
   ```bash
   npm test          # vitest (funciones puras)
   npm run test:e2e  # Playwright (necesita Postgres local)
   ```
9. **Commit/push** a `rediseno-ui-2026` y revisar en Render (deploy preview o merge a master cuando esté ok). Patrón de trabajo del proyecto: probar local → tests → commit/push → deploy → verificar prod.

---

## 8. Checklist de paridad (no perder funciones)

**Cliente:** catálogo (filtros+contadores, buscador, orden, grilla/lista, hub, accesos rápidos, tarjetas de marca) · 4 tramos + estimado + fallback PVP−15%/Consultar · stock cualitativo · solicitud/observaciones/enviar · favoritos · notificaciones · mis solicitudes/cotizaciones + estados · Ver Pre-compra/Compra · cuenta corriente + banner + estado de cuenta · ver facturas/cuotas · informar transferencia · Mis datos (fiscal+Andreani) · marca de agua · catálogo PDF · logout.

**Interno:** dashboard (KPIs, pendientes, low-stock, auditoría, polling) · catálogo editor (drag&drop, visible, bulk, taxonomía, logos) · productos/precios editable (PVP read-only) · clientes (aprobar, rol solo superadmin, datos, alta, baja con protecciones) · cotizaciones (editor ítems, descuento/envío, estados, proforma, enviar Gmail, hoja de armado) · facturación (facturas/cuotas, pagos, eCheqs, cuenta corriente, autorizar logística) · logística (preparar, seriales por unidad, despachar) · configuración (perfil empresa, validez pre-compra, integraciones) · auditoría.

---

## 9. Riesgos / recordatorios

- **CSP estricta**: sin scripts inline ni fuentes/recursos externos. Portar handlers a `.js`; imágenes de logo por URL propia.
- **PVP y stock** vienen en vivo de **Supabase** (read-only, por SKU normalizado); 1u/4u/8u son del portal. Nunca exponer cantidad exacta de stock al cliente.
- **Feature flags** (`financial`, `currentAccount`, `echeq`, `serialNumbers`): controlan qué se muestra. En prod estaban activados; respetar el gating.
- **Cambiar rol = solo superadmin**; no dejar el portal sin superadmin (protección `last_superadmin`).
- No romper: `POST /api/quotes` (solicitud), endpoints admin de precios/cotizaciones/finanzas, generación de proforma/PDF.
- Datos ficticios de las maquetas (clientes, pedidos, cuenta, precios de tramo): **no copiarlos**, son solo para el prototipo.

---

## 10. Pendientes a confirmar con el usuario

- Precios reales 1u/4u/8u (en la maqueta son ilustrativos: 1u=PVP−15%, 4u=−20%, 8u=−25%).
- Si el panel interno debe replicar el sidebar oscuro actual o adoptar el claro de la maqueta (se decidió **claro**).
- Textos/branding finales (logo real, teléfonos, casilla de depósito).

---

## 11. Funcionalidades inspiradas en Odoo (candidatas a sumar al portal custom)

> Decisión del usuario: **NO usar Odoo como backend**; solo tomar ideas y agregarlas al portal propio. Priorizar cuando se retome. Lo que el portal YA tiene (estados cotización→orden, envío por email con PDF/proforma, descuento, almacén, números de serie, facturas/pagos/cuenta corriente) queda como está.

**Cierran el ciclo de venta (mayor valor):**
- **Aceptación + firma en línea de la Pre-compra.** Hoy el pase a "accepted" (Compra) lo hace un admin. Agregar un botón del lado del cliente para **aprobar/firmar online** la Pre-compra → cambia estado a `accepted` y registra firma/fecha. Toca: cliente (`catalog.js` vista de cotización + `POST` nuevo tipo `/api/quotes/:id/accept`), backend (endpoint + columnas firma), y la proforma ("Compra").
- **Pago en línea.** Link de pago (MercadoPago/Stripe) para señar/pagar cotización o factura. ⚠️ Servicio externo → habilitar dominios en la **CSP** (`securityHeaders.js`) + credenciales + webhook de confirmación. Integra con el módulo de pagos existente (`finance/payments.js`).

**Mejoran la cotización (fácil–medio):**
- **Secciones y notas en las líneas** (agrupar ítems + aclaraciones), estilo "Agregar sección/nota" de Odoo. Toca el editor de cotizaciones interno (`admin.js` + `quote_items` con tipo línea/sección/nota).
- **Términos de pago + vencimiento** visibles en la Pre-compra (ej. "30 días"). Campo en la cotización + render en proforma.
- **Plantillas de email** al enviar (cotización / confirmación / pago recibido) — selector antes de enviar por Gmail.

**Interno / catálogo:**
- **Alta de producto por código de barras** (escanear → prefill vía servicio tipo barcodelookup). ⚠️ Servicio externo + CSP. Suma al editor de catálogo (`admin.js`).

**UX / seguridad:**
- **Autocompletar dirección** (Google Places) en "Mis datos". ⚠️ CSP + no poner datos personales en la URL.
- **Anti-spam** (reCAPTCHA v3 / Cloudflare Turnstile) en formularios públicos (login, alta). ⚠️ CSP + claves.

**Recomendación de arranque:** aceptación+firma en línea, pago en línea, y secciones/notas. Nota transversal: todo lo que use **terceros** (pago, Google, reCAPTCHA, barcode) requiere ajustar la **CSP** y cargar credenciales — no es "gratis".

### 11.1 UX/UI inspiradas en Odoo — YA reflejadas en la maqueta interna (`portal-admin-mockup.html`)

Son cambios de **presentación** (no de backend); el usuario los pidió como UX/UI. Ya están demostrados en la maqueta del panel interno:

- **Chatter lateral (timeline de cambios) en el detalle de cotización/pedido.** Columna a la derecha del formulario con: registro de cambios (Estado, Total, etc. tipo `En revisión → Cotizada`), mensajes, y composer con **adjuntar** y **programar envío**. En el repo se alimenta del **`portal.audit_log`** que ya existe (hay entradas por entidad: `quote.update`, `price.update`, etc.) + una tabla nueva de mensajes/actividades si se quiere chat real. Va en `admin.js` (rehacer `renderQuoteEditor` a 2 columnas: form + chatter).
- **Programar envíos.** En el compositor de "Enviar Pre-compra" (`sendProforma` en `admin.js`), agregar opción "Programar el envío" (fecha/hora) además de enviar ahora. Requiere una cola/scheduler en el backend (cron o tabla de envíos pendientes) — es lo único con algo de backend.
- **Adjuntar archivos al iniciar la cadena de mails.** En ese mismo compositor: lista de adjuntos (la proforma va precargada) + botón adjuntar. Se apoya en el storage de documentos existente (Google Drive/local).
- **Múltiples destinatarios + configuración de avisos automáticos.** El compositor de mail (`sendProforma`/nuevo `openSendEmail`) pasa de un solo "Para" a **campos multi-destinatario** (Para + CC/CCO con chips: agregar/quitar), con el cliente precargado. Y en **Configuración** hay un panel **"Notificaciones automáticas por email"**: un "Copia siempre a (CC)" global + una tabla por evento (Cotización enviada / Orden confirmada / Pago recibido / Despachado) donde se define **a quién llega cada aviso** y si está activo. Al elegir una plantilla en el compositor, se precargan los destinatarios según esa config. Backend: guardar la config en `app_settings` (key `email_recipients`), extender el envío para aceptar arrays `to`/`cc` y resolver la lista por plantilla. El botón **"Enviar a depósito"** (`sendWarehouse`) **queda como está** (destinatario fijo del depósito). Ya reflejado en `portal-admin-mockup.html`.
- **Ver por cliente el estado de cada compra.** En Clientes, botón "Ver compras" → modal con los pedidos del cliente, su **estado** (pill) y un **stepper** Solicitud → Cotización → Compra. En el repo: nuevo endpoint `GET /api/admin/users/:id/orders` (o reusar `/api/admin/quotes?userId=`) + render en `admin.js`.
- **Secciones y notas + términos de pago/vencimiento** en la cotización (ver arriba) — también demostrado en el editor de la maqueta.

Todos usan la misma paleta clara. El "stepper" y el "chatter" son componentes reutilizables (definidos en la maqueta) que sirven también para el detalle de pedido/facturación.

### 11.2 Modelo de estados de venta SIMPLIFICADO (decisión del usuario)

El ciclo de ventas se reduce a **5 estados** (antes había submitted/reviewing/quoted/accepted/rejected/expired/cancelled):

| Nuevo estado | Label | Reemplaza a | Doc |
|---|---|---|---|
| `cotizacion` | Cotización | submitted + reviewing | Pre-compra (borrador) |
| `enviada` | Cotización enviada | quoted | Pre-compra (enviada) |
| `orden` | Orden de venta | accepted | Compra |
| `despachado` | Despachado | *(nuevo, post-logística)* | Compra |
| `cancelado` | Cancelado | rejected + expired + cancelled | — |

- **Stepper/ribbon** (progresivo): Cotización → Cotización enviada → Orden de venta → Despachado. **Cancelado** se muestra aparte, en rojo (reemplaza el ribbon), estilo Odoo.
- `despachado` lo dispara **Logística** al marcar despachado (hoy hay estado logístico `despachado` separado — unificarlo con el estado de venta).
- **Backend**: cambiar `QUOTE_STATUSES` en `routes/admin.js` y la columna de estado en `quote_requests` (migración de datos de los valores viejos a los nuevos), más los textos `REQ_STATUS_LABEL`/`REQ_STATUS_HINT` (`catalog.js`) y `QUOTE_STATUS_LABEL` (`admin.js`). El botón "Ver Pre-compra/Compra" usa: `orden`/`despachado` → "Compra", `enviada` → "Pre-compra". Ya reflejado en ambas maquetas (`portal-mockup-v4.html` y `portal-admin-mockup.html`).
