import express from "express";
import { pool, withTransaction } from "../db.js";
import { requireAdmin, requireCapability } from "../middleware.js";
import { recordAudit } from "../audit.js";
import { fetchWooCommerceCatalog, prepareWooProducts, buildWooSyncPlan } from "../woocommerceCatalogSync.js";

const router = express.Router();
router.use(requireAdmin);
const canCatalog = requireCapability("catalog.manage");

async function loadPortalProducts(db = pool) {
  const result = await db.query(
    `select id, sku, sku_normalized, name, brand, category, image_url, publication_url, active, visible
     from portal.products
     order by created_at, id`
  );
  return result.rows;
}

async function loadKnownBrands() {
  const result = await pool.query(
    `select distinct brand from portal.products where brand is not null and trim(brand) <> '' order by brand`
  );
  return result.rows.map((row) => row.brand);
}

function summarize(rawCount, prepared, plan) {
  return {
    webProducts: rawCount,
    validWebProducts: prepared.products.length,
    skippedNoSku: prepared.skippedNoSku,
    duplicateWebSkus: prepared.duplicateWebSkus,
    created: plan.created.length,
    reactivated: plan.reactivated.length,
    deactivated: plan.deactivated.length,
    unchanged: plan.unchanged.length,
    newSkus: plan.created.map((item) => item.sku).slice(0, 100),
    reactivatedSkus: plan.reactivated.map((item) => item.product.sku).slice(0, 100),
    removedSkus: plan.deactivated.map((item) => item.sku).slice(0, 100)
  };
}

router.post("/admin/catalog/sync-woocommerce", canCatalog, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "db_unavailable" });

  let rawProducts;
  try {
    rawProducts = await fetchWooCommerceCatalog();
  } catch (error) {
    console.error("woocommerce_catalog_fetch_failed", error);
    return res.status(error.statusCode || 502).json({
      error: "woocommerce_unavailable",
      detail: "No se pudo leer el catálogo publicado de autodiagnostico.com.ar. No se modificó ningún producto."
    });
  }

  const knownBrands = await loadKnownBrands();
  const prepared = prepareWooProducts(rawProducts, knownBrands);
  if (!rawProducts.length || !prepared.products.length) {
    return res.status(409).json({
      error: "woocommerce_empty_catalog",
      detail: "WooCommerce no devolvió productos válidos con SKU. Por seguridad no se modificó el catálogo."
    });
  }

  const portalProducts = await loadPortalProducts();
  const previewPlan = buildWooSyncPlan(prepared.products, portalProducts);
  const preview = summarize(rawProducts.length, prepared, previewPlan);

  if (req.body?.apply !== true) {
    return res.json({ ok: true, preview: true, summary: preview });
  }

  const applied = await withTransaction(async (client) => {
    const currentProducts = await loadPortalProducts(client);
    const plan = buildWooSyncPlan(prepared.products, currentProducts);

    for (const product of plan.created) {
      await client.query(
        `insert into portal.products
           (sku, sku_normalized, name, brand, category, image_url, publication_url, visible, active, sort_order, iva_rate, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,true,true,9999,10.5,$8,$8)`,
        [product.sku, product.skuNormalized, product.name, product.brand, product.category, product.imageUrl, product.publicationUrl, req.user.id]
      );
    }

    for (const entry of plan.reactivated) {
      await client.query(
        `update portal.products
         set active = true,
             visible = true,
             name = $2,
             brand = $3,
             category = $4,
             image_url = $5,
             publication_url = $6,
             updated_by = $7,
             updated_at = now()
         where id = $1`,
        [entry.current.id, entry.product.name, entry.product.brand, entry.product.category, entry.product.imageUrl, entry.product.publicationUrl, req.user.id]
      );
    }

    if (plan.deactivated.length) {
      await client.query(
        `update portal.products
         set active = false, updated_by = $2, updated_at = now()
         where id = any($1::uuid[])`,
        [plan.deactivated.map((item) => item.id), req.user.id]
      );
    }

    return summarize(rawProducts.length, prepared, plan);
  });

  await recordAudit({
    actorUserId: req.user.id,
    action: "catalog.sync.woocommerce",
    entityType: "product",
    metadata: applied
  });

  res.json({ ok: true, preview: false, summary: applied });
});

export default router;
