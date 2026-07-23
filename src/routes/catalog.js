import express from "express";
import { pool } from "../db.js";
import { requireApproved } from "../middleware.js";
import { getStockForSkus } from "../stock/stockRepository.js";

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
    `select p.id, p.sku, p.sku_normalized, p.name, p.brand, p.category, p.image_url, p.publication_url, p.note,
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

export default router;
