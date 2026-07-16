#!/usr/bin/env node
// Read-only inspection of the existing stock source table. Run this BEFORE
// trusting STOCK_TABLE/STOCK_COLUMN_* in .env/Render - it never writes
// anything, only SELECTs from information_schema/pg_catalog and the table
// itself (LIMIT-ed sample rows only).
//
// Usage: DATABASE_URL=... STOCK_TABLE=schema.table node scripts/inspect_supabase_stock.js
import pg from "pg";

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

function assertIdentifier(value, label) {
  if (!IDENTIFIER_RE.test(value)) throw new Error(`${label} ("${value}") no es un identificador SQL válido`);
  return value;
}

function splitTable(qualified) {
  const [schema, table] = qualified.includes(".") ? qualified.split(".") : ["public", qualified];
  return { schema, table };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL no está definido.");
    process.exit(1);
  }
  const qualifiedTable = assertIdentifier(process.env.STOCK_TABLE || "public.productos", "STOCK_TABLE");
  const { schema, table } = splitTable(qualifiedTable);
  const skuColumn = assertIdentifier(process.env.STOCK_COLUMN_SKU || "sku", "STOCK_COLUMN_SKU");

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log(`Inspeccionando ${qualifiedTable} (solo lectura)\n`);

    const columns = await client.query(
      `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema = $1 and table_name = $2
       order by ordinal_position`,
      [schema, table]
    );
    console.log("Columnas:");
    console.table(columns.rows);
    if (!columns.rows.length) {
      console.error(`\nNo se encontraron columnas - ¿existe realmente ${qualifiedTable}? Revisar STOCK_TABLE antes de seguir.`);
      return;
    }

    const pk = await client.query(
      `select kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
       where tc.table_schema = $1 and tc.table_name = $2 and tc.constraint_type = 'PRIMARY KEY'`,
      [schema, table]
    );
    console.log("\nPrimary key:", pk.rows.map((r) => r.column_name).join(", ") || "(ninguna)");

    const indexes = await client.query(`select indexname, indexdef from pg_indexes where schemaname = $1 and tablename = $2`, [schema, table]);
    console.log("\nÍndices:");
    console.table(indexes.rows);

    const rls = await client.query(`select relrowsecurity from pg_class where relname = $2 and relnamespace = (select oid from pg_namespace where nspname = $1)`, [schema, table]);
    console.log("\nRLS habilitado:", rls.rows[0]?.relrowsecurity ?? "desconocido");

    const policies = await client.query(`select policyname, cmd, roles, qual from pg_policies where schemaname = $1 and tablename = $2`, [schema, table]);
    console.log("Policies:");
    console.table(policies.rows);

    const triggers = await client.query(
      `select tgname, tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = $2 and c.relnamespace = (select oid from pg_namespace where nspname = $1) and not t.tgisinternal`,
      [schema, table]
    );
    console.log("\nTriggers:");
    console.table(triggers.rows);

    // Everything below reads the SKU column specifically - confirm it
    // exists before running these (it's whatever STOCK_COLUMN_SKU says).
    const hasSkuColumn = columns.rows.some((c) => c.column_name === skuColumn);
    if (!hasSkuColumn) {
      console.error(`\nSTOCK_COLUMN_SKU="${skuColumn}" no es una columna real de ${qualifiedTable}. Corregí el env var antes de seguir.`);
      return;
    }

    const nullOrEmptySku = await client.query(
      `select count(*) as n from ${qualifiedTable} where ${skuColumn} is null or btrim(${skuColumn}::text) = ''`
    );
    console.log(`\nFilas con SKU nulo/vacío: ${nullOrEmptySku.rows[0].n}`);

    const duplicates = await client.query(
      `select upper(trim(regexp_replace(${skuColumn}::text, '\\s+', '', 'g'))) as sku_normalized, count(*) as n
       from ${qualifiedTable}
       where ${skuColumn} is not null
       group by 1
       having count(*) > 1
       order by n desc
       limit 20`
    );
    console.log(`\nSKUs normalizados duplicados (top 20): ${duplicates.rows.length}`);
    console.table(duplicates.rows);

    const sample = await client.query(`select * from ${qualifiedTable} limit 5`);
    console.log("\nMuestra (5 filas):");
    console.table(sample.rows);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
