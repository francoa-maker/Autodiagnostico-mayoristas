import express from "express";
import { pool, withTransaction } from "../db.js";
import { requireAdmin } from "../middleware.js";
import { getStockSourceHealth, getStockForSkus } from "../stock/stockRepository.js";
import { recordAudit } from "../audit.js";
import { normalizeSku } from "../skuNormalize.js";

const router = express.Router();
router.use(requireAdmin);

// ------------------------------------------------------------------ helpers

const TIERS = ["one", "four", "eight"];

function tierForQuantity(qty) {
  if (qty >= 8) return "eight";
  if (qty >= 4) return "four";
  return "one";
}

// Recompute a quote's stored totals from its current items + adjustments.
// quoted_unit_price wins over the customer-facing displayed snapshot; only
// items with a resolvable unit price contribute to the subtotal.
async function recomputeQuoteTotals(client, quoteId) {
  const items = await client.query(
    `select quantity, quoted_unit_price, displayed_price_snapshot from portal.quote_items where quote_request_id = $1`,
    [quoteId]
  );
  let subtotal = 0;
  for (const it of items.rows) {
    const snap = it.displayed_price_snapshot || {};
    const unit = it.quoted_unit_price != null ? Number(it.quoted_unit_price) : snap.amount != null ? Number(snap.amount) : null;
    if (unit != null) subtotal += unit * Number(it.quantity);
  }
  const q = await client.query(
    `select discount, shipping, surcharge, tax from portal.quote_requests where id = $1`,
    [quoteId]
  );
  const row = q.rows[0] || {};
  const total = subtotal - Number(row.discount || 0) + Number(row.shipping || 0) + Number(row.surcharge || 0) + Number(row.tax || 0);
  await client.query(
    `update portal.quote_requests set quoted_subtotal = $2, quoted_total = $3, updated_at = now() where id = $1`,
    [quoteId, subtotal, total]
  );
  return { quotedSubtotal: subtotal, quotedTotal: total };
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
  proformaValidityDays: 7
};

async function getCompanyProfile() {
  const result = await pool.query(`select value from portal.app_settings where key = 'company_profile'`);
  return { ...DEFAULT_COMPANY_PROFILE, ...(result.rows[0]?.value || {}) };
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMoney(amount, currency = "ARS") {
  if (amount === null || amount === undefined || amount === "") return "-";
  const prefix = currency === "USD" ? "US$ " : "$ ";
  return prefix + Number(amount).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

router.get("/admin/users", async (req, res) => {
  const params = [];
  let where = "true";
  if (req.query.status) {
    params.push(req.query.status);
    where = `status = $${params.length}`;
  }
  const result = await pool.query(
    `select id, email, display_name, company_name, role, status, created_at, last_login_at
     from portal.users where ${where} order by created_at desc`,
    params
  );
  res.json({ users: result.rows });
});

router.patch("/admin/users/:id", async (req, res) => {
  const { status, role, rejectionReason } = req.body || {};
  const before = await pool.query(`select * from portal.users where id = $1`, [req.params.id]);
  if (!before.rows[0]) return res.status(404).json({ error: "not_found" });

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
  const result = await pool.query(
    `select p.id, p.sku, p.name, p.brand, p.category, p.visible, p.sort_order,
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

// Create a product from the admin catalog editor. Prices (one/four/eight)
// are optional; each provided tier is written to portal.product_prices in
// the same transaction. SKU is normalized the same way the legacy importer
// does, so it lines up with the stock source's SKU column.
router.post("/admin/products", async (req, res) => {
  const { sku, name, brand, category, imageUrl, publicationUrl, note, visible, sortOrder, prices } = req.body || {};
  if (!sku || !String(sku).trim()) return res.status(400).json({ error: "sku_required" });
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name_required" });
  const skuNormalized = normalizeSku(sku);

  try {
    const product = await withTransaction(async (client) => {
      const existing = await client.query(`select id, active from portal.products where sku_normalized = $1`, [skuNormalized]);
      if (existing.rows[0]) {
        // Reactivate a previously soft-deleted product instead of failing on
        // the unique(sku_normalized) constraint.
        const revived = await client.query(
          `update portal.products set active = true, name = $2, brand = coalesce($3, brand),
             category = coalesce($4, category), image_url = $5, publication_url = $6, note = $7,
             visible = coalesce($8, visible), sort_order = coalesce($9, sort_order), updated_by = $10, updated_at = now()
           where sku_normalized = $1 returning *`,
          [skuNormalized, name, brand || null, category || null, imageUrl || null, publicationUrl || null, note || null,
           visible === undefined ? null : Boolean(visible), sortOrder === undefined ? null : Number(sortOrder), req.user.id]
        );
        return revived.rows[0];
      }
      const inserted = await client.query(
        `insert into portal.products (sku, sku_normalized, name, brand, category, image_url, publication_url, note, visible, sort_order, created_by, updated_by)
         values ($1,$2,$3,coalesce($4,'OTRAS MARCAS'),coalesce($5,'Sin categoría'),$6,$7,$8,coalesce($9,true),coalesce($10,9999),$11,$11)
         returning *`,
        [String(sku).trim(), skuNormalized, name, brand || null, category || null, imageUrl || null, publicationUrl || null,
         note || null, visible === undefined ? null : Boolean(visible), sortOrder === undefined ? null : Number(sortOrder), req.user.id]
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

router.patch("/admin/products/:id", async (req, res) => {
  const { sortOrder, visible, name, brand, category, imageUrl, publicationUrl, note } = req.body || {};
  const before = await pool.query(`select * from portal.products where id = $1`, [req.params.id]);
  if (!before.rows[0]) return res.status(404).json({ error: "not_found" });

  const result = await pool.query(
    `update portal.products set
       sort_order = coalesce($2, sort_order),
       visible = coalesce($3, visible),
       name = coalesce($4, name),
       brand = coalesce($5, brand),
       category = coalesce($6, category),
       image_url = coalesce($7, image_url),
       publication_url = coalesce($8, publication_url),
       note = coalesce($9, note),
       updated_by = $10,
       updated_at = now()
     where id = $1
     returning *`,
    [req.params.id, sortOrder === undefined ? null : Number(sortOrder), visible === undefined ? null : Boolean(visible),
     name ?? null, brand ?? null, category ?? null, imageUrl ?? null, publicationUrl ?? null, note ?? null, req.user.id]
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
router.delete("/admin/products/:id", async (req, res) => {
  const before = await pool.query(`select * from portal.products where id = $1`, [req.params.id]);
  if (!before.rows[0]) return res.status(404).json({ error: "not_found" });
  await pool.query(`update portal.products set active = false, updated_by = $2, updated_at = now() where id = $1`, [req.params.id, req.user.id]);
  await recordAudit({ actorUserId: req.user.id, action: "product.delete", entityType: "product", entityId: req.params.id, before: before.rows[0] });
  res.json({ ok: true });
});

router.put("/admin/products/:id/prices/:tier", async (req, res) => {
  const { tier } = req.params;
  if (tier === "pvp") return res.status(400).json({ error: "pvp_is_read_only", detail: "PVP se lee en vivo desde Supabase, no se edita desde el portal." });
  if (!["one", "four", "eight"].includes(tier)) return res.status(400).json({ error: "invalid_tier" });
  const { state, amount, currency, label, reason } = req.body || {};

  try {
    const result = await withTransaction(async (client) => {
      const before = await client.query(`select * from portal.product_prices where product_id = $1 and tier = $2`, [req.params.id, tier]);
      await client.query(
        `insert into portal.product_prices (product_id, tier, state, amount, currency, custom_label, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (product_id, tier) do update
           set state = excluded.state, amount = excluded.amount, currency = excluded.currency,
               custom_label = excluded.custom_label, updated_by = excluded.updated_by, updated_at = now()`,
        [req.params.id, tier, state || "value", amount ?? null, currency || "ARS", label || null, req.user.id]
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

router.get("/admin/quotes", async (req, res) => {
  const result = await pool.query(
    `select q.*, u.email, u.display_name, u.company_name
     from portal.quote_requests q join portal.users u on u.id = q.user_id
     order by q.submitted_at desc limit 200`
  );
  res.json({ quotes: result.rows });
});

router.get("/admin/audit", async (req, res) => {
  const result = await pool.query(`select * from portal.audit_log order by created_at desc limit 200`);
  res.json({ entries: result.rows });
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
  const items = await pool.query(`select * from portal.quote_items where quote_request_id = $1 order by created_at`, [req.params.id]);
  res.json({ quote, items: items.rows });
});

// Header-level edits: status, adjustments (discount/shipping/surcharge/tax),
// notes. Totals are recomputed from the adjustments in the same transaction.
router.patch("/admin/quotes/:id", async (req, res) => {
  const { status, discount, shipping, surcharge, tax, adminNotes, publicNotes, currency } = req.body || {};
  try {
    const result = await withTransaction(async (client) => {
      const before = await client.query(`select * from portal.quote_requests where id = $1`, [req.params.id]);
      if (!before.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      await client.query(
        `update portal.quote_requests set
           status = coalesce($2, status),
           discount = coalesce($3, discount),
           shipping = coalesce($4, shipping),
           surcharge = coalesce($5, surcharge),
           tax = coalesce($6, tax),
           admin_notes = coalesce($7, admin_notes),
           public_notes = coalesce($8, public_notes),
           currency = coalesce($9, currency),
           quoted_at = case when $2 = 'quoted' then now() else quoted_at end,
           assigned_admin_id = coalesce(assigned_admin_id, $10),
           updated_at = now()
         where id = $1`,
        [req.params.id, status || null,
         discount === undefined ? null : Number(discount), shipping === undefined ? null : Number(shipping),
         surcharge === undefined ? null : Number(surcharge), tax === undefined ? null : Number(tax),
         adminNotes ?? null, publicNotes ?? null, currency || null, req.user.id]
      );
      const totals = await recomputeQuoteTotals(client, req.params.id);
      const after = await client.query(`select * from portal.quote_requests where id = $1`, [req.params.id]);
      return { quote: after.rows[0], totals };
    });
    await recordAudit({ actorUserId: req.user.id, action: "quote.update", entityType: "quote_request", entityId: req.params.id, after: result.quote });
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
router.post("/admin/quotes/:id/items", async (req, res) => {
  const { productId, quantity, unitPrice } = req.body || {};
  const qty = Math.max(1, Math.floor(Number(quantity)) || 1);
  if (!productId) return res.status(400).json({ error: "product_required" });
  try {
    const item = await withTransaction(async (client) => {
      const q = await client.query(`select id from portal.quote_requests where id = $1`, [req.params.id]);
      if (!q.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      const prod = await client.query(
        `select p.id, p.sku, p.sku_normalized, p.name, p.brand, p.category,
                coalesce(jsonb_object_agg(pp.tier, jsonb_build_object('state', pp.state, 'amount', pp.amount, 'currency', pp.currency))
                  filter (where pp.tier is not null), '{}'::jsonb) as prices
         from portal.products p left join portal.product_prices pp on pp.product_id = p.id
         where p.id = $1 group by p.id`,
        [productId]
      );
      if (!prod.rows[0]) throw Object.assign(new Error("product_not_found"), { statusCode: 404 });
      const product = prod.rows[0];
      const tier = tierForQuantity(qty);
      const tierPrice = product.prices?.[tier] || null;
      const resolvedUnit = unitPrice != null ? Number(unitPrice) : tierPrice?.amount != null ? Number(tierPrice.amount) : null;
      const stockMap = await getStockForSkus([product.sku_normalized]);
      const stock = stockMap.get(product.sku_normalized) || { status: "out_of_stock", exactQty: null };
      const inserted = await client.query(
        `insert into portal.quote_items
           (quote_request_id, product_id, sku_snapshot, product_name_snapshot, brand_snapshot, category_snapshot,
            quantity, pricing_tier, displayed_price_snapshot, quoted_unit_price, stock_status_at_submit, exact_stock_internal)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [req.params.id, product.id, product.sku, product.name, product.brand, product.category,
         qty, tier, JSON.stringify(tierPrice || {}), resolvedUnit, stock.status, stock.exactQty]
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

// Edit a line: quantity and/or quoted unit price. Editing the price is the
// core of the admin quoting flow ("a qué precio compraría cada producto").
router.put("/admin/quotes/:id/items/:itemId", async (req, res) => {
  const { quantity, unitPrice } = req.body || {};
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
           quoted_unit_price = $5
         where id = $1 and quote_request_id = $2 returning *`,
        [req.params.itemId, req.params.id, qty, tier,
         unitPrice === undefined ? before.rows[0].quoted_unit_price : (unitPrice === null || unitPrice === "" ? null : Number(unitPrice))]
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

router.delete("/admin/quotes/:id/items/:itemId", async (req, res) => {
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

// ------------------------------------------------------ company profile

router.get("/admin/company-profile", async (req, res) => {
  res.json({ profile: await getCompanyProfile() });
});

router.put("/admin/company-profile", async (req, res) => {
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

// ------------------------------------------------------ proforma (printable)

// Self-contained printable HTML for a quote. Admin-only (requireAdmin at the
// router level) and opened via window.open, so the session cookie gates it.
router.get("/admin/quotes/:id/proforma", async (req, res) => {
  const quoteResult = await pool.query(
    `select q.*, u.email, u.display_name, u.company_name
     from portal.quote_requests q join portal.users u on u.id = q.user_id
     where q.id = $1`,
    [req.params.id]
  );
  const quote = quoteResult.rows[0];
  if (!quote) return res.status(404).send("Cotización no encontrada");
  const items = await pool.query(`select * from portal.quote_items where quote_request_id = $1 order by created_at`, [req.params.id]);
  const company = await getCompanyProfile();
  const currency = quote.currency || "ARS";

  const rows = items.rows
    .map((it) => {
      const snap = it.displayed_price_snapshot || {};
      const unit = it.quoted_unit_price != null ? Number(it.quoted_unit_price) : snap.amount != null ? Number(snap.amount) : null;
      const lineTotal = unit != null ? unit * Number(it.quantity) : null;
      return `<tr>
        <td class="desc"><span class="sku">[${esc(it.sku_snapshot)}]</span> ${esc(it.product_name_snapshot)}${it.brand_snapshot ? ` <span class="brand">${esc(it.brand_snapshot)}</span>` : ""}</td>
        <td class="num">${Number(it.quantity)}</td>
        <td class="num">${unit != null ? fmtMoney(unit, currency) : "-"}</td>
        <td class="num total">${lineTotal != null ? fmtMoney(lineTotal, currency) : "-"}</td>
      </tr>`;
    })
    .join("");

  const subtotal = quote.quoted_subtotal != null ? Number(quote.quoted_subtotal) : Number(quote.displayed_subtotal || 0);
  const discount = Number(quote.discount || 0);
  const shipping = Number(quote.shipping || 0);
  const surcharge = Number(quote.surcharge || 0);
  const tax = Number(quote.tax || 0);
  const total = quote.quoted_total != null ? Number(quote.quoted_total) : subtotal - discount + shipping + surcharge + tax;

  const adjRow = (label, value, sign) =>
    value ? `<tr><td class="lbl">${label}</td><td class="num">${sign}${fmtMoney(Math.abs(value), currency)}</td></tr>` : "";

  const logo = company.logoUrl
    ? `<img src="${esc(company.logoUrl)}" alt="${esc(company.name)}" class="logo-img">`
    : `<div class="logo-text">Auto<span>diagnostico</span></div>`;

  const dateStr = new Date(quote.submitted_at).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proforma #${quote.request_number} - ${esc(company.name)}</title>
<style>
  :root{--red:#c8102e;--ink:#1a1a1a;--muted:#777;--line:#e2e2e2}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:var(--ink);background:#f3f4f6;padding:24px}
  .sheet{max-width:820px;margin:0 auto;background:#fff;padding:44px 48px;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  .toolbar{max-width:820px;margin:0 auto 16px;display:flex;gap:10px;justify-content:flex-end}
  .toolbar button{background:var(--red);color:#fff;border:none;padding:10px 20px;border-radius:7px;font-size:14px;cursor:pointer;font-weight:600}
  .toolbar button.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--ink);padding-bottom:22px;margin-bottom:26px}
  .logo-img{max-height:64px;max-width:280px}
  .logo-text{font-size:30px;font-weight:800;letter-spacing:-.5px;color:var(--ink)}
  .logo-text span{color:var(--red)}
  .company{text-align:right;font-size:12px;color:var(--muted);line-height:1.55}
  .company .cname{font-size:14px;color:var(--ink);font-weight:700}
  .meta-row{display:flex;justify-content:space-between;gap:32px;margin-bottom:26px}
  .bill-to{font-size:12.5px;line-height:1.6}
  .bill-to .lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:5px}
  .bill-to .cname{font-weight:700;font-size:13.5px}
  h1{font-size:24px;font-weight:800;margin-bottom:4px}
  .docmeta{font-size:12px;color:var(--muted);text-align:right;line-height:1.7}
  .docmeta b{color:var(--ink)}
  table.items{width:100%;border-collapse:collapse;margin-bottom:8px}
  table.items thead th{background:var(--ink);color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:9px 12px;text-align:left}
  table.items thead th.num{text-align:right}
  table.items tbody td{padding:11px 12px;border-bottom:1px solid var(--line);font-size:12.5px;vertical-align:top}
  table.items td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  table.items td.total{font-weight:600}
  .desc .sku{color:var(--muted);font-family:ui-monospace,monospace;font-size:11.5px}
  .desc .brand{color:var(--muted);font-size:11px;border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-left:4px}
  .totals{display:flex;justify-content:flex-end;margin-top:14px}
  .totals table{min-width:280px;border-collapse:collapse}
  .totals td{padding:6px 12px;font-size:13px}
  .totals td.lbl{color:var(--muted)}
  .totals td.num{text-align:right;font-variant-numeric:tabular-nums}
  .totals tr.grand td{background:var(--red);color:#fff;font-weight:700;font-size:15px;padding:11px 12px}
  .notes{margin-top:26px;font-size:12px;color:var(--muted);line-height:1.6;border-top:1px solid var(--line);padding-top:16px}
  .footer{margin-top:30px;text-align:center;font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:14px}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;padding:24px 8px;max-width:none}.toolbar{display:none}}
</style></head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">Imprimir / Guardar PDF</button>
    <button class="ghost" onclick="window.close()">Cerrar</button>
  </div>
  <div class="sheet">
    <div class="head">
      <div>${logo}</div>
      <div class="company">
        <div class="cname">${esc(company.legalName || company.name)}</div>
        ${company.addressLines.map((l) => `<div>${esc(l)}</div>`).join("")}
        ${company.phone ? `<div>Tel: ${esc(company.phone)}</div>` : ""}
        ${company.email ? `<div>${esc(company.email)}</div>` : ""}
        ${company.website ? `<div>${esc(company.website)}</div>` : ""}
        ${company.taxId ? `<div>CUIT: ${esc(company.taxId)}</div>` : ""}
      </div>
    </div>

    <div class="meta-row">
      <div class="bill-to">
        <div class="lbl">Cliente</div>
        <div class="cname">${esc(quote.company_name || quote.display_name || quote.email)}</div>
        ${quote.display_name && quote.company_name ? `<div>${esc(quote.display_name)}</div>` : ""}
        <div>${esc(quote.email)}</div>
      </div>
      <div>
        <h1>Proforma</h1>
        <div class="docmeta">
          <div>N° <b>#${quote.request_number}</b></div>
          <div>Fecha: <b>${esc(dateStr)}</b></div>
          <div>Moneda: <b>${esc(currency)}</b></div>
          ${company.proformaValidityDays ? `<div>Validez: <b>${Number(company.proformaValidityDays)} días</b></div>` : ""}
        </div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>Descripción</th><th class="num">Cantidad</th><th class="num">Precio unit.</th><th class="num">Importe</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:#999;padding:24px">Sin items</td></tr>'}</tbody>
    </table>

    <div class="totals">
      <table>
        <tr><td class="lbl">Subtotal</td><td class="num">${fmtMoney(subtotal, currency)}</td></tr>
        ${adjRow("Descuento", discount, "-")}
        ${adjRow("Envío", shipping, "+")}
        ${adjRow("Recargo", surcharge, "+")}
        ${adjRow("Impuestos", tax, "+")}
        <tr class="grand"><td>Total</td><td class="num">${fmtMoney(total, currency)}</td></tr>
      </table>
    </div>

    ${quote.public_notes ? `<div class="notes"><b>Notas:</b> ${esc(quote.public_notes)}</div>` : ""}
    <div class="footer">${esc(company.proformaFooter || "")}</div>
  </div>
</body></html>`;

  res.set("Content-Type", "text/html; charset=utf-8").send(html);
});

export default router;
