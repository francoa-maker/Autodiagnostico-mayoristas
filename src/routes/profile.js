// "Mis datos" del cliente: datos fiscales + dirección de entrega (formato
// Andreani). Self-service — cada usuario aprobado edita SOLO lo suyo.
import express from "express";
import { pool } from "../db.js";
import { requireApproved } from "../middleware.js";
import { isValidCuit, normalizeCuit } from "../cuit.js";

const router = express.Router();
router.use(requireApproved);

export const TAX_CONDITIONS = ["responsable_inscripto", "monotributo", "exento", "consumidor_final"];

// Campos mínimos para poder cursar un pedido. floor/apartment/notes opcionales.
export function profileComplete(u) {
  return Boolean(
    u &&
      u.company_name &&
      u.tax_cuit &&
      isValidCuit(u.tax_cuit) &&
      TAX_CONDITIONS.includes(u.tax_condition) &&
      u.ship_street &&
      u.ship_number &&
      u.ship_postal_code &&
      u.ship_city &&
      u.ship_province &&
      u.ship_phone
  );
}

const PROFILE_COLUMNS = `company_name, tax_cuit, tax_condition,
  ship_street, ship_number, ship_floor, ship_apartment, ship_postal_code,
  ship_city, ship_province, ship_phone, ship_notes`;

router.get("/profile", async (req, res) => {
  const r = await pool.query(`select ${PROFILE_COLUMNS} from portal.users where id = $1`, [req.user.id]);
  const profile = r.rows[0] || {};
  res.json({ profile, complete: profileComplete(profile) });
});

router.put("/profile", async (req, res) => {
  const p = req.body?.profile || {};
  const companyName = String(p.company_name ?? "").trim();
  const cuit = normalizeCuit(p.tax_cuit);
  const condition = p.tax_condition;

  if (!companyName) return res.status(400).json({ error: "company_name_required" });
  if (!isValidCuit(cuit)) return res.status(400).json({ error: "invalid_cuit", detail: "El CUIT no tiene un formato válido (11 dígitos + verificador)." });
  if (!TAX_CONDITIONS.includes(condition)) return res.status(400).json({ error: "invalid_tax_condition" });

  const text = (v) => {
    const s = String(v ?? "").trim();
    return s || null;
  };
  // Dirección: requeridos los campos que Andreani necesita sí o sí.
  const required = { ship_street: p.ship_street, ship_number: p.ship_number, ship_postal_code: p.ship_postal_code, ship_city: p.ship_city, ship_province: p.ship_province, ship_phone: p.ship_phone };
  for (const [k, v] of Object.entries(required)) {
    if (!text(v)) return res.status(400).json({ error: "address_incomplete", field: k });
  }

  const r = await pool.query(
    `update portal.users set
       company_name = $2, tax_cuit = $3, tax_condition = $4,
       ship_street = $5, ship_number = $6, ship_floor = $7, ship_apartment = $8,
       ship_postal_code = $9, ship_city = $10, ship_province = $11, ship_phone = $12, ship_notes = $13,
       updated_at = now()
     where id = $1
     returning ${PROFILE_COLUMNS}`,
    [
      req.user.id, companyName, cuit, condition,
      text(p.ship_street), text(p.ship_number), text(p.ship_floor), text(p.ship_apartment),
      text(p.ship_postal_code), text(p.ship_city), text(p.ship_province), text(p.ship_phone), text(p.ship_notes)
    ]
  );
  res.json({ profile: r.rows[0], complete: profileComplete(r.rows[0]) });
});

export default router;
