// Read-only view into the existing stock source (Ninox -> ... -> Supabase).
// This module NEVER writes to that table and never imports a Ninox client -
// it only runs SELECTs, joined by normalized SKU against portal.products.
//
// The table/column names below are unconfirmed placeholders (see
// .env.example) until `scripts/inspect_supabase_stock.js` has been run
// against the real production schema. Do not treat the defaults as fact.
import { pool } from "../db.js";

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
    updatedAtColumn: assertIdentifier(process.env.STOCK_COLUMN_UPDATED_AT || "updated_at", "STOCK_COLUMN_UPDATED_AT")
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

// Returns a Map<sku_normalized, { status, exactQty, sourceUpdatedAt }>.
// exactQty/sourceUpdatedAt are internal fields - route handlers must strip
// them before responding to non-admin callers (see routes/catalog.js).
export async function getStockForSkus(skuNormalizedList) {
  const map = new Map();
  if (!skuNormalizedList.length) return map;
  if (!pool) {
    for (const sku of skuNormalizedList) map.set(sku, { status: "out_of_stock", exactQty: null, sourceUpdatedAt: null });
    return map;
  }

  const { table, skuColumn, qtyColumn, updatedAtColumn } = config();
  const threshold = await getLowStockThreshold();

  // Aggregated in a subquery rather than joined row-by-row: if the source
  // table has duplicate normalized SKUs (getStockSourceHealth() below
  // already tracks that this can happen), a plain LEFT JOIN would let
  // Postgres's arbitrary row order silently pick one of them for a
  // customer-facing stock status. Summing quantities and taking the latest
  // timestamp per normalized SKU makes the result deterministic instead.
  const sql = `
    select
      p.sku_normalized,
      agg.exact_qty,
      agg.source_updated_at
    from portal.products p
    left join (
      select
        upper(trim(regexp_replace(${skuColumn}::text, '\\s+', '', 'g'))) as sku_normalized,
        sum(${qtyColumn}) as exact_qty,
        max(${updatedAtColumn}) as source_updated_at
      from ${table}
      group by 1
    ) agg on agg.sku_normalized = p.sku_normalized
    where p.sku_normalized = any($1)
  `;
  const result = await pool.query(sql, [skuNormalizedList]);

  for (const sku of skuNormalizedList) {
    map.set(sku, { status: "out_of_stock", exactQty: null, sourceUpdatedAt: null });
  }
  for (const row of result.rows) {
    map.set(row.sku_normalized, {
      status: statusFor(row.exact_qty, threshold),
      exactQty: row.exact_qty === null ? null : Number(row.exact_qty),
      sourceUpdatedAt: row.source_updated_at
    });
  }
  return map;
}

// Admin dashboard "estado de la fuente de stock" card: last known freshness,
// match/no-match counts, obvious duplicates. Read-only, no side effects.
export async function getStockSourceHealth() {
  if (!pool) return { healthy: false, reason: "db_unavailable" };
  const { table, skuColumn, updatedAtColumn } = config();

  const [freshness, matches, duplicates] = await Promise.all([
    pool.query(`select max(${updatedAtColumn}) as last_update from ${table}`),
    pool.query(`
      select
        count(*) filter (where s.${skuColumn} is not null) as matched,
        count(*) filter (where s.${skuColumn} is null) as unmatched
      from portal.products p
      left join ${table} s
        on upper(trim(regexp_replace(s.${skuColumn}::text, '\\s+', '', 'g'))) = p.sku_normalized
    `),
    pool.query(`
      select upper(trim(regexp_replace(${skuColumn}::text, '\\s+', '', 'g'))) as sku_normalized, count(*) as n
      from ${table}
      group by 1
      having count(*) > 1
    `)
  ]);

  return {
    healthy: true,
    lastUpdate: freshness.rows[0]?.last_update || null,
    matched: Number(matches.rows[0]?.matched || 0),
    unmatched: Number(matches.rows[0]?.unmatched || 0),
    duplicateSkuCount: duplicates.rows.length
  };
}
