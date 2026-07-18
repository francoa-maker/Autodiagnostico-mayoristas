// "Mis datos" del cliente: datos fiscales + dirección de entrega (formato
// Andreani). Self-service — cada usuario aprobado edita SOLO lo suyo. El admin
// también puede completarlos desde el panel (ver saveUserProfile, usado por
// routes/admin.js). No se valida el formato del CUIT/documento: se guarda tal
// cual (AFIP lo verá facturación).
import express from "express";
import { pool } from "../db.js";
import { requireApproved } from "../middleware.js";
import { normalizeDigits, allowedTaxIdTypes, defaultTaxIdType } from "../cuit.js";

const router = express.Router();
router.use(requireApproved);

export const TAX_CONDITIONS = ["responsable_inscripto", "monotributo", "exento", "consumidor_final"];

export const PROFILE_COLUMNS = `company_name, tax_cuit, tax_id_type, tax_condition,
  ship_street, ship_number, ship_floor, ship_apartment, ship_postal_code,
  ship_city, ship_province, ship_phone, ship_notes`;

// "Completo" = tiene todo lo necesario para una proforma con envío. Ya no se
// exige para cotizar (con nombre+email alcanza); sólo alimenta el flag de UI.
export function profileComplete(u) {
  return Boolean(
    u &&
      u.company_name &&
      u.tax_cuit &&
      u.tax_condition &&
      u.ship_street &&
      u.ship_number &&
      u.ship_postal_code &&
      u.ship_city &&
      u.ship_province &&
      u.ship_phone
  );
}

// Guarda el perfil de un usuario (self o desde el admin). Lenient: acepta datos
// parciales y NO valida el formato del documento. Devuelve el perfil guardado.
export async function saveUserProfile(userId, p = {}) {
  const text = (v) => {
    const s = String(v ?? "").trim();
    return s || null;
  };
  const condition = TAX_CONDITIONS.includes(p.tax_condition) ? p.tax_condition : null;
  // El tipo de documento se alinea a la condición cuando ésta lo fija (CUIT),
  // salvo Consumidor Final que admite DNI/CUIL/CUIT.
  const taxIdType = condition
    ? (allowedTaxIdTypes(condition).includes(p.tax_id_type) ? p.tax_id_type : defaultTaxIdType(condition))
    : (["CUIT", "CUIL", "DNI"].includes(p.tax_id_type) ? p.tax_id_type : "CUIT");

  const r = await pool.query(
    `update portal.users set
       company_name = $2, tax_cuit = $3, tax_id_type = $4, tax_condition = $5,
       ship_street = $6, ship_number = $7, ship_floor = $8, ship_apartment = $9,
       ship_postal_code = $10, ship_city = $11, ship_province = $12, ship_phone = $13, ship_notes = $14,
       updated_at = now()
     where id = $1
     returning ${PROFILE_COLUMNS}`,
    [
      userId, text(p.company_name), normalizeDigits(p.tax_cuit) || null, taxIdType, condition,
      text(p.ship_street), text(p.ship_number), text(p.ship_floor), text(p.ship_apartment),
      text(p.ship_postal_code), text(p.ship_city), text(p.ship_province), text(p.ship_phone), text(p.ship_notes)
    ]
  );
  return r.rows[0];
}

router.get("/profile", async (req, res) => {
  const r = await pool.query(`select ${PROFILE_COLUMNS} from portal.users where id = $1`, [req.user.id]);
  const profile = r.rows[0] || {};
  res.json({ profile, complete: profileComplete(profile) });
});

router.put("/profile", async (req, res) => {
  const profile = await saveUserProfile(req.user.id, req.body?.profile || {});
  res.json({ profile, complete: profileComplete(profile) });
});

export default router;
