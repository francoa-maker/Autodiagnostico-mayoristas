import express from "express";
import { pool, withTransaction } from "../db.js";
import { requireAdmin, requireCapability } from "../middleware.js";
import { recordAudit } from "../audit.js";
import { sendGmail } from "../mailer.js";
import { renderTemplate } from "../email/templates.js";
import { computeQuoteTotals } from "../quoteTotals.js";
import { paymentTermLabel } from "../finance/paymentTerms.js";
import {
  DEFAULT_INTERNAL_RECIPIENTS,
  fiscalLines,
  formatArs,
  invalidEmails,
  itemLines,
  mergeRequiredRecipients,
  normalizeEmailList,
  salesManagementCode,
  sanitizeEmailHtml,
  sellerCodeFor
} from "../salesManagement.js";

const router = express.Router();
router.use(requireAdmin);
const canQuotes = requireCapability("quotes.manage");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FALLBACK_TEMPLATE = {
  key: "venta.iniciada",
  subject: "GESTIÓN DE VENTA {{cliente}} · {{codigo_gestion}}",
  body_html: `<p>Estimado/a {{cliente}},</p>
<p>Antes que nada, muchas gracias por contactarse con nosotros. A continuación le dejamos el detalle de la gestión comercial.</p>
<div style="white-space:pre-line"><strong>Detalle de productos:</strong><br>{{detalle_productos}}</div>
<p><strong>TOTAL: {{total}}</strong></p>
<p><strong>Plazo de entrega:</strong> <span data-sales-field="delivery">{{plazo_entrega}}</span><br>
<strong>Plazo de pago:</strong> <span data-sales-field="payment">{{plazo_pago}}</span></p>
<div style="white-space:pre-line"><strong>Datos de facturación:</strong><br>{{datos_fiscales}}</div>
<p>{{observaciones}}</p>
<p>Precios expresados en {{moneda}}. La operación queda sujeta a las condiciones indicadas en esta gestión.</p>
<p>Puede consultar el pedido y sus documentos desde el portal: {{link}}</p>
<p>Quedamos a su disposición por cualquier inquietud.</p>
<p>Saludos cordiales.<br><strong>{{vendedor_nombre}}</strong><br>
Código de vendedor: <strong>{{vendedor_codigo}}</strong><br>
Código de gestión: <strong>{{codigo_gestion}}</strong></p>`,
  body_text: null
};

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function dateAr(value) {
  if (!value) return "";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString("es-AR");
}

async function salesSettings() {
  const row = (await pool.query(`select value from portal.app_settings where key='sales_management'`)).rows[0];
  const configured = normalizeEmailList(row?.value?.internalRecipients || []);
  return { internalRecipients: configured.length ? configured : [...DEFAULT_INTERNAL_RECIPIENTS] };
}

async function loadTemplate() {
  return (await pool.query(
    `select key, subject, body_html, body_text, variables from portal.email_templates where key='venta.iniciada'`
  )).rows[0] || FALLBACK_TEMPLATE;
}

async function loadContext(quoteId, actorUserId) {
  const quote = (await pool.query(
    `select q.*,
            u.email as client_email, u.display_name as client_display_name, u.company_name,
            u.tax_cuit, u.tax_id_type, u.tax_condition,
            actor.email as actor_email, actor.display_name as actor_name, actor.salesperson_code as actor_salesperson_code,
            starter.email as starter_email, starter.display_name as starter_name, starter.salesperson_code as starter_salesperson_code
       from portal.quote_requests q
       join portal.users u on u.id=q.user_id
       join portal.users actor on actor.id=$2
       left join portal.users starter on starter.id=q.sales_started_by
      where q.id=$1`,
    [quoteId, actorUserId]
  )).rows[0];
  if (!quote) return null;
  const items = (await pool.query(
    `select * from portal.quote_items where quote_request_id=$1 order by sort_order nulls last, created_at`,
    [quoteId]
  )).rows;
  return { quote, items };
}

async function calculateTotals(quoteId) {
  const items = (await pool.query(
    `select quantity, quoted_unit_price, displayed_price_snapshot, iva_rate
       from portal.quote_items where quote_request_id=$1 and line_type='product'`,
    [quoteId]
  )).rows;
  const quote = (await pool.query(
    `select discount, discount_type, shipping, surcharge from portal.quote_requests where id=$1`,
    [quoteId]
  )).rows[0] || {};
  return computeQuoteTotals({
    items,
    discount: quote.discount,
    discountType: quote.discount_type,
    shipping: quote.shipping,
    surcharge: quote.surcharge
  });
}

async function saveTotals(quoteId, totals) {
  await pool.query(
    `update portal.quote_requests set quoted_subtotal=$2, tax=$3, quoted_total=$4, updated_at=now() where id=$1`,
    [quoteId, totals.itemsGross, totals.ivaTotal, totals.total]
  );
}

function defaultPaymentText(quote) {
  const base = paymentTermLabel(quote.payment_terms);
  return quote.due_date ? `${base} · vencimiento ${dateAr(quote.due_date)}` : base;
}

function templateVariables({ quote, items, sellerName, sellerCode, deliveryTerms, paymentTermsText, total }) {
  const clientName = quote.company_name || quote.client_display_name || quote.client_email;
  const managementCode = salesManagementCode(sellerCode, quote.request_number);
  const base = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const link = base ? `${base}/#/pedido/${quote.id}` : `/#/pedido/${quote.id}`;
  return {
    cliente: clientName,
    codigo_gestion: managementCode,
    detalle_productos: itemLines(items),
    total: formatArs(total),
    plazo_entrega: deliveryTerms,
    plazo_pago: paymentTermsText,
    datos_fiscales: fiscalLines(quote),
    observaciones: quote.public_notes || "",
    moneda: quote.currency || "ARS",
    link,
    vendedor_nombre: sellerName,
    vendedor_codigo: sellerCode
  };
}

async function buildDraft(quoteId, actorUserId) {
  const context = await loadContext(quoteId, actorUserId);
  if (!context) return null;
  const { quote, items } = context;
  const sellerName = quote.sales_started_by ? (quote.starter_name || quote.starter_email) : (quote.actor_name || quote.actor_email);
  const sellerEmail = quote.sales_started_by ? quote.starter_email : quote.actor_email;
  const sellerCode = quote.salesperson_code_snapshot || sellerCodeFor(sellerEmail, quote.starter_salesperson_code || quote.actor_salesperson_code);
  if (!sellerCode) {
    throw Object.assign(new Error("salesperson_code_missing"), {
      statusCode: 409,
      detail: "El usuario que inicia la gestión no tiene un código de vendedor configurado."
    });
  }
  const settings = await salesSettings();
  const totals = await calculateTotals(quote.id);
  const deliveryTerms = quote.sales_delivery_terms || quote.delivery_terms || "A coordinar con el cliente";
  const paymentTermsText = quote.sales_payment_terms_text || defaultPaymentText(quote);
  const variables = templateVariables({
    quote, items, sellerName, sellerCode, deliveryTerms, paymentTermsText,
    total: totals.total ?? quote.quoted_total ?? quote.displayed_subtotal
  });
  const rendered = renderTemplate(await loadTemplate(), variables);
  const requiredRecipients = mergeRequiredRecipients({
    clientEmail: quote.client_email,
    internalRecipients: settings.internalRecipients
  });
  return {
    quote,
    seller: { name: sellerName, email: sellerEmail, code: sellerCode },
    managementCode: variables.codigo_gestion,
    clientEmail: quote.client_email,
    internalRecipients: settings.internalRecipients,
    requiredRecipients,
    deliveryTerms,
    paymentTermsText,
    subject: quote.sales_email_subject || rendered.subject,
    bodyHtml: quote.sales_email_body_html || rendered.body,
    alreadyStarted: Boolean(quote.sales_started_at),
    salesStartedAt: quote.sales_started_at
  };
}

router.get("/admin/quotes/:id/sales-management-draft", canQuotes, async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid_id" });
  try {
    const draft = await buildDraft(req.params.id, req.user.id);
    if (!draft) return res.status(404).json({ error: "not_found" });
    res.json({ draft });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    throw error;
  }
});

router.post("/admin/quotes/:id/start-sales-management", canQuotes, async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid_id" });
  if (!req.user.gmail_connected) {
    return res.status(400).json({ error: "gmail_not_connected", detail: "Conectá tu Gmail para iniciar la gestión desde tu casilla." });
  }
  const tokenRow = (await pool.query(
    `select gmail_refresh_token, gmail_address from portal.users where id=$1`,
    [req.user.id]
  )).rows[0];
  if (!tokenRow?.gmail_refresh_token) return res.status(400).json({ error: "gmail_not_connected" });

  const draft = await buildDraft(req.params.id, req.user.id);
  if (!draft) return res.status(404).json({ error: "not_found" });

  const clientEmail = cleanText(req.body?.clientEmail || draft.clientEmail, 320).toLowerCase();
  const additionalRecipients = normalizeEmailList(req.body?.additionalRecipients || []);
  const toList = mergeRequiredRecipients({
    clientEmail,
    internalRecipients: draft.internalRecipients,
    additionalRecipients
  });
  const badAddresses = invalidEmails(toList);
  if (badAddresses.length) {
    return res.status(400).json({ error: "invalid_email", detail: `Direcciones inválidas: ${badAddresses.join(", ")}` });
  }

  const subject = cleanText(req.body?.subject || draft.subject, 250).replace(/[\r\n]+/g, " ");
  const bodyHtml = sanitizeEmailHtml(req.body?.bodyHtml || draft.bodyHtml);
  const deliveryTerms = cleanText(req.body?.deliveryTerms || draft.deliveryTerms, 500);
  const paymentTermsText = cleanText(req.body?.paymentTermsText || draft.paymentTermsText, 500);
  if (!subject || !bodyHtml) return res.status(400).json({ error: "subject_and_body_required" });
  if (!deliveryTerms || !paymentTermsText) {
    return res.status(400).json({ error: "sales_terms_required", detail: "Completá el plazo de entrega y el plazo de pago." });
  }

  const totals = await calculateTotals(req.params.id);
  await saveTotals(req.params.id, totals);

  let gmailResult;
  try {
    gmailResult = await sendGmail({
      refreshToken: tokenRow.gmail_refresh_token,
      from: tokenRow.gmail_address || req.user.email,
      fromName: `${draft.seller.name} · ${draft.seller.code}`,
      to: toList.join(", "),
      subject,
      html: bodyHtml,
      replyTo: req.user.email
    });
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: "gmail_send_failed", detail: error.message });
  }

  const beforeStarted = draft.alreadyStarted;
  const saved = await withTransaction(async (client) => {
    return (await client.query(
      `update portal.quote_requests set
         status = case when status in ('orden','despachado') then status else 'enviada' end,
         quoted_at = coalesce(quoted_at, now()),
         quoted_by_user_id = $2,
         assigned_admin_id = coalesce(assigned_admin_id, $2),
         sales_started_at = coalesce(sales_started_at, now()),
         sales_started_by = coalesce(sales_started_by, $2),
         salesperson_code_snapshot = coalesce(salesperson_code_snapshot, $3),
         sales_delivery_terms = $4,
         sales_payment_terms_text = $5,
         sales_email_to = $6,
         sales_email_cc = '{}',
         sales_email_subject = $7,
         sales_email_body_html = $8,
         sales_gmail_message_id = $9,
         sales_gmail_thread_id = $10,
         updated_at = now()
       where id=$1 returning id, request_number, status, sales_started_at, salesperson_code_snapshot`,
      [
        req.params.id, req.user.id, draft.seller.code, deliveryTerms, paymentTermsText,
        toList, subject, bodyHtml, gmailResult?.id || null, gmailResult?.threadId || null
      ]
    )).rows[0];
  });

  await recordAudit({
    actorUserId: req.user.id,
    action: beforeStarted ? "sales.management.resent" : "sales.management.started",
    entityType: "quote_request",
    entityId: req.params.id,
    metadata: {
      managementCode: draft.managementCode,
      salespersonCode: draft.seller.code,
      recipients: toList,
      gmailMessageId: gmailResult?.id || null,
      gmailThreadId: gmailResult?.threadId || null
    }
  });

  res.json({
    ok: true,
    quote: saved,
    managementCode: draft.managementCode,
    seller: draft.seller,
    recipients: toList,
    gmailMessageId: gmailResult?.id || null,
    gmailThreadId: gmailResult?.threadId || null
  });
});

export default router;
