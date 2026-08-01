import { pool } from "./db.js";
import { enqueueEmail } from "./email/queue.js";
import { paymentTermLabel } from "./finance/paymentTerms.js";

const EVENT_TEMPLATE = {
  quote_sent: "cotizacion.enviada",
  bank_details: "datos.bancarios",
  payment_confirmed: "pago.acreditado",
  balance_reminder: "saldo.recordatorio",
  account_paid: "cuenta.saldada",
  open_order: "pedido.abierto",
  order_confirmed: "orden.confirmada",
  invoice_issued: "factura.emitida",
  order_dispatched: "pedido.despachado"
};

function ars(value) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 }).format(Number(value || 0));
}

async function setting(key, fallback = {}) {
  const row = (await pool.query(`select value from portal.app_settings where key=$1`, [key])).rows[0];
  return row?.value || fallback;
}

export async function notifyQuoteEvent(event, quoteId, overrides = {}) {
  const templateKey = EVENT_TEMPLATE[event];
  if (!templateKey) throw new Error("evento_email_desconocido");
  const q = (await pool.query(
    `select q.*, u.email, u.display_name, u.company_name, u.client_code, u.legal_name, u.tax_id
     from portal.quote_requests q join portal.users u on u.id=q.user_id where q.id=$1`,
    [quoteId]
  )).rows[0];
  if (!q) throw Object.assign(new Error("pedido_no_encontrado"), { statusCode: 404 });
  const [recipientSettings, company] = await Promise.all([
    setting("email_recipients", {}),
    setting("company_profile", {})
  ]);
  const eventCc = recipientSettings.events?.[event] || recipientSettings.events?.[templateKey] || "";
  const cc = [recipientSettings.globalCc, eventCc, overrides.cc].filter(Boolean).join(",");
  const base = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const link = base ? `${base}/#/pedido/${q.id}` : `/#/pedido/${q.id}`;
  const items = (await pool.query(
    `select product_name_snapshot, quantity, quoted_unit_price from portal.quote_items
     where quote_request_id=$1 and line_type='product' order by sort_order nulls last, created_at`,
    [quoteId]
  )).rows;
  const variables = {
    client_code: q.client_code || String(q.request_number || ""),
    lineas: items.map((i) => `${i.quantity} × ${i.product_name_snapshot}${i.quoted_unit_price == null ? " — a cotizar" : ` — ${ars(Number(i.quantity) * Number(i.quoted_unit_price))}`}`).join(" · ") || "Sin productos",
    total: ars(q.quoted_total ?? q.displayed_subtotal),
    plazo_entrega: q.delivery_terms || q.delivery_method || "A coordinar",
    plazo_pago: paymentTermLabel(q.payment_terms),
    tipo_factura: q.invoice_type || "A/B",
    razon_social: q.legal_name || q.company_name || q.display_name || "",
    cuit: q.tax_id || "",
    vigencia_dias: company.proformaValidityDays || 7,
    link,
    bank_details: company.bankDetails || company.bank_details || "Datos bancarios a confirmar con Administración.",
    saldo: ars(overrides.balance ?? q.quoted_total),
    vencimiento: overrides.dueDate || q.due_date || "a confirmar",
    ...overrides.variables
  };
  return enqueueEmail({
    templateKey,
    variables,
    to: overrides.to || q.email,
    cc,
    attachments: overrides.attachments || [],
    quoteRequestId: q.id,
    userId: q.user_id,
    scheduledAt: overrides.scheduledAt || null,
    idempotencyKey: overrides.idempotencyKey || `${event}:${q.id}:${overrides.version || "1"}`
  });
}

export function notifyQuoteEventSafe(event, quoteId, overrides = {}) {
  return notifyQuoteEvent(event, quoteId, overrides).catch((error) => {
    console.error("email_notification_enqueue_failed", event, quoteId, error.message);
    return null;
  });
}
