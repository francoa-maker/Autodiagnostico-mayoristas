import pg from "pg";

export const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
  : null;

if (!pool) {
  console.warn("DATABASE_URL no configurado - el servidor arranca pero toda ruta /api fallará con db_unavailable.");
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
