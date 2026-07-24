// eCheqs (Tanda 4). Flujo de dos fases: la ACEPTACIÓN bancaria deja el pago
// "pendiente de acreditación" (no es dinero acreditado todavía); recién la
// ACREDITACIÓN real genera el crédito contable. Un eCheq es un payment con
// method='echeq' + una fila echeq_details.
import { pool, withTransaction } from "../db.js";
import { insertMovement, reverseMovement } from "./ledger.js";
import { recomputeOrderState } from "./payments.js";
import { flags } from "../featureFlags.js";

export const ECHEQ_STATUSES = ["received", "pending_bank_acceptance", "accepted", "pending_accreditation", "accredited", "rejected", "cancelled", "expired"];
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function isValidDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

export async function createEcheq(d) {
  const amt = round2(d.amount);
  if (!Number.isFinite(amt) || amt <= 0) throw Object.assign(new Error("monto_invalido"), { statusCode: 400 });
  let clientId = d.clientId || null;
  if (d.orderId) {
    const q = await pool.query(`select user_id from portal.quote_requests where id = $1`, [d.orderId]);
    if (!q.rows[0]) throw Object.assign(new Error("pedido_no_encontrado"), { statusCode: 404 });
    if (!clientId) clientId = q.rows[0].user_id;
  }
  if (!clientId) throw Object.assign(new Error("cliente_requerido"), { statusCode: 400 });
  for (const f of ["issueDate", "paymentDate", "expectedCreditDate"]) {
    if (d[f] && !isValidDate(d[f])) throw Object.assign(new Error(`${f}_invalida`), { statusCode: 400 });
  }
  return withTransaction(async (client) => {
    const pay = (await client.query(
      `insert into portal.payments (client_id, order_id, payment_method, amount, currency, payment_date, status, reference_number, notes, document_id, created_by)
       values ($1,$2,'echeq',$3,'ARS',$4,'informed',$5,$6,$7,$8) returning *`,
      [clientId, d.orderId || null, amt, d.paymentDate || null, d.echeqNumber || null, d.notes || null, d.documentId || null, d.createdBy]
    )).rows[0];
    const ech = (await client.query(
      `insert into portal.echeq_details
         (payment_id, echeq_number, bank_name, issuer_name, issuer_tax_id, issue_date, payment_date, received_at, expected_credit_date, status, notes)
       values ($1,$2,$3,$4,$5,$6,$7, now(), $8, 'pending_bank_acceptance', $9) returning *`,
      [pay.id, d.echeqNumber || null, d.bankName || null, d.issuerName || null, d.issuerTaxId || null, d.issueDate || null, d.paymentDate || null, d.expectedCreditDate || null, d.notes || null]
    )).rows[0];
    return { payment: pay, echeq: ech };
  });
}

// Aceptación bancaria: NO acredita dinero. Pasa a pendiente de acreditación.
export async function acceptEcheq(echeqId, { acceptedAt = null, expectedCreditDate = null, actorId }) {
  return withTransaction(async (client) => {
    const e = (await client.query(`select * from portal.echeq_details where id = $1 for update`, [echeqId])).rows[0];
    if (!e) throw Object.assign(new Error("echeq_no_encontrado"), { statusCode: 404 });
    if (!["received", "pending_bank_acceptance"].includes(e.status)) throw Object.assign(new Error("estado_no_aceptable"), { statusCode: 400 });
    const upd = (await client.query(
      `update portal.echeq_details set status='pending_accreditation', accepted_at = coalesce($2, now()),
         expected_credit_date = coalesce($3, expected_credit_date), updated_at = now() where id = $1 returning *`,
      [echeqId, acceptedAt, expectedCreditDate]
    )).rows[0];
    const p = (await client.query(`update portal.payments set status='pending_accreditation', updated_at=now() where id=$1 returning order_id`, [e.payment_id])).rows[0];
    await recomputeOrderState(client, p.order_id);
    return upd;
  });
}

// Acreditación real: genera el crédito. El pago queda 'confirmed' y se puede
// aplicar a facturas desde el panel de Pagos.
export async function accreditEcheq(echeqId, { actualCreditDate = null, actorId }) {
  return withTransaction(async (client) => {
    const e = (await client.query(`select * from portal.echeq_details where id = $1 for update`, [echeqId])).rows[0];
    if (!e) throw Object.assign(new Error("echeq_no_encontrado"), { statusCode: 404 });
    if (!["accepted", "pending_accreditation"].includes(e.status)) throw Object.assign(new Error("estado_no_acreditable"), { statusCode: 400 });
    const creditDate = isValidDate(actualCreditDate) ? actualCreditDate : new Date().toISOString().slice(0, 10);
    const upd = (await client.query(
      `update portal.echeq_details set status='accredited', actual_credit_date=$2, updated_at=now() where id=$1 returning *`,
      [echeqId, creditDate]
    )).rows[0];
    const pay = (await client.query(
      `update portal.payments set status='confirmed', confirmed_by=$2, confirmed_at=now(), accounting_date=$3, updated_at=now() where id=$1 returning *`,
      [e.payment_id, actorId, creditDate]
    )).rows[0];
    if (flags.currentAccount) {
      await insertMovement(client, {
        clientId: pay.client_id, orderId: pay.order_id, paymentId: pay.id, movementType: "payment_credit",
        description: `eCheq acreditado${e.echeq_number ? " N° " + e.echeq_number : ""}`,
        credit: Number(pay.amount), currency: pay.currency, effectiveDate: creditDate, createdBy: actorId
      });
    }
    await recomputeOrderState(client, pay.order_id);
    return { echeq: upd, payment: pay };
  });
}

export async function rejectEcheq(echeqId, { reason = null, actorId }) {
  return withTransaction(async (client) => {
    const e = (await client.query(`select * from portal.echeq_details where id = $1 for update`, [echeqId])).rows[0];
    if (!e) throw Object.assign(new Error("echeq_no_encontrado"), { statusCode: 404 });
    if (e.status === "accredited") throw Object.assign(new Error("echeq_ya_acreditado"), { statusCode: 400, detail: "Un eCheq acreditado se corrige reversando el pago." });
    const upd = (await client.query(`update portal.echeq_details set status='rejected', rejection_reason=$2, updated_at=now() where id=$1 returning *`, [echeqId, reason])).rows[0];
    const p = (await client.query(`update portal.payments set status='rejected', updated_at=now() where id=$1 returning order_id`, [e.payment_id])).rows[0];
    await recomputeOrderState(client, p.order_id);
    return upd;
  });
}

export async function listEcheqs({ orderId = null, clientId = null }) {
  const conds = ["p.payment_method = 'echeq'"]; const params = [];
  if (orderId) { params.push(orderId); conds.push(`p.order_id = $${params.length}`); }
  if (clientId) { params.push(clientId); conds.push(`p.client_id = $${params.length}`); }
  const r = await pool.query(
    `select e.*, p.amount, p.status as payment_status, p.order_id, p.client_id
     from portal.echeq_details e join portal.payments p on p.id = e.payment_id
     where ${conds.join(" and ")} order by e.created_at desc`,
    params
  );
  return r.rows;
}
