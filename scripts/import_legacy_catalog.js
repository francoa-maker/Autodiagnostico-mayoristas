#!/usr/bin/env node
// Step 2/3 of the legacy import ("Dry-run" / "Apply"). Consumes a snapshot
// file already produced by scripts/capture_legacy_catalog.js - this script
// never talks to the network, only to the database.
import fs from "node:fs";
import { pool, withTransaction } from "../src/db.js";
import { diffSnapshot, applySnapshot, loadExistingBySkuNormalized } from "../src/imports/legacyCatalogImporter.js";

function parseArgs(argv) {
  const args = { mode: null, snapshot: null };
  for (const arg of argv) {
    if (arg === "--dry-run") args.mode = "dry_run";
    else if (arg === "--apply") args.mode = "apply";
    else if (arg.startsWith("--snapshot=")) args.snapshot = arg.slice("--snapshot=".length);
    else if (arg === "--snapshot") args.snapshot = argv[argv.indexOf(arg) + 1];
  }
  return args;
}

// 'pvp' is reported here purely as a reference value from the legacy sheet -
// it is NOT written to portal.product_prices (see STORED_TIERS in
// legacyCatalogImporter.js). PVP is read live from Supabase instead; this
// summary just lets a human eyeball whether the legacy sheet's PVP roughly
// agrees with what Supabase will serve, before --apply ever runs.
function printPriceStateSummary(products) {
  const counts = { pvp: {}, one: {}, four: {}, eight: {} };
  const customRows = [];
  for (const product of products) {
    for (const tier of ["pvp", "one", "four", "eight"]) {
      const state = product.prices[tier].state;
      counts[tier][state] = (counts[tier][state] || 0) + 1;
      if (state === "custom") customRows.push({ sku: product.sku, tier, label: product.prices[tier].label });
    }
  }
  console.log("\nEstados de precio por tier (pvp es solo referencia - no se guarda, viene en vivo de Supabase):");
  for (const tier of ["pvp", "one", "four", "eight"]) {
    console.log(`  ${tier}: ${JSON.stringify(counts[tier])}`);
  }
  if (customRows.length) {
    console.log("\nCeldas que cayeron en 'custom' (revisar a mano antes de --apply):");
    for (const row of customRows) console.log(`  ${row.sku} / ${row.tier}: "${row.label}"`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode || !args.snapshot) {
    console.error("Uso: node scripts/import_legacy_catalog.js --dry-run|--apply --snapshot <archivo>");
    process.exit(1);
  }
  if (!pool) {
    console.error("DATABASE_URL no configurado.");
    process.exit(1);
  }
  // Safety gate so an accidental --apply (e.g. in a prod shell) can't rewrite
  // the catalog unless explicitly enabled. Dry-run is always allowed.
  if (args.mode === "apply" && process.env.LEGACY_CATALOG_IMPORT_ENABLED !== "true") {
    console.error("--apply bloqueado: seteá LEGACY_CATALOG_IMPORT_ENABLED=true para confirmar la importación real.");
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(args.snapshot, "utf8"));
  console.log(`Snapshot: ${args.snapshot}`);
  console.log(`  capturado: ${snapshot.captured_at}  sha256: ${snapshot.sha256}  productos: ${snapshot.products.length}`);

  if (args.mode === "dry_run") {
    const existing = await loadExistingBySkuNormalized(pool);
    const report = diffSnapshot(snapshot.products, existing);

    console.log(`\nNuevos: ${report.new.length}`);
    console.log(`Actualizados: ${report.updated.length}`);
    console.log(`Sin cambios: ${report.unchanged.length}`);
    console.log(`Duplicados (omitidos): ${report.duplicates.length}`);
    if (report.duplicates.length) console.log(`  SKUs duplicados: ${report.duplicates.join(", ")}`);
    if (report.updated.length) {
      console.log("\nDetalle de actualizados:");
      for (const entry of report.updated) console.log(`  ${entry.sku}: tiers cambiados = ${entry.tiersChanged.join(", ") || "(solo metadata)"}`);
    }
    printPriceStateSummary(snapshot.products);

    await pool.query(
      `insert into portal.catalog_import_runs
         (source_kind, source_label, snapshot_sha256, mode, status, rows_received, products_inserted, products_updated, products_unchanged, rows_rejected, report, finished_at)
       values ($1,$2,$3,'dry_run','validated',$4,$5,$6,$7,$8,$9, now())
       on conflict (snapshot_sha256, mode) do nothing`,
      [
        snapshot.source_kind || "manual",
        snapshot.source_label || null,
        snapshot.sha256,
        snapshot.products.length,
        report.new.length,
        report.updated.length,
        report.unchanged.length,
        report.duplicates.length,
        JSON.stringify(report)
      ]
    );
    console.log("\nDry-run registrado en catalog_import_runs. No se escribió portal.products/product_prices.");
  } else {
    const result = await withTransaction((client) =>
      applySnapshot(client, {
        products: snapshot.products,
        sourceKind: snapshot.source_kind || "manual",
        sourceLabel: snapshot.source_label,
        snapshotSha256: snapshot.sha256
      })
    );

    if (result.alreadyApplied) {
      console.log("\nEste snapshot (mismo sha256) ya fue aplicado antes - no se repite (idempotente).");
    } else {
      console.log(`\nAplicado. batch: ${result.batchId}`);
      console.log(`  insertados: ${result.inserted}  actualizados: ${result.updated}  sin cambios: ${result.unchanged}  rechazados: ${result.rejected}`);
    }
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  if (pool) await pool.end();
  process.exit(1);
});
