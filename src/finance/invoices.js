// Servicio de facturas + vencimientos (Tanda 1). La factura se carga
// manualmente (PDF opcional en Drive). Aun con un vencimiento se crea 1 cuota
// por el total. La aplicación de pagos (Tanda 3) actualizará paid_amount; acá
// el estado de cada cuota se computa al leer (overdue por fecha).
import { pool, withTransaction } from "../db.js";

export const PAYMENT_CONDITIONS = [
  "contado", "transferencia_anticipada", "efectivo", "cuenta_corriente", "echeq", "mixto", "personalizado"
];
export const INVOICE_TYPES = ["A", "B", "C", "E", "nota_credito", "nota_debito", "otro"];

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function isValidDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

// Estado a mostrar de una cuota (deriva de paid_amount + due_date).
export function installmentDisplayStatus(inst, today = new Date()) {
  const amount = Number(inst.amount);
  const paid = Number(inst.paid_amount);
  if (inst.status === "cancelled") return "cancelled";
  if (paid >= amount - 0.005) return "paid";
  const due = new Date(inst.due_date + "T23:59:59");
  const overdue = due < today;
  if (paid > 0) return overdue ? "overdue" : "partially_paid";
  return overdue ? "overdue" : "pending";
}

// Normaliza y valida las cuotas contra el total. Función pura (testeable sin
// base). Si no hay cuotas, crea una sola por el total con vencimiento issueDate.
// Lanza error (statusCode 400) si alguna fecha/monto es inválido o si la suma
// de las cuotas no coincide con el total.
export function normalizeInstallments(installments, total, issueDate) {
  let insts = Array.isArray(installments) ? installments : [];
  insts = insts.map((i) => ({ dueDate: i.dueDate, amount: round2(i.amount) })).filter((i) => i.amount != null && !Number.isNaN(i.amount));
  if (!insts.length) insts = [{ dueDate: issueDate, amount: round2(total) }];
  for (const i of insts) {
    if (!isValidDate(i.dueDate)) throw Object.assign(new Error("vencimiento_fecha_invalida"), { statusCode: 400 });
    if (!Number.isFinite(i.amount) || i.amount < 0) throw Object.assign(new Error("vencimiento_monto_invalido"), { statusCode: 400 });
  }
  const sum = round2(insts.reduce((a, i) => a + i.amount, 0));
  if (Math.abs(sum - round2(total)) > 0.01) {
    throw Object.assign(new Error("suma_cuotas_distinta_al_total"), { statusCode: 400, detail: `Cuotas suman ${sum}, total ${round2(total)}` });
  }
  return insts;
}

// Crea una factura + sus cuotas. installments: [{dueDate, amount}]. Si viene
// vacío, se crea una sola cuota por el total con vencimiento issueDate.
export async function createInvoice({
  orderId = null, clientId = null, invoiceType = "B", pointOfSale = null, invoiceNumber = null,
  issueDate = null, totalAmount, currency = "ARS", installments = [], visibleToCustomer = false,
  documentId = null, notes = null, uploadedBy
}) {
  const total = round2(totalAmount);
  if (!Number.isFinite(total) || total < 0) throw Object.assign(new Error("total_invalido"), { statusCode: 400 });
  if (!INVOICE_TYPES.includes(invoiceType)) throw Object.assign(new Error("tipo_factura_invalido"), { statusCode: 400 });
  const issue = isValidDate(issueDate) ? issueDate : new Date().toISOString().slice(0, 10);

  // Resolver cliente desde el pedido si no vino explícito.
  let resolvedClient = clientId;
  if (orderId) {
    const q = await pool.query(`select user_id from portal.quote_requests where id = $1`, [orderId]);
    if (!q.rows[0]) throw Object.assign(new Error("pedido_no_encontrado"), { statusCode: 404 });
    if (!resolvedClient) resolvedClient = q.rows[0].user_id;
  }

  const insts = normalizeInstallments(installments, total, issue);

  return withTransaction(async (client) => {
    const inv = await client.query(
      `insert into portal.invoices
         (client_id, order_id, invoice_type, point_of_sale, invoice_number, issue_date, total_amount,
          currency, status, document_id, visible_to_customer, notes, uploaded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'issued',$9,$10,$11,$12) returning *`,
      [resolvedClient, orderId, invoiceType, pointOfSale, invoiceNumber, issue, total, currency,
       documentId, Boolean(visibleToCustomer), notes, uploadedBy]
    );
    const invoice = inv.rows[0];
    let n = 0;
    for (const i of insts) {
      n++;
      await client.query(
        `insert into portal.invoice_installments (invoice_id, installment_number, due_date, amount)
         values ($1,$2,$3,$4)`,
        [invoice.id, n, i.dueDate, i.amount]
      );
    }
    return invoice;
  });
}

export async function listInvoices({ orderId = null, clientId = null, onlyVisible = false }) {
  const conds = ["1=1"];
  const params = [];
  if (orderId) { params.push(orderId); conds.push(`i.order_id = $${params.length}`); }
  if (clientId) { params.push(clientId); conds.push(`i.client_id = $${params.length}`); }
  if (onlyVisible) conds.push("i.visible_to_customer = true");
  const invs = await pool.query(
    `select i.*, u.display_name as uploaded_by_name
     from portal.invoices i left join portal.users u on u.id = i.uploaded_by
     where ${conds.join(" and ")} order by i.issue_date desc, i.created_at desc`,
    params
  );
  if (!invs.rows.length) return [];
  const ids = invs.rows.map((r) => r.id);
  const insts = await pool.query(
    `select * from portal.invoice_installments where invoice_id = any($1::uuid[]) order by installment_number`,
    [ids]
  );
  const byInvoice = new Map(ids.map((id) => [id, []]));
  for (const it of insts.rows) {
    byInvoice.get(it.invoice_id)?.push({ ...it, display_status: installmentDisplayStatus(it) });
  }
  return invs.rows.map((inv) => ({ ...inv, installments: byInvoice.get(inv.id) || [] }));
}

export async function voidInvoice(invoiceId, actorId) {
  const r = await pool.query(
    `update portal.invoices set voided_at = now(), status = 'voided', updated_at = now()
     where id = $1 and voided_at is null returning *`,
    [invoiceId]
  );
  return r.rows[0] || null;
}

// Guarda la condición de pago del pedido (snapshot). Si saveAsClientDefault,
// además actualiza el default del cliente (no afecta pedidos anteriores).
export async function setOrderPaymentCondition({ orderId, condition, detail = null, saveAsClientDefault = false, actorId }) {
  if (condition != null && !PAYMENT_CONDITIONS.includes(condition)) {
    throw Object.assign(new Error("condicion_invalida"), { statusCode: 400 });
  }
  const q = await pool.query(`select user_id from portal.quote_requests where id = $1`, [orderId]);
  if (!q.rows[0]) throw Object.assign(new Error("pedido_no_encontrado"), { statusCode: 404 });
  const snapshot = { condition, detail, set_by: actorId, set_at: new Date().toISOString() };
  await pool.query(
    `update portal.quote_requests set payment_condition = $2, payment_condition_snapshot = $3, updated_at = now() where id = $1`,
    [orderId, condition, JSON.stringify(snapshot)]
  );
  if (saveAsClientDefault) {
    await pool.query(`update portal.users set default_payment_term = $2, updated_at = now() where id = $1`, [q.rows[0].user_id, condition]);
  }
  return { condition, saved_as_default: Boolean(saveAsClientDefault) };
}
