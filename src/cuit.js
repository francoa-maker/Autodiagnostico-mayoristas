// Validación de CUIT/CUIL argentino: 11 dígitos + dígito verificador (módulo
// 11). Sólo formato — la verificación contra AFIP la hace facturación más
// adelante. Compartible entre back y front.

export function normalizeCuit(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

export function isValidCuit(raw) {
  const digits = normalizeCuit(raw);
  if (digits.length !== 11) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * weights[i];
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false; // CUIT inválido por convención
  return check === Number(digits[10]);
}

export function formatCuit(raw) {
  const d = normalizeCuit(raw);
  if (d.length !== 11) return String(raw ?? "");
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}
