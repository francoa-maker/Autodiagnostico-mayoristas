#!/usr/bin/env node
// Step 1 of the legacy import ("Capture"): fetch the current legacy catalog
// source, normalize it to snapshot products, and write an immutable
// snapshot file. Never writes to the database - scripts/import_legacy_catalog.js
// is the separate step that does dry-run/apply against a captured file.
//
// Priority per docs/21_importacion_inicial_precios_actuales.md:
//   1. Web App JSON (LEGACY_CATALOG_SOURCE_URL) - real-time, no Google cache.
//   2. gviz JSON export of the Sheet (LEGACY_SHEET_ID/LEGACY_SHEET_GID).
//   3. Plain CSV export of the Sheet (same ids).
// The Web App URL is treated as sensitive: it is only ever read from an
// environment variable, never logged, never written into the snapshot file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rowsToSnapshotProducts, hashSnapshot } from "../src/imports/legacyCatalogImporter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotsDir = path.join(__dirname, "..", "snapshots");

function parseArgs(argv) {
  const args = { input: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = argv[++i];
  }
  return args;
}

// Handles a small, quoted-field-aware CSV (enough for a Google Sheets CSV
// export) without pulling in a dependency for a one-time import script.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

// gviz responses are JSONP: `<callback>({...})`. Google's default callback
// is `google.visualization.Query.setResponse`; SHEET_CFG in the legacy HTML
// used a custom `responseHandler=_catalogSheetCb`. Strip whichever wrapper
// is present and parse the inner JSON.
function parseGvizJson(text) {
  const match = text.match(/^[^(]*\(([\s\S]*)\);?\s*$/);
  const json = JSON.parse(match ? match[1] : text);
  const cols = json.table.cols.map((c) => c.label || c.id || "");
  const rows = json.table.rows.map((r) => r.c.map((cell) => (cell ? cell.f ?? cell.v ?? "" : "")));
  return [cols, ...rows];
}

// The Web App's exact response shape is unconfirmed (no live access to it
// from this environment) - accept either an array-of-arrays (first row =
// headers) or an array of flat objects (headers derived from the first
// object's keys). Validate this against the real endpoint's actual output
// before trusting a --apply built from it.
function normalizeWebAppPayload(json) {
  const rows = Array.isArray(json) ? json : json.rows || json.data || [];
  if (!rows.length) return [];
  if (Array.isArray(rows[0])) return rows;
  const headers = Object.keys(rows[0]);
  return [headers, ...rows.map((obj) => headers.map((h) => obj[h]))];
}

async function fetchWebAppJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`web_app_fetch_failed: ${response.status}`);
  return normalizeWebAppPayload(await response.json());
}

async function fetchGvizJson(sheetId, gid, range) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}&range=${range}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`gviz_fetch_failed: ${response.status}`);
  return parseGvizJson(await response.text());
}

async function fetchCsvExport(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`csv_fetch_failed: ${response.status}`);
  return parseCsv(await response.text());
}

async function fetchRows() {
  const webAppUrl = process.env.LEGACY_CATALOG_SOURCE_URL;
  const sheetId = process.env.LEGACY_SHEET_ID;
  const gid = process.env.LEGACY_SHEET_GID || "0";
  const range = process.env.LEGACY_SHEET_RANGE || "A1:Z";

  if (webAppUrl) {
    try {
      return { rows: await fetchWebAppJson(webAppUrl), sourceKind: "web_app", sourceLabel: "web_app (masked)" };
    } catch (error) {
      console.warn("Web App falló, probando gviz JSON:", error.message);
    }
  }
  if (sheetId) {
    try {
      return { rows: await fetchGvizJson(sheetId, gid, range), sourceKind: "google_sheet_csv", sourceLabel: `gviz ${sheetId}#${gid}` };
    } catch (error) {
      console.warn("gviz falló, probando CSV export:", error.message);
    }
    return { rows: await fetchCsvExport(sheetId, gid), sourceKind: "google_sheet_csv", sourceLabel: `csv ${sheetId}#${gid}` };
  }
  throw new Error("no_source_configured: definí LEGACY_CATALOG_SOURCE_URL o LEGACY_SHEET_ID, o usá --input <archivo>");
}

function localTimestamp() {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" }).replace(" ", "T");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let rows;
  let sourceKind = "manual";
  let sourceLabel = args.input;

  if (args.input) {
    const text = fs.readFileSync(args.input, "utf8");
    rows = args.input.endsWith(".csv") ? parseCsv(text) : JSON.parse(text);
    if (!Array.isArray(rows[0])) rows = normalizeWebAppPayload(rows);
    sourceKind = "snapshot_csv";
  } else {
    ({ rows, sourceKind, sourceLabel } = await fetchRows());
  }

  const { products, skippedNoSku, skippedExcluded } = rowsToSnapshotProducts(rows);
  // Use the importer's canonical hash (stable across key order / missing
  // fields) so the sha256 stored here matches what the dry-run/apply step
  // reasons about - a hand-rolled JSON.stringify hash could diverge silently
  // and break the apply's idempotency guard.
  const sha256 = hashSnapshot(products);

  const snapshot = {
    captured_at: localTimestamp(),
    source_kind: sourceKind,
    source_label: sourceLabel || null,
    sha256,
    row_count: products.length,
    skipped_no_sku: skippedNoSku,
    skipped_excluded: skippedExcluded,
    products
  };

  fs.mkdirSync(snapshotsDir, { recursive: true });
  const filename = `${snapshot.captured_at.replace(/[:T]/g, "-")}_${sha256.slice(0, 8)}.json`;
  const outPath = path.join(snapshotsDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`Snapshot capturado: ${outPath}`);
  console.log(`  productos: ${products.length} (sin SKU: ${skippedNoSku}, excluidos: ${skippedExcluded})`);
  console.log(`  sha256: ${sha256}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
