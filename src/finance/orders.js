// Resumen financiero del pedido + autorización a Logística (Tanda 5).
import { pool } from "../db.js";
import { computeClientBalance } from "./ledger.js";
import { flags } from "../featureFlags.js";

export const AUTHORIZATION_REASONS = ["pago_confirmado", "cuenta_corriente", "echeq_aceptado", "acuerdo_comercial", "excepcion_manual"];
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// Números que ve Ventas/Administración para decidir la autorización.
export async function getOrderFinancialSummary(orderId) {
  const o = (await pool.query(
    `select q.id, q.request_number, q.user_id, q.quoted_total, q.displayed_subtotal, q.payment_state,
            q.payment_condition, q.authorized_by, q.authorized_at, q.authorization_reason, q.authorization_notes,
            q.logistics_status, ab.display_name as authorized_by_name
     from portal.quote_requests q left join portal.users ab on ab.id = q.authorized_by where q.id = $1`,
    [orderId]
  )).rows[0];
  if (!o) return null;
  const inv = (await pool.query(
    `select coalesce(sum(i.total_amount),0) as invoiced,
            coalesce(sum(ii.paid),0) as accredited
     from portal.invoices i
     left join lateral (select coalesce(sum(x.paid_amount),0) as paid from portal.invoice_installments x where x.invoice_id = i.id) ii on true
     where i.order_id = $1 and i.voided_at is null`,
    [orderId]
  )).rows[0];
  let pendingAccreditation = 0;
  if (flags.echeq) {
    const e = (await pool.query(
      `select coalesce(sum(p.amount),0) as p from portal.payments p join portal.echeq_details e on e.payment_id = p.id
       where p.order_id = $1 and p.status = 'pending_accreditation'`, [orderId]
    )).rows[0];
    pendingAccreditation = round2(e.p);
  }
  const invoiced = round2(inv.invoiced);
  const accredited = round2(inv.accredited);
  const clientBalance = await computeClientBalance(o.user_id);
  return {
    orderId: o.id, requestNumber: o.request_number, clientId: o.user_id,
    operationTotal: round2(o.quoted_total || o.displayed_subtotal || 0),
    invoiced, accredited, pendingAccreditation,
    orderBalance: round2(invoiced - accredited),
    paymentState: o.payment_state, paymentCondition: o.payment_condition,
    logisticsStatus: o.logistics_status,
    authorized: Boolean(o.authorized_at),
    authorizedByName: o.authorized_by_name, authorizedAt: o.authorized_at,
    authorizationReason: o.authorization_reason, authorizationNotes: o.authorization_notes,
    clientBalance
  };
}

export async function authorizeOrder(orderId, { reason, notes = null, actorId }) {
  if (reason != null && !AUTHORIZATION_REASONS.includes(reason)) throw Object.assign(new Error("motivo_invalido"), { statusCode: 400 });
  const r = await pool.query(
    `update portal.quote_requests
       set authorized_by = $2, authorized_at = now(), authorization_reason = $3, authorization_notes = $4,
           logistics_status = case when logistics_status = 'pending' then 'authorized' else logistics_status end,
           updated_at = now()
     where id = $1 returning id, request_number, logistics_status`,
    [orderId, actorId, reason || null, notes]
  );
  if (!r.rows[0]) throw Object.assign(new Error("pedido_no_encontrado"), { statusCode: 404 });
  return r.rows[0];
}
