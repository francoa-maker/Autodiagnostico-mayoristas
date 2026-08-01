// Pagos + aplicación a facturas/cuotas (Tanda 3). Un pago confirmado (efectivo
// o transferencia verificada) genera un crédito en el mayor y puede aplicarse a
// una o varias cuotas; el excedente queda como saldo a favor. Todo transaccional
// y auditable; la reversa restaura saldos.
import { pool, withTransaction } from "../db.js";
import { insertMovement, reverseMovement } from "./ledger.js";
import { flags } from "../featureFlags.js";

export const PAYMENT_METHODS = ["cash", "bank_transfer", "echeq", "current_account", "customer_credit", "other"];
// Métodos que representan ingreso de dinero y se manejan en esta etapa (eCheq
// llega en Tanda 4; current_account NO es un pago; customer_credit = aplicar
// saldo a favor, etapa futura).
export const MONEY_METHODS = ["cash", "bank_transfer", "other"];
export const PAYMENT_STATUSES = ["draft", "informed", "confirmed", "pending_accreditation", "rejected", "reversed"];

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function isValidDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

// Estado de pago del pedido (puro, testeable). Precedencia:
// overpaid > paid > pending_accreditation(si cubre) > overdue > partially_paid > unpaid.
export function computeOrderPaymentState({ invoiced, applied, hasOverdue, pendingAccreditation = 0 }) {
  invoiced = round2(invoiced); applied = round2(applied); pendingAccreditation = round2(pendingAccreditation);
  if (invoiced <= 0) return "unpaid";
  if (applied > invoiced + 0.005) return "overpaid";
  if (applied >= invoiced - 0.005) return "paid";
  if (pendingAccreditation > 0 && applied + pendingAccreditation >= invoiced - 0.005) return "pending_accreditation";
  if (hasOverdue) return "overdue";
  if (applied > 0) return "partially_paid";
  return "unpaid";
}

export function validateAllocationPlan(paymentAmount, allocations, alreadyAllocated = 0) {
  const available = round2(Number(paymentAmount) - Number(alreadyAllocated || 0));
  const normalized = (Array.isArray(allocations) ? allocations : [])
    .map((a) => ({ installmentId: a.installmentId, amount: round2(a.amount) }))
    .filter((a) => a.installmentId && a.amount > 0);
  if (!normalized.length) throw Object.assign(new Error("sin_asignaciones"), { statusCode: 400 });
  const sum = round2(normalized.reduce((total, a) => total + a.amount, 0));
  if (sum > available + 0.005) throw Object.assign(new Error("excede_saldo_del_pago"), { statusCode: 400, detail: `Disponible ${available}` });
  return { sum, available };
}

function installmentStatus(paidAmount, amount) {
  if (paidAmount >= amount - 0.005) return "paid";
  if (paidAmount > 0) return "partially_paid";
  return "pending";
}

// Recalcula y guarda el estado de pago del pedido a partir de sus facturas/cuotas.
export async function recomputeOrderState(client, orderId) {
  if (!orderId) return;
  const r = await client.query(
    `select coalesce(sum(i.total_amount),0) as invoiced,
            coalesce(sum(ii.paid),0) as applied,
            bool_or(ii.overdue) as has_overdue
     from portal.invoices i
     left join lateral (
       select coalesce(sum(x.paid_amount),0) as paid,
              bool_or(x.paid_amount < x.amount and x.status <> 'cancelled' and x.due_date < current_date) as overdue
       from portal.invoice_installments x where x.invoice_id = i.id
     ) ii on true
     where i.order_id = $1 and i.voided_at is null`,
    [orderId]
  );
  const row = r.rows[0] || { invoiced: 0, applied: 0, has_overdue: false };
  // eCheqs aceptados pendientes (Tanda 4). Solo se consulta si el módulo está
  // prendido: la tabla echeq_details recién existe entonces, y una consulta
  // fallida acá ENVENENARÍA la transacción (aborted).
  let pending = 0;
  if (flags.echeq) {
    const e = await client.query(
      `select coalesce(sum(p.amount),0) as p from portal.payments p
       join portal.echeq_details e on e.payment_id = p.id
       where p.order_id = $1 and p.status = 'pending_accreditation'`,
      [orderId]
    );
    pending = Number(e.rows[0].p);
  }
  const state = computeOrderPaymentState({ invoiced: Number(row.invoiced), applied: Number(row.applied), hasOverdue: Boolean(row.has_overdue), pendingAccreditation: pending });
  await client.query(`update portal.quote_requests set payment_state = $2, updated_at = now() where id = $1`, [orderId, state]);
  return state;
}

async function postCreditMovement(client, payment, { effectiveDate } = {}) {
  return insertMovement(client, {
    clientId: payment.client_id, orderId: payment.order_id, paymentId: payment.id,
    movementType: "payment_credit",
    description: `Pago ${payment.payment_method}${payment.reference_number ? " ref " + payment.reference_number : ""}`,
    credit: Number(payment.amount), currency: payment.currency,
    effectiveDate: effectiveDate || payment.accounting_date || payment.payment_date, createdBy: payment.confirmed_by || payment.created_by
  });
}

// Crea un pago. status: 'informed' (transferencia informada por cliente/staff),
// 'confirmed' (staff lo verifica en el acto -> genera el crédito) o 'draft'.
export async function createPayment({ clientId = null, orderId = null, method, amount, paymentDate = null, accountingDate = null, reference = null, notes = null, documentId = null, status = "informed", createdBy, confirmedBy = null,
  payerName = null, payerTaxId = null, payerBankRef = null }) {
  if (!MONEY_METHODS.includes(method)) throw Object.assign(new Error("metodo_no_soportado_en_esta_etapa"), { statusCode: 400 });
  const amt = round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw Object.assign(new Error("monto_invalido"), { statusCode: 400 });
  if (!PAYMENT_STATUSES.includes(status)) throw Object.assign(new Error("estado_invalido"), { statusCode: 400 });
  if (paymentDate && !isValidDate(paymentDate)) throw Object.assign(new Error("fecha_invalida"), { statusCode: 400 });

  let resolvedClient = clientId;
  if (orderId) {
    const q = await pool.query(`select user_id from portal.quote_requests where id = $1`, [orderId]);
    if (!q.rows[0]) throw Object.assign(new Error("pedido_no_encontrado"), { statusCode: 404 });
    if (!resolvedClient) resolvedClient = q.rows[0].user_id;
  }
  if (!resolvedClient) throw Object.assign(new Error("cliente_requerido"), { statusCode: 400 });

  return withTransaction(async (client) => {
    const confirmed = status === "confirmed";
    const ins = await client.query(
      `insert into portal.payments
         (client_id, order_id, payment_method, amount, currency, payment_date, accounting_date, status,
          reference_number, notes, document_id, created_by, confirmed_by, confirmed_at,
          payer_name, payer_tax_id, payer_bank_ref)
       values ($1,$2,$3,$4,'ARS',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
      [resolvedClient, orderId, method, amt, paymentDate, confirmed ? (accountingDate || paymentDate || new Date().toISOString().slice(0, 10)) : accountingDate,
       status, reference, notes, documentId, createdBy, confirmed ? (confirmedBy || createdBy) : null, confirmed ? new Date() : null,
       payerName, payerTaxId, payerBankRef]
    );
    const payment = ins.rows[0];
    if (confirmed) {
      if (flags.currentAccount) await postCreditMovement(client, payment);
      await recomputeOrderState(client, orderId);
    }
    return payment;
  });
}

// Confirma un pago informado/borrador: genera el crédito en el mayor (una vez).
export async function confirmPayment(paymentId, { confirmedBy, accountingDate = null }) {
  return withTransaction(async (client) => {
    const p = (await client.query(`select * from portal.payments where id = $1 for update`, [paymentId])).rows[0];
    if (!p) throw Object.assign(new Error("pago_no_encontrado"), { statusCode: 404 });
    if (p.payment_method === "echeq") throw Object.assign(new Error("echeq_se_acredita_por_su_flujo"), { statusCode: 400 });
    if (p.status === "confirmed") return p;
    if (!["draft", "informed"].includes(p.status)) throw Object.assign(new Error("estado_no_confirmable"), { statusCode: 400 });
    const upd = (await client.query(
      `update portal.payments set status='confirmed', confirmed_by=$2, confirmed_at=now(),
         accounting_date = coalesce($3, accounting_date, payment_date, current_date), updated_at=now()
       where id=$1 returning *`,
      [paymentId, confirmedBy, accountingDate]
    )).rows[0];
    if (flags.currentAccount) await postCreditMovement(client, upd);
    await recomputeOrderState(client, upd.order_id);
    return upd;
  });
}

// Aplica un pago confirmado a cuotas. allocations: [{installmentId, amount}].
export async function applyPayment(paymentId, allocations, { actorId }) {
  const allocs = (Array.isArray(allocations) ? allocations : []).map((a) => ({ installmentId: a.installmentId, amount: round2(a.amount) })).filter((a) => a.installmentId && a.amount > 0);
  if (!allocs.length) throw Object.assign(new Error("sin_asignaciones"), { statusCode: 400 });
  return withTransaction(async (client) => {
    const p = (await client.query(`select * from portal.payments where id = $1 for update`, [paymentId])).rows[0];
    if (!p) throw Object.assign(new Error("pago_no_encontrado"), { statusCode: 404 });
    if (p.status !== "confirmed") throw Object.assign(new Error("pago_no_confirmado"), { statusCode: 400 });
    const allocated = Number((await client.query(`select coalesce(sum(amount_applied),0) s from portal.payment_allocations where payment_id=$1 and reversed_at is null`, [paymentId])).rows[0].s);
    const { available, sum } = validateAllocationPlan(p.amount, allocs, allocated);

    const ordersTouched = new Set();
    for (const a of allocs) {
      const inst = (await client.query(
        `select ii.*, i.client_id, i.order_id, i.voided_at from portal.invoice_installments ii
         join portal.invoices i on i.id = ii.invoice_id where ii.id = $1 for update`, [a.installmentId]
      )).rows[0];
      if (!inst) throw Object.assign(new Error("cuota_no_encontrada"), { statusCode: 404 });
      if (inst.voided_at) throw Object.assign(new Error("factura_anulada"), { statusCode: 400 });
      if (inst.client_id !== p.client_id) throw Object.assign(new Error("cuota_de_otro_cliente"), { statusCode: 400 });
      const pending = round2(Number(inst.amount) - Number(inst.paid_amount));
      if (a.amount > pending + 0.005) throw Object.assign(new Error("excede_saldo_de_la_cuota"), { statusCode: 400, detail: `Cuota debe ${pending}` });
      await client.query(`insert into portal.payment_allocations (payment_id, invoice_id, installment_id, amount_applied, created_by) values ($1,$2,$3,$4,$5)`,
        [paymentId, inst.invoice_id, inst.id, a.amount, actorId]);
      const newPaid = round2(Number(inst.paid_amount) + a.amount);
      await client.query(`update portal.invoice_installments set paid_amount=$2, status=$3, updated_at=now() where id=$1`, [inst.id, newPaid, installmentStatus(newPaid, Number(inst.amount))]);
      await refreshInvoiceStatus(client, inst.invoice_id);
      if (inst.order_id) ordersTouched.add(inst.order_id);
    }
    for (const oid of ordersTouched) await recomputeOrderState(client, oid);
    return { applied: sum, remaining: round2(available - sum) };
  });
}

async function refreshInvoiceStatus(client, invoiceId) {
  const r = await client.query(`select amount, paid_amount from portal.invoice_installments where invoice_id = $1`, [invoiceId]);
  const all = r.rows;
  const allPaid = all.length && all.every((x) => Number(x.paid_amount) >= Number(x.amount) - 0.005);
  const anyPaid = all.some((x) => Number(x.paid_amount) > 0);
  const status = allPaid ? "paid" : anyPaid ? "partially_paid" : "issued";
  await client.query(`update portal.invoices set status = case when voided_at is not null then 'voided' else $2 end, updated_at = now() where id = $1`, [invoiceId, status]);
}

// Reversa un pago confirmado: contramovimiento del crédito + des-aplica cuotas.
export async function reversePayment(paymentId, { actorId, reason = null }) {
  return withTransaction(async (client) => {
    const p = (await client.query(`select * from portal.payments where id = $1 for update`, [paymentId])).rows[0];
    if (!p) throw Object.assign(new Error("pago_no_encontrado"), { statusCode: 404 });
    if (p.status === "reversed") return { alreadyReversed: true };
    if (p.status !== "confirmed") throw Object.assign(new Error("solo_se_revierten_pagos_confirmados"), { statusCode: 400 });
    // des-aplicar
    const allocs = (await client.query(`select * from portal.payment_allocations where payment_id=$1 and reversed_at is null`, [paymentId])).rows;
    const ordersTouched = new Set();
    for (const a of allocs) {
      await client.query(`update portal.payment_allocations set reversed_at=now() where id=$1`, [a.id]);
      const inst = (await client.query(`select * from portal.invoice_installments where id=$1 for update`, [a.installment_id])).rows[0];
      if (inst) {
        const newPaid = round2(Math.max(0, Number(inst.paid_amount) - Number(a.amount_applied)));
        await client.query(`update portal.invoice_installments set paid_amount=$2, status=$3, updated_at=now() where id=$1`, [inst.id, newPaid, installmentStatus(newPaid, Number(inst.amount))]);
        if (a.invoice_id) { await refreshInvoiceStatus(client, a.invoice_id); }
      }
    }
    // contramovimiento del crédito
    const mov = (await client.query(`select id from portal.account_movements where payment_id=$1 and movement_type='payment_credit' and status='active'`, [paymentId])).rows[0];
    if (mov) await reverseMovement(mov.id, { createdBy: actorId, reason: reason || "Reversa de pago" });
    await client.query(`update portal.payments set status='reversed', reversed_at=now(), reversal_reason=$2, updated_at=now() where id=$1`, [paymentId, reason]);
    // recomputar estados
    const orderRow = await client.query(`select order_id from portal.payments where id=$1`, [paymentId]);
    if (orderRow.rows[0]?.order_id) ordersTouched.add(orderRow.rows[0].order_id);
    for (const oid of ordersTouched) await recomputeOrderState(client, oid);
    return { reversed: paymentId };
  });
}

export async function listPayments({ orderId = null, clientId = null }) {
  const conds = ["1=1"]; const params = [];
  if (orderId) { params.push(orderId); conds.push(`p.order_id = $${params.length}`); }
  if (clientId) { params.push(clientId); conds.push(`p.client_id = $${params.length}`); }
  const r = await pool.query(
    `select p.*, u.display_name as created_by_name, cb.display_name as confirmed_by_name,
            coalesce((select sum(amount_applied) from portal.payment_allocations a where a.payment_id=p.id and a.reversed_at is null),0) as applied_amount
     from portal.payments p
     left join portal.users u on u.id = p.created_by
     left join portal.users cb on cb.id = p.confirmed_by
     where ${conds.join(" and ")} order by p.created_at desc`,
    params
  );
  return r.rows;
}
