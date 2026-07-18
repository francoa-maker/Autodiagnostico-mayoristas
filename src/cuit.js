// Validación de documentos fiscales argentinos. El tipo de documento depende
// de la condición de IVA del cliente:
//   - Responsable Inscripto / Monotributo / Exento -> CUIT
//   - Consumidor Final -> DNI, CUIL o CUIT
// CUIT y CUIL comparten el mismo algoritmo (11 dígitos + verificador módulo
// 11); sólo cambia el prefijo. El DNI es 7-8 dígitos sin verificador. Sólo se
// valida el formato — la verificación contra AFIP la hace facturación.

export const TAX_ID_TYPES = ["CUIT", "CUIL", "DNI"];

// Tipos de documento permitidos según la condición de IVA.
export function allowedTaxIdTypes(condition) {
  return condition === "consumidor_final" ? ["DNI", "CUIL", "CUIT"] : ["CUIT"];
}

export function defaultTaxIdType(condition) {
  return condition === "consumidor_final" ? "DNI" : "CUIT";
}

export function normalizeDigits(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

// Compat: se seguía importando normalizeCuit en algunos lados.
export const normalizeCuit = normalizeDigits;

function isValid11(digits) {
  if (digits.length !== 11) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * weights[i];
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === Number(digits[10]);
}

export function isValidCuit(raw) {
  return isValid11(normalizeDigits(raw));
}

export function isValidDni(raw) {
  const d = normalizeDigits(raw);
  return d.length >= 7 && d.length <= 8;
}

export function isValidTaxId(type, raw) {
  if (type === "DNI") return isValidDni(raw);
  if (type === "CUIT" || type === "CUIL") return isValid11(raw ? normalizeDigits(raw) : "");
  return false;
}

export function formatCuit(raw) {
  const d = normalizeDigits(raw);
  if (d.length !== 11) return String(raw ?? "");
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}

export function formatDni(raw) {
  const d = normalizeDigits(raw);
  if (d.length < 7 || d.length > 8) return String(raw ?? "");
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, "."); // 12.345.678
}

export function formatTaxId(type, raw) {
  return type === "DNI" ? formatDni(raw) : formatCuit(raw);
}
