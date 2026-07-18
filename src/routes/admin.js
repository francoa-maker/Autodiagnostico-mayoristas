import express from "express";
import { pool, withTransaction } from "../db.js";
import { requireAdmin } from "../middleware.js";
import { getStockSourceHealth, getStockForSkus } from "../stock/stockRepository.js";
import { recordAudit } from "../audit.js";
import { normalizeSku } from "../skuNormalize.js";
import { computeQuoteTotals } from "../quoteTotals.js";
import { renderProformaHtml } from "../proforma.js";
import { sendGmail } from "../mailer.js";

const router = express.Router();
router.use(requireAdmin);

// ------------------------------------------------------------------ helpers

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
    `select quantity, quoted_unit_price, displayed_price_snapshot from portal.quote_items where quote_request_id = $1`,
    [quoteId]
  );
  const q = await client.query(
    `select discount, discount_type, shipping, surcharge, iva_rate from portal.quote_requests where id = $1`,
    [quoteId]
  );
  const row = q.rows[0] || {};
  const totals = computeQuoteTotals({
    items: items.rows,
    discount: row.discount,
    discountType: row.discount_type,
    shipping: row.shipping,
    surcharge: row.surcharge,
    ivaRate: row.iva_rate
  });
  await client.query(
    `update portal.quote_requests set quoted_subtotal = $2, tax = $3, quoted_total = $4, updated_at = now() where id = $1`,
    [quoteId, totals.itemsGross, totals.iva, totals.total]
  );
  return { quotedSubtotal: totals.itemsGross, iva: totals.iva, neto: totals.neto, quotedTotal: totals.total };
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
  const { status, discount, discountType, shipping, surcharge, ivaRate, adminNotes, publicNotes, currency } = req.body || {};
  if (discountType !== undefined && !["nominal", "percent"].includes(discountType)) {
    return res.status(400).json({ error: "invalid_discount_type" });
  }
  try {
    const result = await withTransaction(async (client) => {
      const before = await client.query(`select * from portal.quote_requests where id = $1`, [req.params.id]);
      if (!before.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      // "Firma" del vendedor: al pasar la cotización a 'quoted' queda
      // registrado quién la cotizó (quoted_by_user_id + quoted_at).
      const nowQuoting = status === "quoted";
      await client.query(
        `update portal.quote_requests set
           status = coalesce($2, status),
           discount = coalesce($3, discount),
           discount_type = coalesce($4, discount_type),
           shipping = coalesce($5, shipping),
           surcharge = coalesce($6, surcharge),
           iva_rate = coalesce($7, iva_rate),
           admin_notes = coalesce($8, admin_notes),
           public_notes = coalesce($9, public_notes),
           currency = coalesce($10, currency),
           quoted_at = case when $11 then now() else quoted_at end,
           quoted_by_user_id = case when $11 then $12 else quoted_by_user_id end,
           assigned_admin_id = coalesce(assigned_admin_id, $12),
           updated_at = now()
         where id = $1`,
        [req.params.id, status || null,
         discount === undefined ? null : Number(discount), discountType || null,
         shipping === undefined ? null : Number(shipping), surcharge === undefined ? null : Number(surcharge),
         ivaRate === undefined ? null : Number(ivaRate),
         adminNotes ?? null, publicNotes ?? null, currency || null, nowQuoting, req.user.id]
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

// Loads a quote + its client + items + company profile + the signer (the
// admin who quoted it, falling back to the current admin). Shared by the
// printable route and the email sender.
async function loadProformaContext(quoteId, fallbackSigner) {
  const quoteResult = await pool.query(
    `select q.*, u.email, u.display_name, u.company_name
     from portal.quote_requests q join portal.users u on u.id = q.user_id
     where q.id = $1`,
    [quoteId]
  );
  const quote = quoteResult.rows[0];
  if (!quote) return null;
  const items = await pool.query(`select * from portal.quote_items where quote_request_id = $1 order by created_at`, [quoteId]);
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
router.post("/admin/quotes/:id/send-proforma", async (req, res) => {
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
      `update portal.quote_requests set status = 'quoted', quoted_at = coalesce(quoted_at, now()),
         quoted_by_user_id = $2, assigned_admin_id = coalesce(assigned_admin_id, $2), updated_at = now()
       where id = $1`,
      [req.params.id, req.user.id]
    );
    await recomputeQuoteTotals(client, req.params.id);
  });

  const ctx = await loadProformaContext(req.params.id, { display_name: req.user.display_name, email: req.user.email });
  if (!ctx) return res.status(404).json({ error: "not_found" });

  const to = (req.body?.to && String(req.body.to).trim()) || ctx.quote.email;
  const html = renderProformaHtml({ ...ctx, forEmail: true });
  const subject = `Proforma #${ctx.quote.request_number} - ${ctx.company.name}`;

  try {
    await sendGmail({
      refreshToken,
      from: tokenRow.rows[0].gmail_address || req.user.email,
      fromName: req.user.display_name || ctx.company.name,
      to,
      subject,
      html,
      replyTo: req.user.email
    });
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: "gmail_send_failed", detail: error.message });
  }

  await recordAudit({ actorUserId: req.user.id, action: "quote.proforma.sent", entityType: "quote_request", entityId: req.params.id, metadata: { to } });
  res.json({ ok: true, to });
});

export default router;
