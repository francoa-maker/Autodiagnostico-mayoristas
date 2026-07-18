import express from "express";
import { pool, withTransaction } from "../db.js";
import { requireApproved } from "../middleware.js";
import { getStockForSkus } from "../stock/stockRepository.js";
import { recordAudit } from "../audit.js";
import { tierForQuantity, resolveWholesaleUnit } from "../pricing.js";

const router = express.Router();
router.use(requireApproved);

// The client submits only { productId, quantity } - every price, tier, and
// stock status is recomputed here from the current DB state. A quantity or
// productId a client sends is just a hint; nothing from the request body is
// ever written into displayed_price_snapshot/quoted_unit_price directly.
router.post("/quotes", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "empty_cart" });

  // Con nombre + email (que siempre están por el login de Google) alcanza para
  // pedir una cotización. Los datos fiscales/entrega son opcionales acá y se
  // completan en "Mis datos" (necesarios para la proforma/envío al depósito).
  try {
    const quote = await withTransaction(async (client) => {
      const productIds = items.map((item) => item.productId).filter(Boolean);
      const productsResult = await client.query(
        `select p.id, p.sku, p.sku_normalized, p.name, p.brand, p.category, p.iva_rate,
                coalesce(
                  jsonb_object_agg(pp.tier, jsonb_build_object('state', pp.state, 'amount', pp.amount, 'currency', pp.currency))
                    filter (where pp.tier is not null),
                  '{}'::jsonb
                ) as prices
         from portal.products p
         left join portal.product_prices pp on pp.product_id = p.id
         where p.id = any($1)
         group by p.id`,
        [productIds]
      );
      const stockMap = await getStockForSkus(productsResult.rows.map((row) => row.sku_normalized));
      // PVP is read live from Supabase (see stockRepository), not stored in
      // portal.product_prices - merge it in so the one/four/eight fallback
      // below (`product.prices?.pvp`) has something to fall back to.
      const byId = new Map(
        productsResult.rows.map((row) => {
          const stock = stockMap.get(row.sku_normalized);
          const pvp = stock?.pvp != null ? { state: "value", amount: stock.pvp, currency: "ARS" } : null;
          return [row.id, { ...row, prices: { ...row.prices, pvp } }];
        })
      );

      const quoteResult = await client.query(
        `insert into portal.quote_requests (user_id, customer_notes) values ($1, $2) returning id, request_number`,
        [req.user.id, req.body?.customerNotes || null]
      );
      const quoteId = quoteResult.rows[0].id;
      let subtotal = 0;
      let itemCount = 0;

      for (const item of items) {
        const product = byId.get(item.productId);
        if (!product) continue; // unknown/stale product id from the client - silently dropped, not trusted

        const quantity = Math.max(1, Math.floor(Number(item.quantity)) || 1);
        const tier = tierForQuantity(quantity);
        const stock = stockMap.get(product.sku_normalized) || { status: "out_of_stock", exactQty: null, pvp: null };
        // Precio mayorista: tier directo, o 15% off PVP si no hay mayorista, o
        // "consultar" si pidió más de lo estipulado / no hay precio.
        const resolved = resolveWholesaleUnit(product.prices, stock.pvp, quantity);
        const priceEntry = resolved.state === "value"
          ? { state: "value", amount: resolved.amount, currency: "ARS" }
          : { state: "consult", amount: null, currency: "ARS" };
        const unitPrice = resolved.state === "value" ? resolved.amount : null;

        if (unitPrice != null) subtotal += unitPrice * quantity;
        itemCount++;

        await client.query(
          `insert into portal.quote_items
             (quote_request_id, product_id, sku_snapshot, product_name_snapshot, brand_snapshot, category_snapshot,
              quantity, pricing_tier, displayed_price_snapshot, quoted_unit_price, stock_status_at_submit, exact_stock_internal, iva_rate)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            quoteId,
            product.id,
            product.sku,
            product.name,
            product.brand,
            product.category,
            quantity,
            tier,
            JSON.stringify(priceEntry || {}),
            unitPrice,
            stock.status,
            stock.exactQty,
            product.iva_rate ?? 10.5
          ]
        );
      }

      if (!itemCount) throw Object.assign(new Error("no_valid_items"), { statusCode: 400 });

      await client.query(`update portal.quote_requests set displayed_subtotal = $2 where id = $1`, [quoteId, subtotal]);
      return { id: quoteId, requestNumber: quoteResult.rows[0].request_number, subtotal };
    });

    await recordAudit({
      actorUserId: req.user.id,
      action: "quote.submit",
      entityType: "quote_request",
      entityId: quote.id,
      after: { subtotal: quote.subtotal }
    });
    res.status(201).json({ quote });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: "quote_submit_failed" });
  }
});

// "Mis solicitudes": las cotizaciones del propio cliente, con la fecha y el
// nombre de quién la cotizó (vendedor).
router.get("/quotes", async (req, res) => {
  const result = await pool.query(
    `select q.id, q.request_number, q.status, q.displayed_subtotal, q.quoted_total,
            q.submitted_at, q.quoted_at, qb.display_name as quoted_by_name
     from portal.quote_requests q
     left join portal.users qb on qb.id = q.quoted_by_user_id
     where q.user_id = $1 order by q.submitted_at desc`,
    [req.user.id]
  );
  res.json({ quotes: result.rows });
});

router.get("/quotes/:id", async (req, res) => {
  const quoteResult = await pool.query(
    `select q.*, qb.display_name as quoted_by_name
     from portal.quote_requests q
     left join portal.users qb on qb.id = q.quoted_by_user_id
     where q.id = $1`,
    [req.params.id]
  );
  const quote = quoteResult.rows[0];
  if (!quote || (quote.user_id !== req.user.id && req.user.role !== "admin")) {
    return res.status(404).json({ error: "not_found" });
  }
  const itemsResult = await pool.query(`select * from portal.quote_items where quote_request_id = $1 order by created_at`, [req.params.id]);
  res.json({ quote, items: itemsResult.rows });
});

export default router;
