// Migración de datos de roles (una vez, tras aplicar 0010). Mapea los roles
// legacy a los nuevos según lo definido con Franco. Idempotente. Requiere
// DATABASE_URL. Correr: DATABASE_URL=... node scripts/backfill_roles.js
import pg from "pg";

// Asignaciones explícitas por email (lo que no está acá cae en la regla genérica).
const MAP_BY_EMAIL = {
  "franco.a@patagoniatools.com.ar": "superadmin",
  "valansi.matias@patagoniatools.com.ar": "superadmin",
  "guillermo.distasio1@gmail.com": "administration"
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL no definido. Abortando.");
    process.exit(1);
  }
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    // 1) Asignaciones explícitas primero (así 'guillermo' no queda como superadmin por la regla genérica).
    for (const [email, role] of Object.entries(MAP_BY_EMAIL)) {
      const r = await c.query(`update portal.users set role = $2, updated_at = now() where email = $1 and role <> $2 returning email`, [email, role]);
      if (r.rowCount) console.log("  ", email, "->", role);
    }
    // 2) Regla genérica para el resto.
    const cust = await c.query(`update portal.users set role = 'client', updated_at = now() where role = 'customer' returning email`);
    cust.rows.forEach((u) => console.log("  ", u.email, "-> client"));
    const adm = await c.query(`update portal.users set role = 'superadmin', updated_at = now() where role = 'admin' returning email`);
    adm.rows.forEach((u) => console.log("  ", u.email, "-> superadmin (admin legacy)"));

    const all = await c.query(`select email, role, status from portal.users order by created_at`);
    console.log("=== roles finales ===");
    all.rows.forEach((u) => console.log("  " + u.email + " -> " + u.role + " / " + u.status));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
