import pg from "pg";

// The portal's own database (portal.* schema: products, prices, users,
// quotes, audit). Render-managed Postgres, fully separate from Supabase.
export const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
  : null;

if (!pool) {
  console.warn("DATABASE_URL no configurado - el servidor arranca pero toda ruta /api fallará con db_unavailable.");
}

// The existing Supabase project - read-only, stock + PVP only. A genuinely
// separate database from `pool` above, so it can never be joined to
// portal.products in a single SQL query - see src/stock/stockRepository.js,
// which merges the two in application code instead.
export const stockPool = process.env.STOCK_DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.STOCK_DATABASE_URL, max: 5 })
  : null;

if (!stockPool) {
  console.warn("STOCK_DATABASE_URL no configurado - el estado de stock/PVP no estará disponible.");
}

export async function withTransaction(fn) {
  if (!pool) throw new Error("db_unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
