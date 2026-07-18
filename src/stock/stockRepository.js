// Read-only view into the existing stock source (Ninox -> ... -> Supabase).
// This module NEVER writes to that table and never imports a Ninox client.
//
// Supabase is a genuinely separate database from the portal's own Postgres
// (see src/db.js: `pool` vs `stockPool`), so this can NOT be a single SQL
// JOIN - every function here runs one query against each database and
// merges the results in JS by normalized SKU.
//
// The table/column names below are unconfirmed placeholders (see
// .env.example) until `scripts/inspect_supabase_stock.js` has been run
// against the real production schema. Do not treat the defaults as fact.
import { pool, stockPool } from "../db.js";

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

function assertIdentifier(value, label) {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`config_invalid: ${label} ("${value}") no es un identificador SQL válido`);
  }
  return value;
}

function config() {
  return {
    table: assertIdentifier(process.env.STOCK_TABLE || "public.productos", "STOCK_TABLE"),
    skuColumn: assertIdentifier(process.env.STOCK_COLUMN_SKU || "sku", "STOCK_COLUMN_SKU"),
    qtyColumn: assertIdentifier(process.env.STOCK_COLUMN_QTY || "stock", "STOCK_COLUMN_QTY"),
    updatedAtColumn: assertIdentifier(process.env.STOCK_COLUMN_UPDATED_AT || "updated_at", "STOCK_COLUMN_UPDATED_AT"),
    // PVP is read live from Supabase too (unlike 1u/4u/8u, which are
    // portal-owned after the one-time legacy import) - read-only pass
    // through for every product, same as stock. See the normalized_sku join
    // logic below: it is never stored in portal.product_prices.
    pvpColumn: assertIdentifier(process.env.STOCK_COLUMN_PVP || "pvp", "STOCK_COLUMN_PVP"),
    // Precio de la página web: si el PVP (precio_efectivo) es 0/NULL, se usa
    // este como PVP efectivo. Opcional: si no está seteado (p. ej. la tabla
    // interina de desarrollo no lo tiene), no se aplica el fallback.
    webPriceColumn: process.env.STOCK_COLUMN_WEB_PRICE
      ? assertIdentifier(process.env.STOCK_COLUMN_WEB_PRICE, "STOCK_COLUMN_WEB_PRICE")
      : null
  };
}

let cachedThreshold = null;
export async function getLowStockThreshold() {
  if (!pool) return Number(process.env.LOW_STOCK_THRESHOLD || 10);
  const result = await pool.query(`select value from portal.app_settings where key = 'low_stock_threshold'`);
  cachedThreshold = result.rows[0] ? Number(result.rows[0].value) : Number(process.env.LOW_STOCK_THRESHOLD || 10);
  return cachedThreshold;
}

export function statusFor(exactQty, threshold) {
  if (exactQty === null || exactQty === undefined || Number(exactQty) <= 0) return "out_of_stock";
  if (Number(exactQty) <= threshold) return "low_stock";
  return "in_stock";
}

// Returns a Map<sku_normalized, { status, exactQty, sourceUpdatedAt, pvp }>.
// exactQty/sourceUpdatedAt are internal fields - route handlers must strip
// them before responding to non-admin callers (see routes/catalog.js). `pvp`
// is customer-visible (it's a price, not a hidden quantity).
export async function getStockForSkus(skuNormalizedList) {
  const map = new Map();
  for (const sku of skuNormalizedList) {
    map.set(sku, { status: "out_of_stock", exactQty: null, sourceUpdatedAt: null, pvp: null });
  }
  if (!skuNormalizedList.length || !stockPool) return map;

  const { table, skuColumn, qtyColumn, updatedAtColumn, pvpColumn, webPriceColumn } = config();
  const threshold = await getLowStockThreshold();

  // PVP efectivo: si precio_efectivo es 0/NULL, cae a precio_web (columna
  // opcional). nullif(...,0) deja el PVP en NULL cuando ambos son 0.
  const pvpExpr = webPriceColumn
    ? `nullif(case when ${pvpColumn} is not null and ${pvpColumn} > 0 then ${pvpColumn} else ${webPriceColumn} end, 0)`
    : `nullif(${pvpColumn}, 0)`;

  // Aggregated by normalized SKU rather than returned row-by-row: if the
  // source table has duplicate normalized SKUs (getStockSourceHealth()
  // below already tracks that this can happen), returning an arbitrary row
  // per SKU would let Postgres's row order silently pick one of them for a
  // customer-facing stock status/price. Summing quantities and taking the
  // latest timestamp/PVP per normalized SKU makes the result deterministic.
  const sql = `
    select
      upper(trim(regexp_replace(${skuColumn}::text, '\\s+', '', 'g'))) as sku_normalized,
      sum(${qtyColumn}) as exact_qty,
      max(${updatedAtColumn}) as source_updated_at,
      max(${pvpExpr}) as pvp
    from ${table}
    where upper(trim(regexp_replace(${skuColumn}::text, '\\s+', '', 'g'))) = any($1)
    group by 1
  `;
  const result = await stockPool.query(sql, [skuNormalizedList]);

  for (const row of result.rows) {
    map.set(row.sku_normalized, {
      status: statusFor(row.exact_qty, threshold),
      exactQty: row.exact_qty === null ? null : Number(row.exact_qty),
      sourceUpdatedAt: row.source_updated_at,
      pvp: row.pvp === null ? null : Number(row.pvp)
    });
  }
  return map;
}

// Admin dashboard "estado de la fuente de stock" card: last known freshness,
// match/no-match counts, obvious duplicates. Read-only, no side effects.
// Matched/unmatched is computed in JS: portal.products lives in `pool`, the
// stock table lives in `stockPool` - two queries, no cross-database JOIN.
export async function getStockSourceHealth() {
  if (!pool || !stockPool) return { healthy: false, reason: "db_unavailable" };
  const { table, skuColumn, updatedAtColumn } = config();

  const [freshness, duplicates, stockSkus, portalSkus] = await Promise.all([
    stockPool.query(`select max(${updatedAtColumn}) as last_update from ${table}`),
    stockPool.query(`
      select upper(trim(regexp_replace(${skuColumn}::text, '\\s+', '', 'g'))) as sku_normalized, count(*) as n
      from ${table}
      group by 1
      having count(*) > 1
    `),
    stockPool.query(`
      select distinct upper(trim(regexp_replace(${skuColumn}::text, '\\s+', '', 'g'))) as sku_normalized
      from ${table}
      where ${skuColumn} is not null
    `),
    pool.query(`select sku_normalized from portal.products where active and visible`)
  ]);

  const stockSkuSet = new Set(stockSkus.rows.map((row) => row.sku_normalized));
  const matched = portalSkus.rows.filter((row) => stockSkuSet.has(row.sku_normalized)).length;

  return {
    healthy: true,
    lastUpdate: freshness.rows[0]?.last_update || null,
    matched,
    unmatched: portalSkus.rows.length - matched,
    duplicateSkuCount: duplicates.rows.length
  };
}
