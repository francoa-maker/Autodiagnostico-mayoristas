import { pool, withTransaction } from "../db.js";
import { flags } from "../featureFlags.js";
import { insertMovement } from "./ledger.js";
import { MONEY_METHODS, recomputeOrderState, reversePayment } from "./payments.js";

const CREDIT_CATEGORIES = ["devolucion", "reclamo", "reintegro_envio", "diferencia_comercial", "otro"];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const validDate = (s) => !s || (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s));
function fail(message, statusCode = 400, detail = null) { throw Object.assign(new Error(message), { statusCode, detail }); }
function installmentStatus(paid, amount) { return paid >= amount - 0.005 ? "paid" : paid > 0 ? "partially_paid" : "pending"; }

async function refreshInvoiceStatus(client, invoiceId) {
  const rows = (await client.query(`select amount,paid_amount from portal.invoice_installments where invoice_id=$1`, [invoiceId])).rows;
  const allPaid = rows.length && rows.every((x) => Number(x.paid_amount) >= Number(x.amount) - 0.005);
  const anyPaid = rows.some((x) => Number(x.paid_amount) > 0);
  await client.query(`update portal.invoices set status=case when voided_at is not null then 'voided' else $2 end,updated_at=now() where id=$1`, [invoiceId, allPaid ? "paid" : anyPaid ? "partially_paid" : "issued"]);
}

async function applyRows(client, payment, allocations, actorId) {
  const rows = (Array.isArray(allocations) ? allocations : []).map((a) => ({ installmentId: a.installmentId, amount: round2(a.amount) })).filter((a) => a.installmentId && a.amount > 0);
  const sum = round2(rows.reduce((acc, row) => acc + row.amount, 0));
  if (!rows.length) return { applied: 0, remaining: Number(payment.amount) };
  if (sum > Number(payment.amount) + 0.005) fail("excede_saldo_del_pago", 400, `Disponible ${payment.amount}`);
  const orders = new Set();
  for (const row of rows) {
    const inst = (await client.query(
      `select ii.*,i.client_id,i.order_id,i.voided_at from portal.invoice_installments ii join portal.invoices i on i.id=ii.invoice_id where ii.id=$1 for update`,
      [row.installmentId]
    )).rows[0];
    if (!inst) fail("cuota_no_encontrada", 404);
    if (inst.voided_at) fail("factura_anulada");
    if (inst.client_id !== payment.client_id) fail("cuota_de_otro_cliente");
    const pending = round2(Number(inst.amount) - Number(inst.paid_amount));
    if (row.amount > pending + 0.005) fail("excede_saldo_de_la_cuota", 400, `Cuota debe ${pending}`);
    await client.query(`insert into portal.payment_allocations(payment_id,invoice_id,installment_id,amount_applied,created_by) values($1,$2,$3,$4,$5)`, [payment.id, inst.invoice_id, inst.id, row.amount, actorId]);
    const paid = round2(Number(inst.paid_amount) + row.amount);
    await client.query(`update portal.invoice_installments set paid_amount=$2,status=$3,updated_at=now() where id=$1`, [inst.id, paid, installmentStatus(paid, Number(inst.amount))]);
    await refreshInvoiceStatus(client, inst.invoice_id);
    if (inst.order_id) orders.add(inst.order_id);
  }
  for (const orderId of orders) await recomputeOrderState(client, orderId);
  return { applied: sum, remaining: round2(Number(payment.amount) - sum), orderIds: [...orders] };
}

export async function registerClientPayment({ clientId, orderId = null, method, amount, paymentDate = null, accountingDate = null, reference = null, notes = null, documentId = null, payerName = null, payerTaxId = null, payerBankRef = null, status = "confirmed", allocations = [], actorId }) {
  if (!MONEY_METHODS.includes(method)) fail("metodo_no_soportado_en_esta_etapa");
  const amt = round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) fail("monto_invalido");
  if (!validDate(paymentDate) || !validDate(accountingDate)) fail("fecha_invalida");
  if (!["informed", "confirmed"].includes(status)) fail("estado_invalido");
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [clientId]);
    if (orderId) {
      const own = (await client.query(`select user_id from portal.quote_requests where id=$1`, [orderId])).rows[0];
      if (!own) fail("pedido_no_encontrado", 404);
      if (own.user_id !== clientId) fail("pedido_de_otro_cliente");
    }
    const confirmed = status === "confirmed";
    const payment = (await client.query(
      `insert into portal.payments(client_id,order_id,payment_method,amount,currency,payment_date,accounting_date,status,reference_number,notes,document_id,created_by,confirmed_by,confirmed_at,payer_name,payer_tax_id,payer_bank_ref)
       values($1,$2,$3,$4,'ARS',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
      [clientId, orderId, method, amt, paymentDate, confirmed ? (accountingDate || paymentDate || new Date().toISOString().slice(0,10)) : accountingDate, status, reference, notes, documentId, actorId, confirmed ? actorId : null, confirmed ? new Date() : null, payerName, payerTaxId, payerBankRef]
    )).rows[0];
    if (confirmed && flags.currentAccount) {
      await insertMovement(client, { clientId, orderId, paymentId: payment.id, movementType: "payment_credit", description: `Pago ${method}${reference ? " ref "+reference : ""}`, credit: amt, effectiveDate: payment.accounting_date || payment.payment_date, createdBy: actorId });
    }
    const allocation = confirmed ? await applyRows(client, payment, allocations, actorId) : null;
    if (confirmed && orderId && (!allocation || !allocation.orderIds.length)) await recomputeOrderState(client, orderId);
    return { payment, allocation };
  });
}

export async function createCustomerCredit({ clientId, amount, category, description, effectiveDate = null, orderId = null, documentId = null, actorId }) {
  if (!flags.currentAccount) fail("modulo_cuenta_corriente_inactivo", 404);
  const amt = round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) fail("monto_invalido");
  if (!CREDIT_CATEGORIES.includes(category)) fail("motivo_credito_invalido");
  if (!String(description || "").trim()) fail("descripcion_requerida");
  if (!validDate(effectiveDate)) fail("fecha_invalida");
  return withTransaction(async (client) => {
    const exists = (await client.query(`select id from portal.users where id=$1`, [clientId])).rows[0];
    if (!exists) fail("cliente_no_encontrado", 404);
    if (orderId) {
      const order = (await client.query(`select user_id from portal.quote_requests where id=$1`, [orderId])).rows[0];
      if (!order) fail("pedido_no_encontrado", 404);
      if (order.user_id !== clientId) fail("pedido_de_otro_cliente");
    }
    return insertMovement(client, {
      clientId, orderId, movementType: "credit_adjustment", description: String(description).trim(), credit: amt,
      effectiveDate, createdBy: actorId, metadata: { category, documentId: documentId || null, source: "customer_credit" }
    });
  });
}

export async function applyCustomerCredit({ clientId, allocations, notes = null, actorId }) {
  if (!flags.currentAccount) fail("modulo_cuenta_corriente_inactivo", 404);
  const rows = (Array.isArray(allocations) ? allocations : []).map((a) => ({ installmentId: a.installmentId, amount: round2(a.amount) })).filter((a) => a.installmentId && a.amount > 0);
  if (!rows.length) fail("sin_asignaciones");
  const amount = round2(rows.reduce((acc, row) => acc + row.amount, 0));
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [clientId]);
    const total = Number((await client.query(`select coalesce(sum(debit_amount),0)-coalesce(sum(credit_amount),0) total from portal.account_movements where client_id=$1 and status='active'`, [clientId])).rows[0].total);
    const available = round2(Math.max(0, -total));
    if (amount > available + 0.005) fail("excede_saldo_a_favor", 400, `Disponible ${available}`);
    const payment = (await client.query(
      `insert into portal.payments(client_id,payment_method,amount,currency,payment_date,accounting_date,status,reference_number,notes,created_by,confirmed_by,confirmed_at)
       values($1,'customer_credit',$2,'ARS',current_date,current_date,'confirmed','SALDO-A-FAVOR',$3,$4,$4,now()) returning *`,
      [clientId, amount, notes, actorId]
    )).rows[0];
    const allocation = await applyRows(client, payment, rows, actorId);
    const orderId = allocation.orderIds.length === 1 ? allocation.orderIds[0] : null;
    await client.query(`update portal.payments set order_id=$2 where id=$1`, [payment.id, orderId]);
    await insertMovement(client, { clientId, orderId, paymentId: payment.id, movementType: "balance_applied", description: notes || "Aplicación de saldo a favor", debit: amount, createdBy: actorId, metadata: { allocations: rows.length } });
    return { payment: { ...payment, order_id: orderId }, allocation, availableBefore: available, availableAfter: round2(available-amount) };
  });
}

export async function reverseCustomerCredit(paymentId, { actorId, reason }) {
  if (!String(reason || "").trim()) fail("motivo_requerido");
  return withTransaction(async (client) => {
    const payment = (await client.query(`select * from portal.payments where id=$1 for update`, [paymentId])).rows[0];
    if (!payment) fail("pago_no_encontrado", 404);
    if (payment.payment_method !== "customer_credit") fail("metodo_invalido");
    if (payment.status === "reversed") return { alreadyReversed: true };
    const allocations = (await client.query(
      `select a.*,i.order_id from portal.payment_allocations a left join portal.invoices i on i.id=a.invoice_id where a.payment_id=$1 and a.reversed_at is null`, [paymentId]
    )).rows;
    const orders = new Set();
    for (const a of allocations) {
      await client.query(`update portal.payment_allocations set reversed_at=now() where id=$1`, [a.id]);
      const inst = (await client.query(`select * from portal.invoice_installments where id=$1 for update`, [a.installment_id])).rows[0];
      if (inst) {
        const paid = round2(Math.max(0, Number(inst.paid_amount)-Number(a.amount_applied)));
        await client.query(`update portal.invoice_installments set paid_amount=$2,status=$3,updated_at=now() where id=$1`, [inst.id, paid, installmentStatus(paid, Number(inst.amount))]);
        await refreshInvoiceStatus(client, a.invoice_id);
      }
      if (a.order_id) orders.add(a.order_id);
    }
    const original = (await client.query(`select * from portal.account_movements where payment_id=$1 and movement_type='balance_applied' order by created_at asc limit 1`, [paymentId])).rows[0];
    if (original) {
      const already = (await client.query(`select id from portal.account_movements where reversed_movement_id=$1`, [original.id])).rows[0];
      if (!already) await insertMovement(client, { clientId: original.client_id, orderId: original.order_id, paymentId, movementType: "payment_reversal", description: reason, credit: Number(original.debit_amount), createdBy: actorId, reversedMovementId: original.id, metadata: { reason } });
    }
    await client.query(`update portal.payments set status='reversed',reversed_at=now(),reversal_reason=$2,updated_at=now() where id=$1`, [paymentId, reason]);
    for (const orderId of orders) await recomputeOrderState(client, orderId);
    return { reversed: paymentId };
  });
}

export async function reverseRegisteredPayment(paymentId, { actorId, reason }) {
  if (!String(reason || "").trim()) fail("motivo_requerido");
  const payment = (await pool.query(`select payment_method from portal.payments where id=$1`, [paymentId])).rows[0];
  if (!payment) fail("pago_no_encontrado", 404);
  if (payment.payment_method === "customer_credit") return reverseCustomerCredit(paymentId, { actorId, reason });
  const orders = (await pool.query(
    `select distinct i.order_id from portal.payment_allocations a join portal.invoices i on i.id=a.invoice_id where a.payment_id=$1 and i.order_id is not null`,
    [paymentId]
  )).rows.map((row) => row.order_id);
  const result = await reversePayment(paymentId, { actorId, reason });
  for (const orderId of orders) await recomputeOrderState(pool, orderId);
  return result;
}

export { CREDIT_CATEGORIES };
