// Libro mayor de cuenta corriente (Tanda 2). Append-only: nunca se edita ni se
// borra un movimiento; para corregir se reversa (movimiento inverso + original
// status='reversed'). El saldo se calcula sumando movimientos activos.
import { pool, withTransaction } from "../db.js";
import { flags } from "../featureFlags.js";

export const MOVEMENT_TYPES = [
  "invoice_debit", "payment_credit", "credit_note", "debit_adjustment",
  "credit_adjustment", "balance_applied", "refund", "payment_reversal"
];

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// Inserta un movimiento usando un client de transacción existente (para
// atomicidad con la operación que lo origina, ej. emitir factura).
export async function insertMovement(client, m) {
  if (!MOVEMENT_TYPES.includes(m.movementType)) throw Object.assign(new Error("movimiento_invalido"), { statusCode: 400 });
  const r = await client.query(
    `insert into portal.account_movements
       (client_id, order_id, invoice_id, payment_id, movement_type, description,
        debit_amount, credit_amount, currency, effective_date, due_date, status, created_by, reversed_movement_id, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10, current_date),$11,'active',$12,$13,$14) returning *`,
    [m.clientId, m.orderId || null, m.invoiceId || null, m.paymentId || null, m.movementType, m.description || null,
     round2(m.debit || 0), round2(m.credit || 0), m.currency || "ARS", m.effectiveDate || null, m.dueDate || null,
     m.createdBy || null, m.reversedMovementId || null, JSON.stringify(m.metadata || {})]
  );
  return r.rows[0];
}

// Alta standalone (fuera de transacción) para ajustes manuales.
export async function createMovement(m) {
  return withTransaction((client) => insertMovement(client, m));
}

// Ajuste manual: debit_adjustment (aumenta deuda) o credit_adjustment (baja/genera a favor).
export async function createAdjustment({ clientId, type, amount, description, orderId = null, createdBy }) {
  if (type !== "debit_adjustment" && type !== "credit_adjustment") throw Object.assign(new Error("tipo_ajuste_invalido"), { statusCode: 400 });
  const amt = round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw Object.assign(new Error("monto_invalido"), { statusCode: 400 });
  return createMovement({
    clientId, orderId, movementType: type, description,
    debit: type === "debit_adjustment" ? amt : 0,
    credit: type === "credit_adjustment" ? amt : 0,
    createdBy
  });
}

// Reversa un movimiento con un ASIENTO COMPENSATORIO (append-only): inserta el
// inverso (débito<->crédito) que apunta al original con reversed_movement_id.
// El original NO se toca (sigue contando); original + inverso netean a cero. No
// se puede reversar dos veces ni reversar una reversa.
export async function reverseMovement(movementId, { createdBy, reason } = {}) {
  return withTransaction(async (client) => {
    const orig = (await client.query(`select * from portal.account_movements where id = $1 for update`, [movementId])).rows[0];
    if (!orig) throw Object.assign(new Error("movimiento_no_encontrado"), { statusCode: 404 });
    if (orig.reversed_movement_id) throw Object.assign(new Error("no_se_puede_reversar_una_reversa"), { statusCode: 400 });
    const already = await client.query(`select id from portal.account_movements where reversed_movement_id = $1`, [orig.id]);
    if (already.rows[0]) return { alreadyReversed: true };
    const inverse = await insertMovement(client, {
      clientId: orig.client_id, orderId: orig.order_id, invoiceId: orig.invoice_id, paymentId: orig.payment_id,
      movementType: "payment_reversal",
      description: reason || `Reversa de ${orig.movement_type}`,
      debit: Number(orig.credit_amount), credit: Number(orig.debit_amount),
      currency: orig.currency, createdBy, reversedMovementId: orig.id,
      metadata: { reverses: orig.id, reason: reason || null }
    });
    return { reversed: orig.id, inverse: inverse.id };
  });
}

export async function listMovements(clientId, { includeReversed = true } = {}) {
  const r = await pool.query(
    `select m.*, u.display_name as created_by_name,
            exists(select 1 from portal.account_movements x where x.reversed_movement_id = m.id) as is_reversed
     from portal.account_movements m left join portal.users u on u.id = m.created_by
     where m.client_id = $1
     order by m.effective_date desc, m.created_at desc`,
    [clientId]
  );
  return r.rows;
}

// Saldos separados: total (deuda), a favor, vencido, a vencer, pendiente de
// acreditación (eCheqs aceptados; 0 hasta Tanda 4).
export async function computeClientBalance(clientId) {
  const bal = await pool.query(
    `select coalesce(sum(debit_amount),0) - coalesce(sum(credit_amount),0) as total
     from portal.account_movements where client_id = $1 and status = 'active'`,
    [clientId]
  );
  const total = round2(bal.rows[0].total);
  const inst = await pool.query(
    `select
       coalesce(sum(case when ii.paid_amount < ii.amount and ii.status <> 'cancelled' and ii.due_date <  current_date then ii.amount - ii.paid_amount else 0 end),0) as overdue,
       coalesce(sum(case when ii.paid_amount < ii.amount and ii.status <> 'cancelled' and ii.due_date >= current_date then ii.amount - ii.paid_amount else 0 end),0) as to_due
     from portal.invoice_installments ii
     join portal.invoices i on i.id = ii.invoice_id
     where i.client_id = $1 and i.voided_at is null`,
    [clientId]
  );
  // eCheqs aceptados pendientes de acreditación (Tanda 4). Solo si el módulo
  // está prendido (la tabla echeq_details recién existe entonces).
  let pending = 0;
  if (flags.echeq) {
    const e = await pool.query(
      `select coalesce(sum(p.amount),0) as pending
       from portal.payments p join portal.echeq_details e on e.payment_id = p.id
       where p.client_id = $1 and p.status = 'pending_accreditation'`,
      [clientId]
    );
    pending = round2(e.rows[0].pending);
  }
  return {
    total,
    debt: Math.max(0, total),
    inFavor: Math.max(0, round2(-total)),
    overdue: round2(inst.rows[0].overdue),
    toDue: round2(inst.rows[0].to_due),
    pendingAccreditation: pending
  };
}
