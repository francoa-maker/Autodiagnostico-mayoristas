import express from "express";
import { pool, withTransaction } from "../db.js";
import { requireAdmin, requireCapability } from "../middleware.js";
import { getStockSourceHealth, getStockForSkus } from "../stock/stockRepository.js";
import { recordAudit } from "../audit.js";
import { normalizeSku } from "../skuNormalize.js";
import { computeQuoteTotals } from "../quoteTotals.js";
import { renderProformaHtml, renderWarehouseHtml } from "../proforma.js";
import { sendGmail } from "../mailer.js";
import { resolveWholesaleUnit } from "../pricing.js";
import { saveUserProfile, profileComplete, PROFILE_COLUMNS } from "./profile.js";
import { generateClientCode } from "../auth.js";
import { ROLES, normalizeRole, isSuperadmin, isAdminStaff } from "../permissions.js";
import { computeDueDate, PAYMENT_TERMS } from "../finance/paymentTerms.js";
import { listEmailTemplates, saveEmailTemplate } from "../email/queue.js";
import { certificateWarning } from "../email/worker.js";
import { notifyQuoteEventSafe } from "../notifications.js";

const router = express.Router();
router.use(requireAdmin);

// Gating por sector encima de requireAdmin (que sólo exige personal aprobado).
// Las LECTURAS quedan abiertas a todo el personal (la nav de cada rol decide qué
// se muestra, y facturación necesita leer pedidos/clientes). Las MUTACIONES de
// cada sector se cierran por capability: así administración (solo Facturación)
// no puede tocar catálogo, cotizaciones ni usuarios aunque llame la API directo.
// superadmin tiene "*" y pasa siempre.
const canCatalog = requireCapability("catalog.manage");
const canQuotes = requireCapability("quotes.manage");
const canClients = requireCapability("clients.manage");

// ------------------------------------------------------------------ helpers

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_STATUSES = ["pending", "approved", "rejected", "blocked"];
const USER_ROLES = ROLES; // superadmin/sales_billing/administration/logistics/client
// Modelo simplificado de 5 estados (guía §11.2). 'despachado' lo setea Logística.
const QUOTE_STATUSES = ["abierto", "cotizacion", "enviada", "orden", "despachado", "cancelado"];
const PRICE_STATES = ["value", "consult", "hidden", "unavailable", "custom"];

// Reject a malformed :id / :itemId with a clean 400 before it reaches
// Postgres (which would otherwise throw a raw "invalid input syntax for
// type uuid" 500). Applies to every route that uses these params.
router.param("id", (req, res, next, value) => (UUID_RE.test(value) ? next() : res.status(400).json({ error: "invalid_id" })));
router.param("itemId", (req, res, next, value) => (UUID_RE.test(value) ? next() : res.status(400).json({ error: "invalid_item_id" })));

// Coerce a value expected to be numeric. Returns { ok, value } so callers can
// answer 400 instead of letting NaN reach a numeric column and blow up the
// transaction with a generic 500. undefined/null/"" pass through as null.
function asNumber(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const n = Number(raw);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
}

const TIERS = ["one", "four", "eight"];

function tierForQuantity(qty) {
  if (qty >= 8) return "eight";
  if (qty >= 4) return "four";
  return "one";
}

// Recompute a quote's stored totals from its current items + adjustments,
// using the shared computeQuoteTotals (IVA is backed out of the IVA-included
// line prices, not added on top). Stores itemsGross as quoted_subtotal, the
// computed IVA as tax, and the gross total as quoted_total.
async function recomputeQuoteTotals(client, quoteId) {
  const items = await client.query(
    `select quantity, quoted_unit_price, displayed_price_snapshot, iva_rate from portal.quote_items where quote_request_id = $1 and line_type = 'product'`,
    [quoteId]
  );
  const q = await client.query(
    `select discount, discount_type, shipping, surcharge from portal.quote_requests where id = $1`,
    [quoteId]
  );
  const row = q.rows[0] || {};
  const totals = computeQuoteTotals({
    items: items.rows,
    discount: row.discount,
    discountType: row.discount_type,
    shipping: row.shipping,
    surcharge: row.surcharge
  });
  await client.query(
    `update portal.quote_requests set quoted_subtotal = $2, tax = $3, quoted_total = $4, updated_at = now() where id = $1`,
    [quoteId, totals.itemsGross, totals.ivaTotal, totals.total]
  );
  return { quotedSubtotal: totals.itemsGross, iva: totals.ivaTotal, neto: totals.netoTotal, quotedTotal: totals.total, ivaGroups: totals.ivaGroups, unpricedLines: totals.unpricedLines };
}

const DEFAULT_COMPANY_PROFILE = {
  name: "Autodiagnóstico",
  legalName: "",
  addressLines: [],
  phone: "",
  email: "",
  website: "autodiagnostico.com.ar",
  taxId: "",
  logoUrl: "",
  proformaFooter: "Documento no válido como factura. Precios sujetos a confirmación.",
  proformaValidityDays: 7,
  warehouseEmail: "joaquin.guerri@patagoniatools.com.ar"
};

async function getCompanyProfile() {
  const result = await pool.query(`select value from portal.app_settings where key = 'company_profile'`);
  return { ...DEFAULT_COMPANY_PROFILE, ...(result.rows[0]?.value || {}) };
}

router.get("/admin/users", async (req, res) => {
  const params = [];
  const conditions = [];
  if (req.query.status) {
    if (!USER_STATUSES.includes(req.query.status)) return res.status(400).json({ error: "invalid_status" });
    params.push(req.query.status);
    conditions.push(`status = $${params.length}`);
  }
  if (req.query.month) {
    if (!MONTH_RE.test(req.query.month)) return res.status(400).json({ error: "invalid_month" });
    params.push(req.query.month);
    conditions.push(`to_char(created_at AT TIME ZONE '${AR_TZ}', 'YYYY-MM') = $${params.length}`);
  }
  // Búsqueda libre, usada por el buscador de clientes del modal "nueva
  // cotización" (además de cualquier filtro futuro en la lista de Clientes).
  if (req.query.search) {
    params.push(`%${req.query.search}%`);
    conditions.push(`(email ilike $${params.length} or display_name ilike $${params.length} or company_name ilike $${params.length})`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const result = await pool.query(
    `select id, email, display_name, company_name, client_code, role, status, created_at, last_login_at
     from portal.users ${where} order by created_at desc`,
    params
  );
  res.json({ users: result.rows });
});

// Alta manual de un cliente desde el panel, sin pasar por el login de Google
// (ej. un mayorista que pide por teléfono). Se crea con google_sub NULL: si
// ese email inicia sesión con Google más adelante, findOrCreateUser
// (src/auth.js) vincula esta misma ficha en vez de duplicarla.
router.post("/admin/users", canClients, async (req, res) => {
  const { email, displayName, companyName, role, status } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) return res.status(400).json({ error: "invalid_email" });
  if (role != null && !USER_ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });
  if (status != null && !USER_STATUSES.includes(status)) return res.status(400).json({ error: "invalid_status" });

  const existing = await pool.query(`select id from portal.users where email = $1`, [cleanEmail]);
  if (existing.rows[0]) return res.status(409).json({ error: "email_already_exists", detail: "Ya existe un cliente con ese email." });

  const finalRole = role || "client";
  const finalStatus = status || "approved";
  const approvedAt = finalStatus === "approved" ? new Date() : null;
  const approvedBy = finalStatus === "approved" ? req.user.id : null;
  const result = await pool.query(
    `insert into portal.users
       (email, display_name, company_name, role, status, approved_at, approved_by, client_code)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [cleanEmail, displayName?.trim() || cleanEmail, companyName?.trim() || null, finalRole, finalStatus, approvedAt, approvedBy, generateClientCode()]
  );
  await recordAudit({ actorUserId: req.user.id, action: "user.create", entityType: "user", entityId: result.rows[0].id, after: result.rows[0] });
  res.status(201).json({ user: result.rows[0] });
});

// Datos fiscales + dirección de un cliente, para que el admin los complete
// desde el panel (además del self-service del cliente en "Mis datos").
router.get("/admin/users/:id/profile", async (req, res) => {
  const r = await pool.query(`select ${PROFILE_COLUMNS} from portal.users where id = $1`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "not_found" });
  res.json({ profile: r.rows[0], complete: profileComplete(r.rows[0]) });
});

router.put("/admin/users/:id/profile", canClients, async (req, res) => {
  const exists = await pool.query(`select id from portal.users where id = $1`, [req.params.id]);
  if (!exists.rows[0]) return res.status(404).json({ error: "not_found" });
  const profile = await saveUserProfile(req.params.id, req.body?.profile || {});
  await recordAudit({ actorUserId: req.user.id, action: "user.profile.update", entityType: "user", entityId: req.params.id, after: profile });
  res.json({ profile, complete: profileComplete(profile) });
});

// Meses (YYYY-MM, zona AR) con al menos un registro de cliente.
router.get("/admin/users/months", async (req, res) => {
  const result = await pool.query(
    `select distinct to_char(created_at AT TIME ZONE '${AR_TZ}', 'YYYY-MM') as month
     from portal.users order by month desc`
  );
  res.json({ months: result.rows.map((r) => r.month) });
});

// Borrado definitivo de un cliente. Como quote_requests.user_id es RESTRICT,
// primero se borran sus cotizaciones (cascada a items/revisiones) y sesiones,
// todo en una transacción. Mismas protecciones que el PATCH: no borrarse a
// uno mismo ni al último admin.
router.delete("/admin/users/:id", canClients, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "cannot_delete_self", detail: "No podés borrar tu propia cuenta." });
  const target = await pool.query(`select id, role, status, email from portal.users where id = $1`, [req.params.id]);
  if (!target.rows[0]) return res.status(404).json({ error: "not_found" });
  if (isSuperadmin(target.rows[0].role) && target.rows[0].status === "approved") {
    const supers = await pool.query(`select count(*)::int as n from portal.users where status = 'approved' and role in ('superadmin','admin')`);
    if (supers.rows[0].n <= 1) return res.status(400).json({ error: "last_superadmin", detail: "No se puede borrar al único superadmin." });
  }
  try {
    const counts = await withTransaction(async (client) => {
      const q = await client.query(`delete from portal.quote_requests where user_id = $1 returning id`, [req.params.id]);
      await client.query(`delete from portal.users where id = $1`, [req.params.id]);
      return { quotes: q.rowCount };
    });
    await recordAudit({ actorUserId: req.user.id, action: "user.delete", entityType: "user", entityId: req.params.id, before: target.rows[0], metadata: { deletedQuotes: counts.quotes } });
    res.json({ ok: true, deletedQuotes: counts.quotes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "user_delete_failed" });
  }
});

router.patch("/admin/users/:id", canClients, async (req, res) => {
  const { status, role, rejectionReason } = req.body || {};
  if (status != null && !USER_STATUSES.includes(status)) return res.status(400).json({ error: "invalid_status" });
  if (role != null && !USER_ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });
  // Cambiar ROLES es exclusivo de superadmin (evita escalada de privilegios:
  // que un rol con clients.manage se ascienda a sí mismo o a otro).
  if (role != null && !isSuperadmin(req.user.role)) {
    return res.status(403).json({ error: "forbidden", detail: "Solo superadmin puede cambiar roles." });
  }

  const before = await pool.query(`select * from portal.users where id = $1`, [req.params.id]);
  if (!before.rows[0]) return res.status(404).json({ error: "not_found" });
  const target = before.rows[0];

  // Lockout protection: nadie puede quitarse a sí mismo el acceso al panel, y no
  // se puede dejar el portal sin ningún superadmin. Normaliza roles legacy.
  const newRole = role != null ? role : target.role;
  const newStatus = status != null ? status : target.status;
  const selfLosesPanel = target.id === req.user.id && isAdminStaff(target.role) && target.status === "approved" && (!isAdminStaff(newRole) || newStatus !== "approved");
  if (selfLosesPanel) return res.status(400).json({ error: "cannot_demote_self", detail: "No podés quitarte tu propio acceso al panel." });
  const losesSuper = isSuperadmin(target.role) && target.status === "approved" && (!isSuperadmin(newRole) || newStatus !== "approved");
  if (losesSuper) {
    const supers = await pool.query(`select count(*)::int as n from portal.users where status = 'approved' and role in ('superadmin','admin')`);
    if (supers.rows[0].n <= 1) return res.status(400).json({ error: "last_superadmin", detail: "No se puede dejar el portal sin ningún superadmin." });
  }

  const result = await pool.query(
    `update portal.users set
       status = coalesce($2, status),
       role = coalesce($3, role),
       rejection_reason = coalesce($4, rejection_reason),
       approved_at = case when $2 = 'approved' then now() else approved_at end,
       approved_by = case when $2 = 'approved' then $5 else approved_by end,
       updated_at = now()
     where id = $1
     returning *`,
    [req.params.id, status || null, role || null, rejectionReason || null, req.user.id]
  );

  await recordAudit({
    actorUserId: req.user.id,
    action: "user.update",
    entityType: "user",
    entityId: req.params.id,
    before: before.rows[0],
    after: result.rows[0]
  });
  res.json({ user: result.rows[0] });
});

// Product list for the admin editor: unlike /catalog/products this includes
// hidden/inactive products and exposes sort_order/visible for editing.
router.get("/admin/products", async (req, res) => {
  const params = [];
  let where = "p.active";
  if (req.query.search) {
    params.push(`%${req.query.search}%`);
    where += ` and (p.sku ilike $${params.length} or p.name ilike $${params.length} or p.brand ilike $${params.length})`;
  }
  if (req.query.brand) {
    params.push(req.query.brand);
    where += ` and p.brand = $${params.length}`;
  }
  if (req.query.category) {
    params.push(req.query.category);
    where += ` and p.category = $${params.length}`;
  }
  const result = await pool.query(
    `select p.id, p.sku, p.name, p.brand, p.category, p.visible, p.sort_order, p.iva_rate,
            p.image_url, p.publication_url, p.note,
            coalesce(
              jsonb_object_agg(pp.tier, jsonb_build_object('state', pp.state, 'amount', pp.amount, 'currency', pp.currency, 'label', pp.custom_label))
                filter (where pp.tier is not null),
              '{}'::jsonb
            ) as prices
     from portal.products p
     left join portal.product_prices pp on pp.product_id = p.id
     where ${where}
     group by p.id
     order by p.sort_order nulls last, p.name`,
    params
  );
  res.json({ products: result.rows });
});

// Logos de marca: mapa { marca: url } guardado en app_settings, mostrado en
// las tarjetas del catálogo del cliente.
router.get("/admin/brand-logos", async (req, res) => {
  const r = await pool.query(`select value from portal.app_settings where key = 'brand_logos'`);
  res.json({ logos: r.rows[0]?.value || {} });
});

router.put("/admin/brand-logos", canCatalog, async (req, res) => {
  const incoming = req.body?.logos && typeof req.body.logos === "object" ? req.body.logos : {};
  // Normaliza: sólo entradas con URL no vacía.
  const logos = {};
  for (const [brand, url] of Object.entries(incoming)) {
    const u = String(url ?? "").trim();
    if (u) logos[String(brand).trim()] = u;
  }
  await pool.query(
    `insert into portal.app_settings (key, value, description, updated_by, updated_at)
     values ('brand_logos', $1, 'Logos de marca para el catálogo', $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(logos), req.user.id]
  );
  await recordAudit({ actorUserId: req.user.id, action: "brand_logos.update", entityType: "app_settings", entityId: "brand_logos", after: logos });
  res.json({ logos });
});

// Marcas y categorías existentes (de productos activos), para poblar filtros y
// comboboxes del editor de catálogo.
// Ordena rows por un orden manual guardado (array de nombres); el resto va al
// final con fallbackCmp. Compartido con el orden que ve el cliente.
function orderByManual(rows, key, orderArr, fallbackCmp) {
  const pos = new Map((orderArr || []).map((name, i) => [name, i]));
  return rows.slice().sort((a, b) => {
    const pa = pos.has(a[key]) ? pos.get(a[key]) : Infinity;
    const pb = pos.has(b[key]) ? pos.get(b[key]) : Infinity;
    if (pa !== pb) return pa - pb;
    return fallbackCmp(a, b);
  });
}

router.get("/admin/catalog/meta", async (req, res) => {
  const [brands, categories, bOrder, cOrder] = await Promise.all([
    pool.query(`select brand, count(*)::int as n from portal.products where active group by brand`),
    pool.query(`select category, count(*)::int as n from portal.products where active group by category`),
    pool.query(`select value from portal.app_settings where key = 'brand_order'`),
    pool.query(`select value from portal.app_settings where key = 'category_order'`)
  ]);
  res.json({
    brands: orderByManual(brands.rows, "brand", bOrder.rows[0]?.value, (a, b) => a.brand.localeCompare(b.brand, "es")),
    categories: orderByManual(categories.rows, "category", cOrder.rows[0]?.value, (a, b) => b.n - a.n || a.category.localeCompare(b.category, "es"))
  });
});

// Guarda el orden manual de marcas y/o categorías (arrays de nombres) en
// app_settings. Aditivo, sin migración; se refleja en el catálogo del cliente.
router.put("/admin/catalog/order", canCatalog, async (req, res) => {
  const brands = Array.isArray(req.body?.brands) ? req.body.brands.map((x) => String(x).trim()).filter(Boolean) : null;
  const categories = Array.isArray(req.body?.categories) ? req.body.categories.map((x) => String(x).trim()).filter(Boolean) : null;
  if (!brands && !categories) return res.status(400).json({ error: "nothing_to_save" });
  const save = async (key, arr, description) => {
    await pool.query(
      `insert into portal.app_settings (key, value, description, updated_by, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, JSON.stringify(arr), description, req.user.id]
    );
  };
  if (brands) await save("brand_order", brands, "Orden manual de marcas en el catálogo");
  if (categories) await save("category_order", categories, "Orden manual de categorías en el catálogo");
  await recordAudit({ actorUserId: req.user.id, action: "catalog.order.update", entityType: "app_settings", entityId: "catalog_order", after: { brands: !!brands, categories: !!categories } });
  res.json({ ok: true });
});

// Reordenamiento por drag-and-drop. Recibe el nuevo orden (de arriba a abajo)
// del subconjunto que se está viendo; se intercala en el orden global (por
// sort_order, name) reemplazando las posiciones que ocupaban esos productos, y
// se renumera todo densamente. Así el orden arrastrado persiste sin colisiones
// y los productos fuera del filtro conservan su posición relativa.
router.put("/admin/products/order", canCatalog, async (req, res) => {
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
  if (!orderedIds.length) return res.status(400).json({ error: "empty" });
  if (!orderedIds.every((id) => UUID_RE.test(String(id)))) return res.status(400).json({ error: "invalid_id" });
  try {
    await withTransaction(async (client) => {
      const all = await client.query(`select id from portal.products where active order by sort_order nulls last, name`);
      const globalIds = all.rows.map((r) => r.id);
      const subset = orderedIds.filter((id) => globalIds.includes(id));
      const subsetSet = new Set(subset);
      let k = 0;
      const newOrder = globalIds.map((id) => (subsetSet.has(id) ? subset[k++] : id));
      await client.query(
        `update portal.products as p
         set sort_order = v.ord, updated_at = now()
         from unnest($1::uuid[]) with ordinality as v(id, ord)
         where p.id = v.id`,
        [newOrder]
      );
    });
    await recordAudit({ actorUserId: req.user.id, action: "product.reorder", entityType: "product", metadata: { count: orderedIds.length } });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "reorder_failed" });
  }
});

// --- D2: gestión de marcas y categorías -----------------------------------
// Renombrar/fusionar una marca: pasa todos los productos de `from` a `to`. Si
// `to` ya existe, es una fusión. Migra también el logo de marca (si el destino
// no tenía uno propio) y elimina la clave vieja del mapa de logos.
router.post("/admin/catalog/rename-brand", canCatalog, async (req, res) => {
  const from = String(req.body?.from ?? "").trim();
  const to = String(req.body?.to ?? "").trim();
  if (!from || !to) return res.status(400).json({ error: "from_and_to_required" });
  if (from === to) return res.json({ updated: 0 });
  try {
    const result = await withTransaction(async (client) => {
      const upd = await client.query(
        `update portal.products set brand = $2, updated_by = $3, updated_at = now() where brand = $1`,
        [from, to, req.user.id]
      );
      const lg = await client.query(`select value from portal.app_settings where key = 'brand_logos'`);
      const logos = lg.rows[0]?.value || {};
      if (logos[from] !== undefined) {
        if (!logos[to]) logos[to] = logos[from];
        delete logos[from];
        await client.query(
          `insert into portal.app_settings (key, value, description, updated_by, updated_at)
           values ('brand_logos', $1, 'Logos de marca para el catálogo', $2, now())
           on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
          [JSON.stringify(logos), req.user.id]
        );
      }
      return { updated: upd.rowCount };
    });
    await recordAudit({ actorUserId: req.user.id, action: "brand.rename", entityType: "product", metadata: { from, to, count: result.updated } });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "rename_brand_failed", detail: error.message });
  }
});

// Renombrar/fusionar una categoría (mismo criterio que la marca).
router.post("/admin/catalog/rename-category", canCatalog, async (req, res) => {
  const from = String(req.body?.from ?? "").trim();
  const to = String(req.body?.to ?? "").trim();
  if (!from || !to) return res.status(400).json({ error: "from_and_to_required" });
  if (from === to) return res.json({ updated: 0 });
  try {
    const upd = await pool.query(
      `update portal.products set category = $2, updated_by = $3, updated_at = now() where category = $1`,
      [from, to, req.user.id]
    );
    await recordAudit({ actorUserId: req.user.id, action: "category.rename", entityType: "product", metadata: { from, to, count: upd.rowCount } });
    res.json({ updated: upd.rowCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "rename_category_failed", detail: error.message });
  }
});

// Reasignación masiva: cambia marca y/o categoría de un conjunto de productos
// (selección múltiple en el editor). Sólo se aplican los campos provistos.
router.post("/admin/products/bulk-assign", canCatalog, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: "empty" });
  if (!ids.every((id) => UUID_RE.test(id))) return res.status(400).json({ error: "invalid_id" });
  const brand = req.body?.brand === undefined ? "" : String(req.body.brand).trim();
  const category = req.body?.category === undefined ? "" : String(req.body.category).trim();
  if (!brand && !category) return res.status(400).json({ error: "nothing_to_assign" });
  try {
    const sets = [];
    const params = [ids];
    if (brand) { params.push(brand); sets.push(`brand = $${params.length}`); }
    if (category) { params.push(category); sets.push(`category = $${params.length}`); }
    params.push(req.user.id);
    const upd = await pool.query(
      `update portal.products set ${sets.join(", ")}, updated_by = $${params.length}, updated_at = now() where id = any($1::uuid[])`,
      params
    );
    await recordAudit({ actorUserId: req.user.id, action: "product.bulk_assign", entityType: "product", metadata: { count: upd.rowCount, brand: brand || null, category: category || null, ids } });
    res.json({ updated: upd.rowCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "bulk_assign_failed", detail: error.message });
  }
});

// Create a product from the admin catalog editor. Prices (one/four/eight)
// are optional; each provided tier is written to portal.product_prices in
// the same transaction. SKU is normalized the same way the legacy importer
// does, so it lines up with the stock source's SKU column.
router.post("/admin/products", canCatalog, async (req, res) => {
  const { sku, name, brand, category, imageUrl, publicationUrl, note, visible, sortOrder, prices, ivaRate } = req.body || {};
  if (!sku || !String(sku).trim()) return res.status(400).json({ error: "sku_required" });
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name_required" });
  const sortCheck = asNumber(sortOrder);
  if (!sortCheck.ok) return res.status(400).json({ error: "invalid_number", field: "sortOrder" });
  const ivaCheck = asNumber(ivaRate);
  if (!ivaCheck.ok) return res.status(400).json({ error: "invalid_number", field: "ivaRate" });
  for (const tier of TIERS) {
    const p = prices?.[tier];
    if (p && p.amount != null && !asNumber(p.amount).ok) return res.status(400).json({ error: "invalid_number", field: tier });
    if (p && p.state && !PRICE_STATES.includes(p.state)) return res.status(400).json({ error: "invalid_price_state", field: tier });
  }
  const skuNormalized = normalizeSku(sku);

  try {
    const product = await withTransaction(async (client) => {
      const existing = await client.query(`select id, active from portal.products where sku_normalized = $1`, [skuNormalized]);
      if (existing.rows[0]) {
        // Reactivate a previously soft-deleted product instead of failing on
        // the unique(sku_normalized) constraint. Also refreshes the visible
        // sku text (sku_normalized stays fixed so stock/quote joins hold).
        const revived = await client.query(
          `update portal.products set active = true, sku = $2, name = $3, brand = coalesce($4, brand),
             category = coalesce($5, category), image_url = $6, publication_url = $7, note = $8,
             visible = coalesce($9, visible), sort_order = coalesce($10, sort_order), iva_rate = coalesce($12, iva_rate),
             updated_by = $11, updated_at = now()
           where sku_normalized = $1 returning *`,
          [skuNormalized, String(sku).trim(), name, brand || null, category || null, imageUrl || null, publicationUrl || null, note || null,
           visible === undefined ? null : Boolean(visible), sortCheck.value, req.user.id, ivaCheck.value]
        );
        return revived.rows[0];
      }
      const inserted = await client.query(
        `insert into portal.products (sku, sku_normalized, name, brand, category, image_url, publication_url, note, visible, sort_order, iva_rate, created_by, updated_by)
         values ($1,$2,$3,coalesce($4,'OTRAS MARCAS'),coalesce($5,'Sin categoría'),$6,$7,$8,coalesce($9,true),coalesce($10,9999),coalesce($11,10.5),$12,$12)
         returning *`,
        [String(sku).trim(), skuNormalized, name, brand || null, category || null, imageUrl || null, publicationUrl || null,
         note || null, visible === undefined ? null : Boolean(visible), sortCheck.value, ivaCheck.value, req.user.id]
      );
      const row = inserted.rows[0];
      for (const tier of TIERS) {
        const p = prices?.[tier];
        if (!p) continue;
        await client.query(
          `insert into portal.product_prices (product_id, tier, state, amount, currency, custom_label, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [row.id, tier, p.state || "value", p.amount ?? null, p.currency || "ARS", p.label || null, req.user.id]
        );
      }
      return row;
    });

    await recordAudit({ actorUserId: req.user.id, action: "product.create", entityType: "product", entityId: product.id, after: product });
    res.status(201).json({ product });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "product_create_failed", detail: error.message });
  }
});

router.patch("/admin/products/:id", canCatalog, async (req, res) => {
  const { sku, sortOrder, visible, name, brand, category, imageUrl, publicationUrl, note, ivaRate } = req.body || {};
  const sortCheck = asNumber(sortOrder);
  if (!sortCheck.ok) return res.status(400).json({ error: "invalid_number", field: "sortOrder" });
  const ivaCheck = asNumber(ivaRate);
  if (!ivaCheck.ok) return res.status(400).json({ error: "invalid_number", field: "ivaRate" });

  const before = await pool.query(`select * from portal.products where id = $1`, [req.params.id]);
  if (!before.rows[0]) return res.status(404).json({ error: "not_found" });

  // Editing the visible SKU also recomputes sku_normalized (the stock/quote
  // join key) so the two never drift apart; a normalized collision with
  // another product is rejected rather than violating the unique constraint.
  let newSku = null;
  let newNormalized = null;
  if (sku != null && String(sku).trim() && normalizeSku(sku) !== before.rows[0].sku_normalized) {
    newSku = String(sku).trim();
    newNormalized = normalizeSku(sku);
    const clash = await pool.query(`select 1 from portal.products where sku_normalized = $1 and id <> $2`, [newNormalized, req.params.id]);
    if (clash.rows[0]) return res.status(409).json({ error: "sku_already_exists", detail: `Ya existe otro producto con SKU ${newSku}.` });
  } else if (sku != null && String(sku).trim()) {
    newSku = String(sku).trim(); // same normalized, just refresh the visible text
  }

  const result = await pool.query(
    `update portal.products set
       sku = coalesce($11, sku),
       sku_normalized = coalesce($12, sku_normalized),
       sort_order = coalesce($2, sort_order),
       visible = coalesce($3, visible),
       name = coalesce($4, name),
       brand = coalesce($5, brand),
       category = coalesce($6, category),
       image_url = coalesce($7, image_url),
       publication_url = coalesce($8, publication_url),
       note = coalesce($9, note),
       iva_rate = coalesce($13, iva_rate),
       updated_by = $10,
       updated_at = now()
     where id = $1
     returning *`,
    [req.params.id, sortCheck.value, visible === undefined ? null : Boolean(visible),
     name ?? null, brand ?? null, category ?? null, imageUrl ?? null, publicationUrl ?? null, note ?? null, req.user.id,
     newSku, newNormalized, ivaCheck.value]
  );

  await recordAudit({
    actorUserId: req.user.id,
    action: "product.update",
    entityType: "product",
    entityId: req.params.id,
    before: before.rows[0],
    after: result.rows[0]
  });
  res.json({ product: result.rows[0] });
});

// Soft delete: keeps the row (and any quote_items referencing it) but drops
// it from the catalog and the admin editor list. Reversible by re-creating
// the same SKU (see POST above, which revives inactive rows).
router.delete("/admin/products/:id", canCatalog, async (req, res) => {
  const before = await pool.query(`select * from portal.products where id = $1`, [req.params.id]);
  if (!before.rows[0]) return res.status(404).json({ error: "not_found" });
  await pool.query(`update portal.products set active = false, updated_by = $2, updated_at = now() where id = $1`, [req.params.id, req.user.id]);
  await recordAudit({ actorUserId: req.user.id, action: "product.delete", entityType: "product", entityId: req.params.id, before: before.rows[0] });
  res.json({ ok: true });
});

router.put("/admin/products/:id/prices/:tier", canCatalog, async (req, res) => {
  const { tier } = req.params;
  if (tier === "pvp") return res.status(400).json({ error: "pvp_is_read_only", detail: "PVP se lee en vivo desde Supabase, no se edita desde el portal." });
  if (!["one", "four", "eight"].includes(tier)) return res.status(400).json({ error: "invalid_tier" });
  const { state, amount, currency, label, reason } = req.body || {};
  if (state != null && !PRICE_STATES.includes(state)) return res.status(400).json({ error: "invalid_price_state" });
  const amountCheck = asNumber(amount);
  if (!amountCheck.ok) return res.status(400).json({ error: "invalid_number", field: "amount" });
  if ((state || "value") === "value" && amountCheck.value == null) return res.status(400).json({ error: "amount_required_for_value" });

  try {
    const result = await withTransaction(async (client) => {
      const before = await client.query(`select * from portal.product_prices where product_id = $1 and tier = $2`, [req.params.id, tier]);
      await client.query(
        `insert into portal.product_prices (product_id, tier, state, amount, currency, custom_label, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (product_id, tier) do update
           set state = excluded.state, amount = excluded.amount, currency = excluded.currency,
               custom_label = excluded.custom_label, updated_by = excluded.updated_by, updated_at = now()`,
        [req.params.id, tier, state || "value", amountCheck.value, currency || "ARS", label || null, req.user.id]
      );
      const after = await client.query(`select * from portal.product_prices where product_id = $1 and tier = $2`, [req.params.id, tier]);

      await client.query(
        `insert into portal.price_history (product_id, tier, old_data, new_data, origin, actor_user_id, reason)
         values ($1,$2,$3,$4,'admin',$5,$6)`,
        [req.params.id, tier, before.rows[0] ? JSON.stringify(before.rows[0]) : null, JSON.stringify(after.rows[0]), req.user.id, reason || null]
      );
      return after.rows[0];
    });

    await recordAudit({
      actorUserId: req.user.id,
      action: "price.update",
      entityType: "product_price",
      entityId: `${req.params.id}:${tier}`,
      after: result
    });
    res.json({ price: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "price_update_failed" });
  }
});

router.get("/admin/stock/health", async (req, res) => {
  res.json(await getStockSourceHealth());
});

router.get("/admin/stock/low", async (req, res) => {
  const productsResult = await pool.query(`select id, sku, sku_normalized, name, brand from portal.products where active and visible`);
  const stockMap = await getStockForSkus(productsResult.rows.map((row) => row.sku_normalized));
  const low = productsResult.rows
    .map((row) => ({ ...row, stock: stockMap.get(row.sku_normalized) }))
    .filter((row) => row.stock && row.stock.status !== "in_stock")
    .sort((a, b) => (a.stock.exactQty ?? -1) - (b.stock.exactQty ?? -1));
  res.json({ products: low });
});

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const AR_TZ = "America/Argentina/Buenos_Aires";

router.get("/admin/quotes", async (req, res) => {
  const params = [];
  const conditions = [];
  if (req.query.status) {
    if (!QUOTE_STATUSES.includes(req.query.status)) return res.status(400).json({ error: "invalid_status" });
    params.push(req.query.status);
    conditions.push(`q.status = $${params.length}`);
  }
  if (req.query.month) {
    if (!MONTH_RE.test(req.query.month)) return res.status(400).json({ error: "invalid_month" });
    params.push(req.query.month);
    conditions.push(`to_char(q.submitted_at AT TIME ZONE '${AR_TZ}', 'YYYY-MM') = $${params.length}`);
  }
  if (req.query.userId) {
    if (!UUID_RE.test(String(req.query.userId))) return res.status(400).json({ error: "invalid_user_id" });
    params.push(req.query.userId);
    conditions.push(`q.user_id = $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const result = await pool.query(
    `select q.*, u.email, u.display_name, u.company_name
     from portal.quote_requests q join portal.users u on u.id = q.user_id
     ${where}
     order by q.submitted_at desc limit 500`,
    params
  );
  res.json({ quotes: result.rows });
});

// Meses (YYYY-MM, zona AR) que tienen al menos una cotización, para poblar el
// selector de mes sin traer todas las filas.
router.get("/admin/quotes/months", async (req, res) => {
  const result = await pool.query(
    `select distinct to_char(submitted_at AT TIME ZONE '${AR_TZ}', 'YYYY-MM') as month
     from portal.quote_requests order by month desc`
  );
  res.json({ months: result.rows.map((r) => r.month) });
});

// Pedido mensual acumulativo: una sola fila abierta por cliente y mes.
router.post("/admin/clients/:clientId/open-order", canQuotes, async (req, res) => {
  if (!UUID_RE.test(String(req.params.clientId))) return res.status(400).json({ error: "invalid_user_id" });
  const period = /^\d{4}-\d{2}$/.test(String(req.body?.period || "")) ? String(req.body.period) : new Date().toISOString().slice(0, 7);
  const periodDate = period + "-01";
  const clientRow = (await pool.query(
    `select id, default_payment_term from portal.users where id=$1 and role='client'`,
    [req.params.clientId]
  )).rows[0];
  if (!clientRow) return res.status(404).json({ error: "client_not_found" });
  const term = PAYMENT_TERMS.includes(req.body?.paymentTerms)
    ? req.body.paymentTerms
    : (PAYMENT_TERMS.includes(clientRow.default_payment_term) ? clientRow.default_payment_term : "dias_30");
  const dueDate = computeDueDate(term, new Date().toISOString().slice(0, 10));
  const result = await pool.query(
    `insert into portal.quote_requests
       (user_id,status,assigned_admin_id,period_month,payment_terms,due_date,customer_notes)
     values ($1,'abierto',$2,$3,$4,$5,$6)
     on conflict (user_id,period_month) where status='abierto'
     do update set assigned_admin_id=coalesce(portal.quote_requests.assigned_admin_id,excluded.assigned_admin_id),
       updated_at=now()
     returning *`,
    [req.params.clientId, req.user.id, periodDate, term, dueDate, req.body?.notes || null]
  );
  const quote = result.rows[0];
  await recordAudit({ actorUserId:req.user.id, action:"order.open", entityType:"quote_request", entityId:quote.id, after:{ period, status:"abierto" } });
  await notifyQuoteEventSafe("open_order", quote.id, { version: period });
  res.status(201).json({ quote });
});

router.post("/admin/quotes/:id/close-open-order", canQuotes, async (req, res) => {
  try {
    const result = await withTransaction(async (client) => {
      const q = (await client.query(
        `select q.*, u.default_payment_term from portal.quote_requests q join portal.users u on u.id=q.user_id
         where q.id=$1 for update`, [req.params.id]
      )).rows[0];
      if (!q) throw Object.assign(new Error("not_found"), { statusCode:404 });
      if (q.status !== "abierto") throw Object.assign(new Error("pedido_no_esta_abierto"), { statusCode:409 });
      const totals = await recomputeQuoteTotals(client, q.id);
      if (totals.unpricedLines > 0) {
        throw Object.assign(new Error("faltan_precios"), { statusCode:409, detail: `${totals.unpricedLines} producto(s) sin precio` });
      }
      const term = PAYMENT_TERMS.includes(req.body?.paymentTerms)
        ? req.body.paymentTerms
        : (PAYMENT_TERMS.includes(q.payment_terms) ? q.payment_terms : (PAYMENT_TERMS.includes(q.default_payment_term) ? q.default_payment_term : "dias_30"));
      const dueDate = req.body?.dueDate || computeDueDate(term, new Date().toISOString().slice(0,10));
      const quote = (await client.query(
        `update portal.quote_requests set status='cotizacion', closed_at=now(), closed_by=$2,
           payment_terms=$3, due_date=$4, updated_at=now() where id=$1 returning *`,
        [q.id, req.user.id, term, dueDate]
      )).rows[0];
      return { quote, totals };
    });
    await recordAudit({ actorUserId:req.user.id, action:"order.close", entityType:"quote_request", entityId:req.params.id, after:{ status:"cotizacion" } });
    res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error:error.message, detail:error.detail });
    throw error;
  }
});

// Alta manual de una cotización vacía para un cliente existente (a diferencia
// de POST /api/quotes, que la arma el propio cliente desde su carrito). Nace en
// 'cotizacion' pero con assigned_admin_id seteado, para distinguir "la está
// armando el admin" de las que pide el cliente (esas quedan sin admin asignado);
// así el contador de "cotizaciones nuevas por revisar" no las cuenta. Sin items
// al crearse: el admin los agrega desde el editor de detalle (mismo POST
// .../items que ya usa para sumar productos a una cotización existente).
router.post("/admin/quotes", canQuotes, async (req, res) => {
  const { userId } = req.body || {};
  if (!userId || !UUID_RE.test(String(userId))) return res.status(400).json({ error: "invalid_user_id" });
  const user = await pool.query(`select id from portal.users where id = $1`, [userId]);
  if (!user.rows[0]) return res.status(404).json({ error: "user_not_found" });

  const result = await pool.query(
    `insert into portal.quote_requests (user_id, status, assigned_admin_id)
     values ($1, 'cotizacion', $2)
     returning *`,
    [userId, req.user.id]
  );
  await recordAudit({ actorUserId: req.user.id, action: "quote.create", entityType: "quote_request", entityId: result.rows[0].id, after: result.rows[0] });
  res.status(201).json({ quote: result.rows[0] });
});

// Borrado definitivo de una cotización (cascada a items y revisiones).
router.delete("/admin/quotes/:id", canQuotes, async (req, res) => {
  const del = await pool.query(`delete from portal.quote_requests where id = $1 returning request_number`, [req.params.id]);
  if (!del.rows[0]) return res.status(404).json({ error: "not_found" });
  await recordAudit({ actorUserId: req.user.id, action: "quote.delete", entityType: "quote_request", entityId: req.params.id, before: { request_number: del.rows[0].request_number } });
  res.json({ ok: true });
});

router.get("/admin/audit", async (req, res) => {
  const result = await pool.query(
    `select a.*, u.display_name as actor_name, u.email as actor_email
       from portal.audit_log a
       left join portal.users u on u.id = a.actor_user_id
      order by a.created_at desc
      limit 200`
  );
  res.json({ entries: result.rows });
});

// Chatter (guía §11.1): timeline de actividad de una cotización + notas internas.
// Reusa portal.audit_log (sin tabla nueva): las notas se guardan como
// action='quote.note' con metadata.text. Devuelve create/update/note/dispatch, etc.
router.get("/admin/quotes/:id/audit", async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid_id" });
  const r = await pool.query(
    `select a.id, a.action, a.before_data, a.after_data, a.metadata, a.created_at,
            u.display_name as actor_name, u.email as actor_email
       from portal.audit_log a
       left join portal.users u on u.id = a.actor_user_id
      where a.entity_type = 'quote_request' and a.entity_id = $1
      order by a.created_at asc
      limit 200`,
    [req.params.id]
  );
  res.json({ entries: r.rows });
});

router.post("/admin/quotes/:id/note", canQuotes, async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid_id" });
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty_note" });
  if (text.length > 2000) return res.status(400).json({ error: "note_too_long" });
  const exists = await pool.query(`select 1 from portal.quote_requests where id = $1`, [req.params.id]);
  if (!exists.rows[0]) return res.status(404).json({ error: "not_found" });
  await recordAudit({ actorUserId: req.user.id, action: "quote.note", entityType: "quote_request", entityId: req.params.id, metadata: { text } });
  res.status(201).json({ ok: true });
});

// Resumen liviano para el auto-refresh del panel: contadores + marca de
// tiempo del último cliente/cotización. El front lo consulta cada pocos
// segundos y, si cambió algún "latest", refresca la lista correspondiente y
// avisa. Son sólo COUNT/MAX, mucho más barato que recargar las listas.
router.get("/admin/summary", async (req, res) => {
  const r = await pool.query(`
    select
      (select count(*)::int from portal.users where status = 'pending') as pending_users,
      (select count(*)::int from portal.quote_requests where status = 'cotizacion' and assigned_admin_id is null) as pending_quotes,
      (select count(*)::int from portal.quote_requests) as total_quotes,
      (select count(*)::int from portal.users) as total_users,
      (select max(created_at) from portal.users) as latest_user_at,
      (select max(submitted_at) from portal.quote_requests) as latest_quote_at
  `);
  res.json(r.rows[0]);
});

// ------------------------------------------------------ quote editing (admin)

// Full quote for the admin editor: request + client + line items.
router.get("/admin/quotes/:id", async (req, res) => {
  const quoteResult = await pool.query(
    `select q.*, u.email, u.display_name, u.company_name
     from portal.quote_requests q join portal.users u on u.id = q.user_id
     where q.id = $1`,
    [req.params.id]
  );
  const quote = quoteResult.rows[0];
  if (!quote) return res.status(404).json({ error: "not_found" });
  const items = await pool.query(`select * from portal.quote_items where quote_request_id = $1 order by sort_order nulls last, created_at`, [req.params.id]);
  res.json({ quote, items: items.rows });
});

// Reordenar las líneas de una cotización (drag-and-drop en el editor). Recibe
// el nuevo orden completo de ids; escribe sort_order = posición. Acotado al
// quote para que no se puedan tocar items de otra cotización.
router.put("/admin/quotes/:id/items/order", canQuotes, async (req, res) => {
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map(String) : [];
  if (!orderedIds.length) return res.status(400).json({ error: "empty" });
  if (!orderedIds.every((x) => UUID_RE.test(x))) return res.status(400).json({ error: "invalid_id" });
  try {
    await pool.query(
      `update portal.quote_items as qi
       set sort_order = v.ord
       from unnest($1::uuid[]) with ordinality as v(id, ord)
       where qi.id = v.id and qi.quote_request_id = $2`,
      [orderedIds, req.params.id]
    );
    await recordAudit({ actorUserId: req.user.id, action: "quote.items.reorder", entityType: "quote_request", entityId: req.params.id, metadata: { count: orderedIds.length } });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "reorder_failed" });
  }
});

// Header-level edits: status, adjustments (discount/shipping/surcharge/tax),
// notes. Totals are recomputed from the adjustments in the same transaction.
router.patch("/admin/quotes/:id", canQuotes, async (req, res) => {
  const { status, discount, discountType, shipping, surcharge, adminNotes, publicNotes, currency, paymentTerms, dueDate } = req.body || {};
  if (discountType !== undefined && !["nominal", "percent"].includes(discountType)) {
    return res.status(400).json({ error: "invalid_discount_type" });
  }
  if (status != null && !QUOTE_STATUSES.includes(status)) return res.status(400).json({ error: "invalid_status" });
  for (const [field, v] of Object.entries({ discount, shipping, surcharge })) {
    if (v !== undefined && !asNumber(v).ok) return res.status(400).json({ error: "invalid_number", field });
  }
  try {
    const result = await withTransaction(async (client) => {
      const before = await client.query(`select * from portal.quote_requests where id = $1`, [req.params.id]);
      if (!before.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      // "Firma" del vendedor: al pasar la cotización a 'enviada' (cotización
      // enviada) queda registrado quién la cotizó (quoted_by_user_id + quoted_at).
      const nowQuoting = status === "enviada";
      await client.query(
        `update portal.quote_requests set
           status = coalesce($2, status),
           discount = coalesce($3, discount),
           discount_type = coalesce($4, discount_type),
           shipping = coalesce($5, shipping),
           surcharge = coalesce($6, surcharge),
           admin_notes = coalesce($7, admin_notes),
           public_notes = coalesce($8, public_notes),
           currency = coalesce($9, currency),
           quoted_at = case when $10 then now() else quoted_at end,
           quoted_by_user_id = case when $10 then $11 else quoted_by_user_id end,
           assigned_admin_id = coalesce(assigned_admin_id, $11),
           payment_terms = coalesce($12, payment_terms),
           due_date = coalesce($13, due_date),
           updated_at = now()
         where id = $1`,
        [req.params.id, status || null,
         discount === undefined ? null : Number(discount), discountType || null,
         shipping === undefined ? null : Number(shipping), surcharge === undefined ? null : Number(surcharge),
         adminNotes ?? null, publicNotes ?? null, currency || null, nowQuoting, req.user.id,
         paymentTerms === undefined ? null : String(paymentTerms), dueDate ? String(dueDate) : null]
      );
      const totals = await recomputeQuoteTotals(client, req.params.id);
      const after = await client.query(`select * from portal.quote_requests where id = $1`, [req.params.id]);
      return { quote: after.rows[0], totals, beforeStatus: before.rows[0].status };
    });
    await recordAudit({
      actorUserId: req.user.id, action: "quote.update", entityType: "quote_request", entityId: req.params.id,
      before: { status: result.beforeStatus }, after: { status: result.quote.status },
      metadata: { statusChanged: result.beforeStatus !== result.quote.status }
    });
    if (result.beforeStatus !== result.quote.status && result.quote.status === "enviada") {
      await notifyQuoteEventSafe("quote_sent", result.quote.id, { version: String(result.quote.quoted_at || Date.now()) });
    }
    if (result.beforeStatus !== result.quote.status && result.quote.status === "orden") {
      await notifyQuoteEventSafe("order_confirmed", result.quote.id, { version: String(result.quote.updated_at || Date.now()) });
    }
    res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: "quote_update_failed" });
  }
});

// Add a line to an existing quote. Snapshots product identity like the
// customer submit path does; quoted_unit_price defaults to the product's
// current tier price for the given quantity unless the admin overrides it.
router.post("/admin/quotes/:id/items", canQuotes, async (req, res) => {
  const { productId, quantity, unitPrice, ivaRate } = req.body || {};
  if (!productId) return res.status(400).json({ error: "product_required" });
  if (!UUID_RE.test(String(productId))) return res.status(400).json({ error: "invalid_product_id" });
  if (!asNumber(unitPrice).ok) return res.status(400).json({ error: "invalid_number", field: "unitPrice" });
  if (ivaRate !== undefined && !asNumber(ivaRate).ok) return res.status(400).json({ error: "invalid_number", field: "ivaRate" });
  const qty = Math.max(1, Math.floor(Number(quantity)) || 1);
  try {
    const item = await withTransaction(async (client) => {
      const q = await client.query(`select id from portal.quote_requests where id = $1`, [req.params.id]);
      if (!q.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      const prod = await client.query(
        `select p.id, p.sku, p.sku_normalized, p.name, p.brand, p.category, p.iva_rate,
                coalesce(jsonb_object_agg(pp.tier, jsonb_build_object('state', pp.state, 'amount', pp.amount, 'currency', pp.currency))
                  filter (where pp.tier is not null), '{}'::jsonb) as prices
         from portal.products p left join portal.product_prices pp on pp.product_id = p.id
         where p.id = $1 group by p.id`,
        [productId]
      );
      if (!prod.rows[0]) throw Object.assign(new Error("product_not_found"), { statusCode: 404 });
      const product = prod.rows[0];
      const tier = tierForQuantity(qty);
      const resolvedRate = ivaRate != null && ivaRate !== "" ? Number(ivaRate) : (product.iva_rate ?? 10.5);
      const stockMap = await getStockForSkus([product.sku_normalized]);
      const stock = stockMap.get(product.sku_normalized) || { status: "out_of_stock", exactQty: null, pvp: null };
      // Precio por defecto: resolver mayorista (tier / 15% off PVP / consultar);
      // el admin puede sobreescribir con unitPrice.
      const resolved = resolveWholesaleUnit(product.prices, stock.pvp, qty);
      const snapshot = resolved.state === "value"
        ? { state: "value", amount: resolved.amount, currency: "ARS" }
        : { state: "consult", amount: null, currency: "ARS" };
      const resolvedUnit = unitPrice != null ? Number(unitPrice) : (resolved.state === "value" ? resolved.amount : null);
      const inserted = await client.query(
        `insert into portal.quote_items
           (quote_request_id, product_id, sku_snapshot, product_name_snapshot, brand_snapshot, category_snapshot,
            quantity, pricing_tier, displayed_price_snapshot, quoted_unit_price, stock_status_at_submit, exact_stock_internal, iva_rate, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
            (select coalesce(max(sort_order), -1) + 1 from portal.quote_items where quote_request_id = $1)) returning *`,
        [req.params.id, product.id, product.sku, product.name, product.brand, product.category,
         qty, tier, JSON.stringify(snapshot), resolvedUnit, stock.status, stock.exactQty, resolvedRate]
      );
      await recomputeQuoteTotals(client, req.params.id);
      return inserted.rows[0];
    });
    await recordAudit({ actorUserId: req.user.id, action: "quote.item.add", entityType: "quote_item", entityId: item.id, after: item });
    res.status(201).json({ item });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: "quote_item_add_failed" });
  }
});

// Agrega una línea de SECCIÓN o NOTA a la cotización (guía §11.1, estilo Odoo).
// Se guardan como filas de quote_items con line_type='section'/'note' y el texto
// en product_name_snapshot; NO cuentan en los totales ni van a Logística (ambos
// filtran line_type='product'). Campos NOT NULL rellenados con placeholders.
router.post("/admin/quotes/:id/lines", canQuotes, async (req, res) => {
  const type = req.body?.type;
  const text = String(req.body?.text || "").trim();
  if (!["section", "note"].includes(type)) return res.status(400).json({ error: "invalid_line_type" });
  if (!text) return res.status(400).json({ error: "empty_text" });
  if (text.length > 500) return res.status(400).json({ error: "text_too_long" });
  try {
    const item = await withTransaction(async (client) => {
      const q = await client.query(`select id from portal.quote_requests where id = $1`, [req.params.id]);
      if (!q.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      const inserted = await client.query(
        `insert into portal.quote_items
           (quote_request_id, product_id, sku_snapshot, product_name_snapshot, quantity,
            displayed_price_snapshot, quoted_unit_price, stock_status_at_submit, iva_rate, line_type, sort_order)
         values ($1, null, '', $2, 1, '{"state":"hidden"}'::jsonb, null, 'in_stock', 0, $3,
            (select coalesce(max(sort_order), -1) + 1 from portal.quote_items where quote_request_id = $1))
         returning *`,
        [req.params.id, text, type]
      );
      return inserted.rows[0];
    });
    await recordAudit({ actorUserId: req.user.id, action: "quote.line.add", entityType: "quote_item", entityId: item.id, metadata: { type } });
    res.status(201).json({ item });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: "quote_line_add_failed" });
  }
});

// Edit a line: quantity and/or quoted unit price. Editing the price is the
// core of the admin quoting flow ("a qué precio compraría cada producto").
router.put("/admin/quotes/:id/items/:itemId", canQuotes, async (req, res) => {
  const { quantity, unitPrice, ivaRate } = req.body || {};
  if (quantity !== undefined && !asNumber(quantity).ok) return res.status(400).json({ error: "invalid_number", field: "quantity" });
  if (!asNumber(unitPrice).ok) return res.status(400).json({ error: "invalid_number", field: "unitPrice" });
  if (ivaRate !== undefined && !asNumber(ivaRate).ok) return res.status(400).json({ error: "invalid_number", field: "ivaRate" });
  try {
    const item = await withTransaction(async (client) => {
      const before = await client.query(`select * from portal.quote_items where id = $1 and quote_request_id = $2`, [req.params.itemId, req.params.id]);
      if (!before.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      const qty = quantity === undefined ? before.rows[0].quantity : Math.max(1, Math.floor(Number(quantity)) || 1);
      const tier = tierForQuantity(qty);
      const updated = await client.query(
        `update portal.quote_items set
           quantity = $3,
           pricing_tier = $4,
           quoted_unit_price = $5,
           iva_rate = $6
         where id = $1 and quote_request_id = $2 returning *`,
        [req.params.itemId, req.params.id, qty, tier,
         unitPrice === undefined ? before.rows[0].quoted_unit_price : (unitPrice === null || unitPrice === "" ? null : Number(unitPrice)),
         ivaRate === undefined || ivaRate === null || ivaRate === "" ? before.rows[0].iva_rate : Number(ivaRate)]
      );
      await recomputeQuoteTotals(client, req.params.id);
      return updated.rows[0];
    });
    await recordAudit({ actorUserId: req.user.id, action: "quote.item.update", entityType: "quote_item", entityId: req.params.itemId, after: item });
    res.json({ item });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: "quote_item_update_failed" });
  }
});

router.delete("/admin/quotes/:id/items/:itemId", canQuotes, async (req, res) => {
  try {
    await withTransaction(async (client) => {
      const del = await client.query(`delete from portal.quote_items where id = $1 and quote_request_id = $2 returning id`, [req.params.itemId, req.params.id]);
      if (!del.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      await recomputeQuoteTotals(client, req.params.id);
    });
    await recordAudit({ actorUserId: req.user.id, action: "quote.item.delete", entityType: "quote_item", entityId: req.params.itemId });
    res.json({ ok: true });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: "quote_item_delete_failed" });
  }
});

// Plantillas editables y alerta de vencimiento del certificado.
router.get("/admin/email-templates", async (_req, res) => {
  res.json({ templates: await listEmailTemplates() });
});

router.put("/admin/email-templates/:key", canCatalog, async (req, res) => {
  const key = String(req.params.key || "");
  if (!/^[a-z0-9_.-]+$/i.test(key)) return res.status(400).json({ error:"invalid_template_key" });
  const subject = String(req.body?.subject || "").trim();
  const bodyHtml = String(req.body?.bodyHtml || "").trim();
  if (!subject || !bodyHtml) return res.status(400).json({ error:"subject_and_body_required" });
  const template = await saveEmailTemplate({
    key, subject, bodyHtml, bodyText:req.body?.bodyText || null,
    variables:Array.isArray(req.body?.variables) ? req.body.variables : [], updatedBy:req.user.id
  });
  await recordAudit({ actorUserId:req.user.id, action:"email_template.update", entityType:"email_template", entityId:key });
  res.json({ template });
});

router.get("/admin/certificate-expiry", async (_req, res) => {
  const row = (await pool.query(`select value from portal.app_settings where key='certificate_expiry'`)).rows[0];
  res.json({ configuration:row?.value || {}, status:await certificateWarning() });
});

router.put("/admin/certificate-expiry", canCatalog, async (req, res) => {
  const value = {
    documentId:req.body?.documentId || null,
    expiresAt:req.body?.expiresAt || null,
    warningDays:Math.max(1, Number(req.body?.warningDays) || 30)
  };
  await pool.query(
    `insert into portal.app_settings(key,value,description,updated_by,updated_at)
     values('certificate_expiry',$1,'Certificado de exclusión de retenciones',$2,now())
     on conflict(key) do update set value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,
    [JSON.stringify(value),req.user.id]
  );
  await recordAudit({ actorUserId:req.user.id, action:"certificate_expiry.update", entityType:"app_settings", entityId:"certificate_expiry", after:value });
  res.json({ configuration:value, status:await certificateWarning() });
});

// ------------------------------------------------------ company profile

router.get("/admin/company-profile", async (req, res) => {
  res.json({ profile: await getCompanyProfile() });
});

router.put("/admin/company-profile", canCatalog, async (req, res) => {
  const incoming = req.body?.profile || {};
  const merged = { ...DEFAULT_COMPANY_PROFILE, ...incoming };
  // Normalize addressLines to an array of non-empty strings.
  if (typeof merged.addressLines === "string") merged.addressLines = merged.addressLines.split("\n");
  merged.addressLines = (merged.addressLines || []).map((l) => String(l).trim()).filter(Boolean);
  await pool.query(
    `insert into portal.app_settings (key, value, description, updated_by, updated_at)
     values ('company_profile', $1, 'Datos de la empresa para la proforma', $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(merged), req.user.id]
  );
  await recordAudit({ actorUserId: req.user.id, action: "company_profile.update", entityType: "app_settings", entityId: "company_profile", after: merged });
  res.json({ profile: merged });
});

// ---------------------------------------- notificaciones automáticas por email (§11.1)
// Un CC global + destinatarios por evento. Guardado en app_settings key
// 'email_recipients'. El compositor de envío precarga el CC según el evento.
const EMAIL_EVENTS = ["enviada", "orden", "pago", "despachado"];
async function getEmailRecipients() {
  const r = await pool.query(`select value from portal.app_settings where key = 'email_recipients'`);
  const v = r.rows[0]?.value || {};
  return { globalCc: v.globalCc || "", events: v.events || {} };
}

router.get("/admin/email-recipients", async (req, res) => {
  res.json({ recipients: await getEmailRecipients() });
});

router.put("/admin/email-recipients", canCatalog, async (req, res) => {
  const incoming = req.body?.recipients || {};
  const events = {};
  for (const ev of EMAIL_EVENTS) events[ev] = String(incoming.events?.[ev] || "").trim();
  const merged = { globalCc: String(incoming.globalCc || "").trim(), events };
  await pool.query(
    `insert into portal.app_settings (key, value, description, updated_by, updated_at)
     values ('email_recipients', $1, 'Destinatarios de avisos automaticos por email', $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(merged), req.user.id]
  );
  await recordAudit({ actorUserId: req.user.id, action: "email_recipients.update", entityType: "app_settings", entityId: "email_recipients", after: merged });
  res.json({ recipients: merged });
});

// ------------------------------------------------------ proforma (printable)

// Loads a quote + its client + items + company profile + the signer (the
// admin who quoted it, falling back to the current admin). Shared by the
// printable route and the email sender.
export async function loadProformaContext(quoteId, fallbackSigner) {
  const quoteResult = await pool.query(
    `select q.*, u.email, u.display_name, u.company_name, u.client_code,
            u.tax_cuit, u.tax_id_type, u.tax_condition,
            u.ship_street, u.ship_number, u.ship_floor, u.ship_apartment,
            u.ship_postal_code, u.ship_city, u.ship_province, u.ship_phone, u.ship_notes
     from portal.quote_requests q join portal.users u on u.id = q.user_id
     where q.id = $1`,
    [quoteId]
  );
  const quote = quoteResult.rows[0];
  if (!quote) return null;
  // La miniatura sale de la foto actual del producto (join por product_id);
  // los items snapshotean identidad y precio pero no la imagen.
  const items = await pool.query(
    `select qi.*, p.image_url, p.publication_url
     from portal.quote_items qi
     left join portal.products p on p.id = qi.product_id
     where qi.quote_request_id = $1 order by qi.sort_order nulls last, qi.created_at`,
    [quoteId]
  );
  const company = await getCompanyProfile();
  let signer = fallbackSigner;
  if (quote.quoted_by_user_id) {
    const s = await pool.query(`select display_name, email from portal.users where id = $1`, [quote.quoted_by_user_id]);
    if (s.rows[0]) signer = s.rows[0];
  }
  return { quote, items: items.rows, company, signer };
}

// Self-contained printable HTML for a quote. Admin-only (requireAdmin at the
// router level) and opened via window.open, so the session cookie gates it.
router.get("/admin/quotes/:id/proforma", async (req, res) => {
  const ctx = await loadProformaContext(req.params.id, { display_name: req.user.display_name, email: req.user.email });
  if (!ctx) return res.status(404).send("Cotización no encontrada");
  res.set("Content-Type", "text/html; charset=utf-8").send(renderProformaHtml({ ...ctx, forEmail: false }));
});

// Send the proforma to the client from the vendor's own Gmail mailbox. Requires
// the admin to have connected Gmail (incremental gmail.send consent). On
// success the quote is marked 'quoted' and signed by the sender.
router.post("/admin/quotes/:id/send-proforma", canQuotes, async (req, res) => {
  if (!req.user.gmail_connected) {
    return res.status(400).json({ error: "gmail_not_connected", detail: "Conectá tu Gmail primero para enviar desde tu casilla." });
  }
  const tokenRow = await pool.query(`select gmail_refresh_token, gmail_address from portal.users where id = $1`, [req.user.id]);
  const refreshToken = tokenRow.rows[0]?.gmail_refresh_token;
  if (!refreshToken) return res.status(400).json({ error: "gmail_not_connected" });

  // Sign + mark as quoted before rendering, so the emailed proforma carries
  // the signature and the recomputed totals.
  await withTransaction(async (client) => {
    await client.query(
      `update portal.quote_requests set status = 'enviada', quoted_at = coalesce(quoted_at, now()),
         quoted_by_user_id = $2, assigned_admin_id = coalesce(assigned_admin_id, $2), updated_at = now()
       where id = $1`,
      [req.params.id, req.user.id]
    );
    await recomputeQuoteTotals(client, req.params.id);
  });

  const ctx = await loadProformaContext(req.params.id, { display_name: req.user.display_name, email: req.user.email });
  if (!ctx) return res.status(404).json({ error: "not_found" });

  const to = (req.body?.to && String(req.body.to).trim()) || ctx.quote.email;
  // Multi-destinatario (guía §11.1): CC opcional, como array o lista separada por comas.
  const ccList = (Array.isArray(req.body?.cc) ? req.body.cc : String(req.body?.cc || "").split(","))
    .map((s) => String(s).trim()).filter(Boolean);
  const cc = ccList.length ? ccList.join(", ") : undefined;
  const html = renderProformaHtml({ ...ctx, forEmail: true });
  const term = ["orden", "despachado"].includes(ctx.quote.status) ? "Compra" : "Pre-compra";
  const subject = `${term} #${ctx.quote.request_number} - ${ctx.company.name}`;

  try {
    await sendGmail({
      refreshToken,
      from: tokenRow.rows[0].gmail_address || req.user.email,
      fromName: req.user.display_name || ctx.company.name,
      to,
      cc,
      subject,
      html,
      replyTo: req.user.email
    });
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: "gmail_send_failed", detail: error.message });
  }

  await recordAudit({ actorUserId: req.user.id, action: "quote.proforma.sent", entityType: "quote_request", entityId: req.params.id, metadata: { to, cc: ccList } });
  res.json({ ok: true, to, cc: ccList });
});

// Envía al depósito la hoja de armado (picking + dirección de entrega) desde
// la casilla del vendedor. Destinatario: warehouseEmail del perfil de empresa
// (default joaquin.guerri@) + un correo extra opcional por cotización.
router.post("/admin/quotes/:id/send-warehouse", canQuotes, async (req, res) => {
  if (!req.user.gmail_connected) {
    return res.status(400).json({ error: "gmail_not_connected", detail: "Conectá tu Gmail primero para enviar desde tu casilla." });
  }
  const tokenRow = await pool.query(`select gmail_refresh_token, gmail_address from portal.users where id = $1`, [req.user.id]);
  const refreshToken = tokenRow.rows[0]?.gmail_refresh_token;
  if (!refreshToken) return res.status(400).json({ error: "gmail_not_connected" });

  const ctx = await loadProformaContext(req.params.id, null);
  if (!ctx) return res.status(404).json({ error: "not_found" });

  const recipients = [ctx.company.warehouseEmail, req.body?.extraEmail]
    .map((e) => (e ? String(e).trim() : ""))
    .filter(Boolean);
  if (!recipients.length) return res.status(400).json({ error: "no_recipient", detail: "No hay casilla de depósito configurada." });
  const to = recipients[0];
  const cc = recipients.slice(1).join(", ") || undefined;

  const html = renderWarehouseHtml(ctx);
  const subject = `Pedido para preparar #${ctx.quote.request_number} - ${ctx.quote.company_name || ctx.quote.display_name || ctx.quote.email}`;

  try {
    await sendGmail({
      refreshToken,
      from: tokenRow.rows[0].gmail_address || req.user.email,
      fromName: req.user.display_name || ctx.company.name,
      to,
      cc,
      subject,
      html,
      replyTo: req.user.email
    });
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: "gmail_send_failed", detail: error.message });
  }

  await recordAudit({ actorUserId: req.user.id, action: "quote.warehouse.sent", entityType: "quote_request", entityId: req.params.id, metadata: { recipients } });
  res.json({ ok: true, recipients });
});

export default router;
