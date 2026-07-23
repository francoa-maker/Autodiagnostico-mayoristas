import express from "express";
import { pool } from "../db.js";
import { requireApproved } from "../middleware.js";
import { getStockForSkus } from "../stock/stockRepository.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = express.Router();
router.use(requireApproved);

router.get("/catalog/brands", async (req, res) => {
  const [result, logos] = await Promise.all([
    pool.query(`select brand, count(*) as count from portal.products where active and visible group by brand order by brand`),
    pool.query(`select value from portal.app_settings where key = 'brand_logos'`)
  ]);
  const logoMap = logos.rows[0]?.value || {};
  const brands = result.rows.map((b) => ({ ...b, logoUrl: logoMap[b.brand] || null }));
  res.json({ brands });
});

router.get("/catalog/categories", async (req, res) => {
  const params = [];
  const conditions = ["active", "visible"];
  if (req.query.brand) {
    params.push(req.query.brand);
    conditions.push(`brand = $${params.length}`);
  }
  const result = await pool.query(
    `select category, count(*) as count from portal.products where ${conditions.join(" and ")} group by category order by category`,
    params
  );
  res.json({ categories: result.rows });
});

router.get("/catalog/products", async (req, res) => {
  const { brand, category, q } = req.query;
  const params = [];
  const conditions = ["active", "visible"];
  if (brand) {
    params.push(brand);
    conditions.push(`brand = $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(name ilike $${params.length} or sku ilike $${params.length})`);
  }

  const productsResult = await pool.query(
    `select p.id, p.sku, p.sku_normalized, p.name, p.brand, p.category, p.image_url, p.publication_url, p.note, p.created_at,
            coalesce(
              jsonb_object_agg(pp.tier, jsonb_build_object('state', pp.state, 'amount', pp.amount, 'currency', pp.currency, 'label', pp.custom_label))
                filter (where pp.tier is not null),
              '{}'::jsonb
            ) as prices
     from portal.products p
     left join portal.product_prices pp on pp.product_id = p.id
     where ${conditions.join(" and ")}
     group by p.id
     order by p.sort_order, p.name`,
    params
  );

  const stockMap = await getStockForSkus(productsResult.rows.map((row) => row.sku_normalized));
  const isAdmin = req.user.role === "admin";

  // Non-admin responses never include exactQty/sourceUpdatedAt at all - not
  // even as null - since the stock source's exact quantity must never reach
  // a customer, per the handoff's non-negotiable rule. PVP, unlike exact
  // stock, IS customer-visible - it's just read live from Supabase instead
  // of portal.product_prices (see src/stock/stockRepository.js).
  const products = productsResult.rows.map((row) => {
    const stock = stockMap.get(row.sku_normalized) || { status: "out_of_stock", exactQty: null, sourceUpdatedAt: null, pvp: null };
    const prices = {
      ...row.prices,
      pvp: stock.pvp !== null ? { state: "value", amount: stock.pvp, currency: "ARS", label: null } : { state: "hidden", amount: null, currency: "ARS", label: null }
    };
    const base = {
      id: row.id,
      sku: row.sku,
      name: row.name,
      brand: row.brand,
      category: row.category,
      imageUrl: row.image_url,
      publicationUrl: row.publication_url,
      note: row.note,
      createdAt: row.created_at,
      prices,
      stockStatus: stock.status
    };
    if (isAdmin) {
      base.exactStock = stock.exactQty;
      base.stockUpdatedAt = stock.sourceUpdatedAt;
    }
    return base;
  });

  res.json({ products });
});

// --- Favoritos por usuario -------------------------------------------------
// Persistidos en portal.user_favorites (ver migración 0007). El catálogo carga
// la lista de ids y marca cada tarjeta; alta/baja no recargan la página.
router.get("/catalog/favorites", async (req, res) => {
  const r = await pool.query(`select product_id from portal.user_favorites where user_id = $1`, [req.user.id]);
  res.json({ productIds: r.rows.map((x) => x.product_id) });
});

router.post("/catalog/favorites", async (req, res) => {
  const productId = String(req.body?.productId || "");
  if (!UUID_RE.test(productId)) return res.status(400).json({ error: "invalid_id" });
  const exists = await pool.query(`select 1 from portal.products where id = $1 and active`, [productId]);
  if (!exists.rows[0]) return res.status(404).json({ error: "product_not_found" });
  await pool.query(
    `insert into portal.user_favorites (user_id, product_id) values ($1, $2)
     on conflict (user_id, product_id) do nothing`,
    [req.user.id, productId]
  );
  res.json({ ok: true });
});

router.delete("/catalog/favorites/:productId", async (req, res) => {
  const productId = String(req.params.productId || "");
  if (!UUID_RE.test(productId)) return res.status(400).json({ error: "invalid_id" });
  await pool.query(`delete from portal.user_favorites where user_id = $1 and product_id = $2`, [req.user.id, productId]);
  res.json({ ok: true });
});

// --- Productos frecuentes --------------------------------------------------
// Derivados del historial real del usuario: productos que ya solicitó, por
// cantidad de veces pedido y luego recencia. Sin historial devuelve [] y el
// front muestra el mensaje de "todavía no tenés frecuentes".
router.get("/catalog/frequent", async (req, res) => {
  const r = await pool.query(
    `select qi.product_id, count(*) as times, max(q.submitted_at) as last_at
     from portal.quote_items qi
     join portal.quote_requests q on q.id = qi.quote_request_id
     join portal.products p on p.id = qi.product_id
     where q.user_id = $1 and qi.product_id is not null and p.active and p.visible
     group by qi.product_id
     order by times desc, last_at desc
     limit 24`,
    [req.user.id]
  );
  res.json({ productIds: r.rows.map((x) => x.product_id) });
});

export default router;
