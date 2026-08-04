export const DEFAULT_INTERNAL_RECIPIENTS = Object.freeze([
  "tomas.dr@patagoniatools.com.ar",
  "andrea.villamizar@patagoniatools.com.ar",
  "m.vaistich@patagoniatools.com.ar",
  "guillermo.distasio@patagoniatools.com.ar",
  "info@patagoniatools.com.ar",
  "facturacion@patagoniatools.com.ar",
  "franco.a@patagoniatools.com.ar",
  "mercado@latitudessur.com",
  "cobranzas@patagoniatools.com.ar",
  "n.david@patagoniatools.com.ar"
]);

export const SELLER_CODES = Object.freeze({
  "m.vaistich@patagoniatools.com.ar": "MRT",
  "franco.a@patagoniatools.com.ar": "FRA",
  "l.fonte@patagoniatools.com.ar": "LFO",
  "guillermo.distasio@patagoniatools.com.ar": "GDS"
});

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function normalizeEmailList(value) {
  const entries = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  return [...new Set(entries.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
}

export function invalidEmails(value) {
  return normalizeEmailList(value).filter((email) => !EMAIL_RE.test(email));
}

export function sellerCodeFor(email, storedCode = null) {
  const explicit = String(storedCode || "").trim().toUpperCase();
  if (explicit) return explicit;
  return SELLER_CODES[String(email || "").trim().toLowerCase()] || null;
}

export function salesManagementCode(sellerCode, requestNumber) {
  const code = String(sellerCode || "").trim().toUpperCase();
  const number = String(requestNumber || "").trim();
  return [code, number].filter(Boolean).join("-");
}

export function sanitizeEmailHtml(value) {
  let html = String(value || "");
  html = html.replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  html = html.replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link)\b[^>]*\/?\s*>/gi, "");
  html = html.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/\s+(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "");
  return html.trim();
}

export function mergeRequiredRecipients({ clientEmail, internalRecipients = [], additionalRecipients = [] }) {
  return normalizeEmailList([clientEmail, ...internalRecipients, ...normalizeEmailList(additionalRecipients)]);
}

export function formatArs(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

export function itemLines(items = []) {
  return items
    .filter((item) => !item.line_type || item.line_type === "product")
    .map((item) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const unit = item.quoted_unit_price == null ? null : Number(item.quoted_unit_price);
      const amount = unit == null ? "A cotizar" : `${formatArs(unit)} c/u · ${formatArs(unit * quantity)}`;
      return `${quantity} × ${item.product_name_snapshot || item.sku_snapshot || "Producto"} — ${amount}`;
    })
    .join("\n") || "Sin productos cargados";
}

export function fiscalLines(client = {}) {
  const lines = [];
  const name = client.company_name || client.display_name;
  if (name) lines.push(`Razón social / Nombre: ${name}`);
  const tax = [client.tax_id_type, client.tax_cuit].filter(Boolean).join(": ");
  if (tax) lines.push(tax);
  if (client.tax_condition) lines.push(`Condición fiscal: ${client.tax_condition}`);
  return lines.join("\n") || "Datos fiscales a confirmar";
}
