import crypto from "node:crypto";
import { normalizeSku } from "../skuNormalize.js";

// Column names as they appear in the legacy Sheet (see reference/*catalogo*.html
// SHEET_CFG in the handoff). Matched case/accent-insensitively so small
// spelling drift in the Sheet header row doesn't break capture.
const COLUMN_ALIASES = {
  order: ["orden"],
  brand: ["marca"],
  category: ["categoria"],
  sku: ["sku"],
  // stock column exists in the Sheet but is always ignored - stock only
  // ever comes from the Supabase source (see src/stock/stockRepository.js).
  name: ["producto"],
  pvp: ["pvp"],
  one: ["dist 1 u", "dist1u"],
  four: ["dist 4 u", "dist4u"],
  eight: ["dist 8 u", "dist8u"],
  link: ["link publicacion", "link publicación"],
  image: ["foto url", "fotourl"],
  note: ["nota"],
  include: ["incluir"]
};

function stripAccents(value) {
  return String(value).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeHeader(value) {
  return stripAccents(value).toLowerCase().trim().replace(/\s+/g, " ");
}

function matchColumns(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const indexOf = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    indexOf[field] = idx;
  }
  const missing = ["brand", "category", "sku", "name", "pvp", "one", "four", "eight"].filter(
    (f) => indexOf[f] === -1
  );
  if (missing.length) {
    throw new Error(`legacy_source_columns_missing: ${missing.join(", ")}`);
  }
  return indexOf;
}

function parseBool(raw) {
  const v = String(raw ?? "").trim().toUpperCase();
  return v === "" || v === "TRUE" || v === "1" || v === "SI" || v === "SÍ";
}

// Recognizes ARS/USD amounts, "Consultar", blank cells, and free-text labels
// (docs/21_importacion_inicial_precios_actuales.md - "reconocer ARS, USD,
// Consultar, vacío y etiquetas especiales"). Validate this against a real
// captured snapshot before the first --apply: this list of shapes was
// inferred from the spec, not from literal example rows.
export function parsePriceCell(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { state: "hidden", amount: null, currency: "ARS", label: null };
  if (/consultar/i.test(text)) return { state: "consult", amount: null, currency: "ARS", label: null };

  let currency = "ARS";
  let numeric = text;
  if (/^u\$s|^usd/i.test(text)) {
    currency = "USD";
    numeric = text.replace(/^u\$s|^usd/i, "").trim();
  } else {
    numeric = numeric.replace(/^\$/, "").trim();
  }
  numeric = numeric.replace(/\./g, "").replace(",", ".");

  const amount = Number(numeric);
  if (!numeric || Number.isNaN(amount)) {
    return { state: "custom", amount: null, currency, label: text };
  }
  return { state: "value", amount, currency, label: null };
}

// Turns raw Sheet rows (array-of-arrays, first row = headers) into the
// normalized snapshot shape used by dry-run/apply (see
// fixtures/legacy_catalog_snapshot.example.json). Rows without SKU or with
// Incluir=FALSE are dropped, matching the legacy HTML's own filtering.
export function rowsToSnapshotProducts(rows) {
  if (!rows.length) return { products: [], skippedNoSku: 0, skippedExcluded: 0 };
  const idx = matchColumns(rows[0]);
  const products = [];
  let skippedNoSku = 0;
  let skippedExcluded = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sku = String(row[idx.sku] ?? "").trim();
    if (!sku) {
      skippedNoSku++;
      continue;
    }
    if (idx.include !== -1 && !parseBool(row[idx.include])) {
      skippedExcluded++;
      continue;
    }

    products.push({
      sku,
      name: String(row[idx.name] ?? "").trim(),
      brand: String(row[idx.brand] ?? "").trim().toUpperCase() || "OTRAS MARCAS",
      category: String(row[idx.category] ?? "").trim() || "Sin categoría",
      image_url: idx.image !== -1 ? String(row[idx.image] ?? "").trim() || null : null,
      publication_url: idx.link !== -1 ? String(row[idx.link] ?? "").trim() || null : null,
      note: idx.note !== -1 ? String(row[idx.note] ?? "").trim() || null : null,
      visible: true,
      sort_order: idx.order !== -1 ? Number(row[idx.order]) || 9999 : i,
      prices: {
        pvp: parsePriceCell(row[idx.pvp]),
        one: parsePriceCell(row[idx.one]),
        four: parsePriceCell(row[idx.four]),
        eight: parsePriceCell(row[idx.eight])
      }
    });
  }

  return { products, skippedNoSku, skippedExcluded };
}

export function hashSnapshot(products) {
  // rowsToSnapshotProducts always builds each product object with the same
  // fixed key order, so plain JSON.stringify is already a deterministic,
  // content-sensitive serialization. (An earlier version passed
  // Object.keys(products) - keys of the *array* - as the replacer, which
  // JSON.stringify treats as a property whitelist; since none of a
  // product's real keys are numeric strings, every product silently
  // serialized as `{}` and any two same-length snapshots hashed identically.)
  const canonical = JSON.stringify(products);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// Compares a snapshot against what's currently in portal.products/product_prices.
// Pure function (no DB access) so it can run identically in dry-run and as a
// pre-apply sanity check.
export function diffSnapshot(snapshotProducts, existingBySkuNormalized) {
  const report = { new: [], updated: [], unchanged: [], duplicates: [], errors: [] };
  const seen = new Set();

  for (const incoming of snapshotProducts) {
    const skuNormalized = normalizeSku(incoming.sku);
    if (seen.has(skuNormalized)) {
      report.duplicates.push(incoming.sku);
      continue;
    }
    seen.add(skuNormalized);

    const existing = existingBySkuNormalized.get(skuNormalized);
    if (!existing) {
      report.new.push(incoming.sku);
      continue;
    }

    const tiersChanged = ["pvp", "one", "four", "eight"].filter((tier) => {
      const before = existing.prices[tier];
      const after = incoming.prices[tier];
      return !before || before.state !== after.state || Number(before.amount) !== Number(after.amount) || before.currency !== after.currency;
    });

    if (tiersChanged.length || existing.name !== incoming.name || existing.brand !== incoming.brand) {
      report.updated.push({ sku: incoming.sku, tiersChanged });
    } else {
      report.unchanged.push(incoming.sku);
    }
  }

  return report;
}

// Shape matches what diffSnapshot expects from `existingBySkuNormalized`:
// Map<sku_normalized, { id, name, brand, prices: { [tier]: {state, amount, currency} } }>
export async function loadExistingBySkuNormalized(client) {
  const result = await client.query(`
    select
      p.id, p.sku_normalized, p.name, p.brand,
      coalesce(
        jsonb_object_agg(pp.tier, jsonb_build_object('state', pp.state, 'amount', pp.amount, 'currency', pp.currency))
          filter (where pp.tier is not null),
        '{}'::jsonb
      ) as prices
    from portal.products p
    left join portal.product_prices pp on pp.product_id = p.id
    group by p.id
  `);
  const map = new Map();
  for (const row of result.rows) {
    map.set(row.sku_normalized, { id: row.id, name: row.name, brand: row.brand, prices: row.prices });
  }
  return map;
}

export async function applySnapshot(client, { products, sourceKind, sourceLabel, snapshotSha256, startedBy }) {
  const runResult = await client.query(
    `insert into portal.catalog_import_runs
       (source_kind, source_label, snapshot_sha256, mode, status, rows_received, started_by)
     values ($1, $2, $3, 'apply', 'started', $4, $5)
     on conflict (snapshot_sha256, mode) do nothing
     returning id`,
    [sourceKind, sourceLabel || null, snapshotSha256, products.length, startedBy || null]
  );

  if (!runResult.rows[0]) {
    return { alreadyApplied: true };
  }
  const batchId = runResult.rows[0].id;

  // Classify every row up front (new/updated/unchanged/duplicate) using the
  // same logic the dry-run report uses, so an --apply never touches a row
  // that diffSnapshot would have called unchanged (no spurious updated_at
  // bumps) and the counters written to catalog_import_runs are accurate
  // rather than derived from `xmax = 0`, which only tells you "row existed
  // before this statement," not "row actually changed."
  const existingBySkuNormalized = await loadExistingBySkuNormalized(client);
  const report = diffSnapshot(products, existingBySkuNormalized);
  const classBySku = new Map();
  for (const sku of report.new) classBySku.set(sku, { kind: "new" });
  for (const entry of report.updated) classBySku.set(entry.sku, { kind: "updated", tiersChanged: entry.tiersChanged });
  for (const sku of report.unchanged) classBySku.set(sku, { kind: "unchanged" });

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let rejected = report.duplicates.length;
  const seenNormalized = new Set();

  for (const product of products) {
    const skuNormalized = normalizeSku(product.sku);
    if (!skuNormalized || seenNormalized.has(skuNormalized)) continue; // empty/duplicate - already counted in `rejected`
    seenNormalized.add(skuNormalized);

    const classification = classBySku.get(product.sku);
    if (!classification || classification.kind === "unchanged") {
      unchanged++;
      continue;
    }

    let productId;
    if (classification.kind === "new") {
      const insert = await client.query(
        `insert into portal.products (sku, sku_normalized, name, brand, category, image_url, publication_url, note, visible, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning id`,
        [
          product.sku,
          skuNormalized,
          product.name,
          product.brand,
          product.category,
          product.image_url,
          product.publication_url,
          product.note,
          product.visible,
          product.sort_order
        ]
      );
      productId = insert.rows[0].id;
      inserted++;
    } else {
      productId = existingBySkuNormalized.get(skuNormalized).id;
      await client.query(
        `update portal.products
           set name = $2, brand = $3, category = $4, image_url = $5, publication_url = $6,
               note = $7, visible = $8, sort_order = $9, updated_at = now()
         where id = $1`,
        [
          productId,
          product.name,
          product.brand,
          product.category,
          product.image_url,
          product.publication_url,
          product.note,
          product.visible,
          product.sort_order
        ]
      );
      updated++;
    }

    // For a brand-new product every tier is new; for an updated product,
    // only touch the tiers diffSnapshot actually flagged as changed - an
    // untouched tier's product_prices row (and its updated_at) is left
    // exactly as-is, matching what "unchanged" means at the row level.
    const tiersToWrite = classification.kind === "new" ? ["pvp", "one", "four", "eight"] : classification.tiersChanged;

    for (const tier of tiersToWrite) {
      const price = product.prices[tier];
      const beforeRow = existingBySkuNormalized.get(skuNormalized)?.prices?.[tier] || null;

      await client.query(
        `insert into portal.product_prices (product_id, tier, state, amount, currency, custom_label)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (product_id, tier) do update
           set state = excluded.state, amount = excluded.amount, currency = excluded.currency,
               custom_label = excluded.custom_label, updated_at = now()`,
        [productId, tier, price.state, price.amount, price.currency, price.label]
      );

      await client.query(
        `insert into portal.price_history (product_id, tier, old_data, new_data, origin, batch_id, reason)
         values ($1,$2,$3,$4,'legacy_import',$5,'Importación inicial de precios legacy')`,
        [productId, tier, beforeRow ? JSON.stringify(beforeRow) : null, JSON.stringify(price), batchId]
      );
    }
  }

  await client.query(
    `update portal.catalog_import_runs
     set status = 'applied', products_inserted = $2, products_updated = $3, products_unchanged = $4,
         rows_rejected = $5, finished_at = now()
     where id = $1`,
    [batchId, inserted, updated, unchanged, rejected]
  );

  return { alreadyApplied: false, batchId, inserted, updated, unchanged, rejected };
}
