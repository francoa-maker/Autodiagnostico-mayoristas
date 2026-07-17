import express from "express";
import { pool, withTransaction } from "../db.js";
import { requireAdmin } from "../middleware.js";
import { getStockSourceHealth, getStockForSkus } from "../stock/stockRepository.js";
import { recordAudit } from "../audit.js";

const router = express.Router();
router.use(requireAdmin);

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

router.patch("/admin/products/:id", async (req, res) => {
  const { sortOrder, visible } = req.body || {};
  if (sortOrder === undefined && visible === undefined) return res.status(400).json({ error: "nothing_to_update" });
  const before = await pool.query(`select * from portal.products where id = $1`, [req.params.id]);
  if (!before.rows[0]) return res.status(404).json({ error: "not_found" });

  const result = await pool.query(
    `update portal.products set
       sort_order = coalesce($2, sort_order),
       visible = coalesce($3, visible),
       updated_at = now()
     where id = $1
     returning *`,
    [req.params.id, sortOrder === undefined ? null : Number(sortOrder), visible === undefined ? null : Boolean(visible)]
  );

  await recordAudit({
    actorUserId: req.user.id,
    action: "product.update",
    entityType: "product",
    entityId: req.params.id,
    before: { sort_order: before.rows[0].sort_order, visible: before.rows[0].visible },
    after: { sort_order: result.rows[0].sort_order, visible: result.rows[0].visible }
  });
  res.json({ product: result.rows[0] });
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

export default router;
