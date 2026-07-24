import express from "express";
import { pool } from "../db.js";
import { requireApproved, requireAdmin, requireCapability } from "../middleware.js";
import { requireFlag, flags } from "../featureFlags.js";
import { recordAudit } from "../audit.js";
import { createInvoice, listInvoices, voidInvoice, setOrderPaymentCondition, PAYMENT_CONDITIONS, INVOICE_TYPES } from "../finance/invoices.js";
import { computeClientBalance, listMovements, createAdjustment, reverseMovement } from "../finance/ledger.js";
import { createPayment, confirmPayment, applyPayment, reversePayment, listPayments, PAYMENT_METHODS } from "../finance/payments.js";
import { createEcheq, acceptEcheq, accreditEcheq, rejectEcheq, listEcheqs } from "../finance/echeq.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const router = express.Router();

// Estado de los módulos financieros (para que la UI muestre/oculte paneles).
// No va detrás del flag: si está apagado, devuelve financial:false y la UI no
// muestra nada.
router.get("/admin/finance/status", requireAdmin, (req, res) => {
  res.json({
    financial: flags.financial,
    currentAccount: flags.currentAccount,
    echeq: flags.echeq,
    serialNumbers: flags.serialNumbers,
    paymentConditions: PAYMENT_CONDITIONS,
    invoiceTypes: INVOICE_TYPES
  });
});

// --- Facturas (admin) ---
router.get("/admin/orders/:orderId/invoices", requireFlag("financial"), requireCapability("invoices.view"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  const invoices = await listInvoices({ orderId: req.params.orderId });
  res.json({ invoices });
});

router.post("/admin/orders/:orderId/invoices", requireFlag("financial"), requireCapability("invoices.manage"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  const b = req.body || {};
  try {
    const invoice = await createInvoice({
      orderId: req.params.orderId,
      invoiceType: b.invoiceType || "B",
      pointOfSale: b.pointOfSale || null,
      invoiceNumber: b.invoiceNumber || null,
      issueDate: b.issueDate || null,
      totalAmount: b.totalAmount,
      currency: b.currency || "ARS",
      installments: Array.isArray(b.installments) ? b.installments : [],
      visibleToCustomer: Boolean(b.visibleToCustomer),
      documentId: b.documentId && UUID_RE.test(String(b.documentId)) ? b.documentId : null,
      notes: b.notes || null,
      uploadedBy: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "invoice.create", entityType: "invoice", entityId: invoice.id, after: { order_id: invoice.order_id, total: invoice.total_amount, type: invoice.invoice_type } });
    res.status(201).json({ invoice });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error);
    res.status(500).json({ error: "invoice_create_failed", detail: error.message });
  }
});

router.post("/admin/invoices/:invoiceId/void", requireFlag("financial"), requireCapability("invoices.manage"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.invoiceId))) return res.status(400).json({ error: "invalid_id" });
  const voided = await voidInvoice(req.params.invoiceId, req.user.id);
  if (!voided) return res.status(404).json({ error: "not_found_or_already_voided" });
  await recordAudit({ actorUserId: req.user.id, action: "invoice.void", entityType: "invoice", entityId: req.params.invoiceId });
  res.json({ invoice: voided });
});

router.patch("/admin/orders/:orderId/payment-condition", requireFlag("financial"), requireCapability("invoices.manage"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  try {
    const r = await setOrderPaymentCondition({
      orderId: req.params.orderId,
      condition: req.body?.condition ?? null,
      detail: req.body?.detail ?? null,
      saveAsClientDefault: Boolean(req.body?.saveAsClientDefault),
      actorId: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "order.payment_condition.update", entityType: "quote_request", entityId: req.params.orderId, after: r });
    res.json(r);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: "payment_condition_failed" });
  }
});

// --- Cuenta corriente (admin) ---
router.get("/admin/clients/:clientId/account", requireFlag("currentAccount"), requireCapability("account.view"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.clientId))) return res.status(400).json({ error: "invalid_id" });
  const [balance, movements] = await Promise.all([computeClientBalance(req.params.clientId), listMovements(req.params.clientId)]);
  res.json({ balance, movements });
});

// Cuenta corriente del cliente de un pedido (para el panel del editor).
router.get("/admin/orders/:orderId/account", requireFlag("currentAccount"), requireCapability("account.view"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  const q = await pool.query(`select user_id from portal.quote_requests where id = $1`, [req.params.orderId]);
  if (!q.rows[0]) return res.status(404).json({ error: "not_found" });
  const clientId = q.rows[0].user_id;
  const [balance, movements] = await Promise.all([computeClientBalance(clientId), listMovements(clientId)]);
  res.json({ clientId, balance, movements });
});

router.post("/admin/clients/:clientId/adjustments", requireFlag("currentAccount"), requireCapability("account.manage"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.clientId))) return res.status(400).json({ error: "invalid_id" });
  try {
    const mov = await createAdjustment({
      clientId: req.params.clientId, type: req.body?.type, amount: req.body?.amount,
      description: req.body?.description || null, orderId: req.body?.orderId && UUID_RE.test(String(req.body.orderId)) ? req.body.orderId : null,
      createdBy: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "account.adjustment", entityType: "account_movement", entityId: mov.id, after: { type: mov.movement_type, debit: mov.debit_amount, credit: mov.credit_amount } });
    res.status(201).json({ movement: mov });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error); res.status(500).json({ error: "adjustment_failed" });
  }
});

router.post("/admin/movements/:movementId/reverse", requireFlag("currentAccount"), requireCapability("account.manage"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.movementId))) return res.status(400).json({ error: "invalid_id" });
  try {
    const r = await reverseMovement(req.params.movementId, { createdBy: req.user.id, reason: req.body?.reason || null });
    await recordAudit({ actorUserId: req.user.id, action: "account.movement.reverse", entityType: "account_movement", entityId: req.params.movementId, metadata: r });
    res.json(r);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error); res.status(500).json({ error: "reverse_failed" });
  }
});

// --- Pagos (admin) ---
router.get("/admin/orders/:orderId/payments", requireFlag("financial"), requireCapability("payments.view"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  const payments = await listPayments({ orderId: req.params.orderId });
  res.json({ payments });
});

router.post("/admin/orders/:orderId/payments", requireFlag("financial"), requireCapability("payments.register"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  const b = req.body || {};
  try {
    const payment = await createPayment({
      orderId: req.params.orderId, method: b.method, amount: b.amount,
      paymentDate: b.paymentDate || null, accountingDate: b.accountingDate || null,
      reference: b.reference || null, notes: b.notes || null,
      documentId: b.documentId && UUID_RE.test(String(b.documentId)) ? b.documentId : null,
      status: b.status === "informed" ? "informed" : "confirmed", // por defecto el staff confirma en el acto
      createdBy: req.user.id, confirmedBy: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "payment.create", entityType: "payment", entityId: payment.id, after: { method: payment.payment_method, amount: payment.amount, status: payment.status } });
    res.status(201).json({ payment });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error); res.status(500).json({ error: "payment_create_failed", detail: error.message });
  }
});

router.post("/admin/payments/:paymentId/confirm", requireFlag("financial"), requireCapability("payments.confirm"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.paymentId))) return res.status(400).json({ error: "invalid_id" });
  try {
    const payment = await confirmPayment(req.params.paymentId, { confirmedBy: req.user.id, accountingDate: req.body?.accountingDate || null });
    await recordAudit({ actorUserId: req.user.id, action: "payment.confirm", entityType: "payment", entityId: req.params.paymentId });
    res.json({ payment });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error); res.status(500).json({ error: "payment_confirm_failed" });
  }
});

router.post("/admin/payments/:paymentId/apply", requireFlag("financial"), requireCapability("payments.apply"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.paymentId))) return res.status(400).json({ error: "invalid_id" });
  try {
    const r = await applyPayment(req.params.paymentId, req.body?.allocations || [], { actorId: req.user.id });
    await recordAudit({ actorUserId: req.user.id, action: "payment.apply", entityType: "payment", entityId: req.params.paymentId, after: r });
    res.json(r);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error); res.status(500).json({ error: "payment_apply_failed" });
  }
});

router.post("/admin/payments/:paymentId/reverse", requireFlag("financial"), requireCapability("payments.reverse"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.paymentId))) return res.status(400).json({ error: "invalid_id" });
  try {
    const r = await reversePayment(req.params.paymentId, { actorId: req.user.id, reason: req.body?.reason || null });
    await recordAudit({ actorUserId: req.user.id, action: "payment.reverse", entityType: "payment", entityId: req.params.paymentId, metadata: r });
    res.json(r);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error); res.status(500).json({ error: "payment_reverse_failed" });
  }
});

// Cliente informa una transferencia (queda 'informed', sin crédito hasta que
// Ventas/Administración la confirme). No puede confirmar ni aplicar.
router.post("/orders/:orderId/payments/inform", requireFlag("financial"), requireApproved, async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  const own = await pool.query(`select user_id from portal.quote_requests where id = $1`, [req.params.orderId]);
  if (!own.rows[0]) return res.status(404).json({ error: "not_found" });
  if (own.rows[0].user_id !== req.user.id) return res.status(403).json({ error: "forbidden" });
  const b = req.body || {};
  try {
    const payment = await createPayment({
      clientId: req.user.id, orderId: req.params.orderId, method: "bank_transfer", amount: b.amount,
      paymentDate: b.paymentDate || null, reference: b.reference || null, notes: b.notes || null,
      documentId: b.documentId && UUID_RE.test(String(b.documentId)) ? b.documentId : null,
      status: "informed", createdBy: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "payment.inform", entityType: "payment", entityId: payment.id, after: { amount: payment.amount } });
    res.status(201).json({ payment: { id: payment.id, status: payment.status, amount: payment.amount } });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error); res.status(500).json({ error: "payment_inform_failed" });
  }
});

// --- eCheqs (admin) ---
router.get("/admin/orders/:orderId/echeqs", requireFlag("echeq"), requireCapability("echeq.view"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  res.json({ echeqs: await listEcheqs({ orderId: req.params.orderId }) });
});
router.post("/admin/orders/:orderId/echeqs", requireFlag("echeq"), requireCapability("echeq.manage"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  const b = req.body || {};
  try {
    const r = await createEcheq({
      orderId: req.params.orderId, amount: b.amount, echeqNumber: b.echeqNumber || null, bankName: b.bankName || null,
      issuerName: b.issuerName || null, issuerTaxId: b.issuerTaxId || null, issueDate: b.issueDate || null,
      paymentDate: b.paymentDate || null, expectedCreditDate: b.expectedCreditDate || null,
      documentId: b.documentId && UUID_RE.test(String(b.documentId)) ? b.documentId : null, notes: b.notes || null, createdBy: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "echeq.create", entityType: "echeq", entityId: r.echeq.id, after: { amount: r.payment.amount } });
    res.status(201).json(r);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error); res.status(500).json({ error: "echeq_create_failed" });
  }
});
function echeqAction(fn, action) {
  return async (req, res) => {
    if (!UUID_RE.test(String(req.params.echeqId))) return res.status(400).json({ error: "invalid_id" });
    try {
      const r = await fn(req.params.echeqId, { ...req.body, actorId: req.user.id });
      await recordAudit({ actorUserId: req.user.id, action, entityType: "echeq", entityId: req.params.echeqId });
      res.json(r);
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
      console.error(error); res.status(500).json({ error: action + "_failed" });
    }
  };
}
router.post("/admin/echeqs/:echeqId/accept", requireFlag("echeq"), requireCapability("echeq.manage"), echeqAction(acceptEcheq, "echeq.accept"));
router.post("/admin/echeqs/:echeqId/accredit", requireFlag("echeq"), requireCapability("echeq.manage"), echeqAction(accreditEcheq, "echeq.accredit"));
router.post("/admin/echeqs/:echeqId/reject", requireFlag("echeq"), requireCapability("echeq.manage"), echeqAction(rejectEcheq, "echeq.reject"));

// Cuenta corriente del propio cliente.
router.get("/account", requireFlag("currentAccount"), requireApproved, async (req, res) => {
  const [balance, movements] = await Promise.all([computeClientBalance(req.user.id), listMovements(req.user.id)]);
  res.json({ balance, movements });
});

// --- Facturas visibles para el cliente (solo las propias) ---
router.get("/orders/:orderId/invoices", requireFlag("financial"), requireApproved, async (req, res) => {
  if (!UUID_RE.test(String(req.params.orderId))) return res.status(400).json({ error: "invalid_id" });
  const own = await pool.query(`select user_id from portal.quote_requests where id = $1`, [req.params.orderId]);
  if (!own.rows[0]) return res.status(404).json({ error: "not_found" });
  if (own.rows[0].user_id !== req.user.id && req.user.role !== "admin" && req.user.role !== "superadmin") {
    return res.status(403).json({ error: "forbidden" });
  }
  const invoices = await listInvoices({ orderId: req.params.orderId, onlyVisible: true });
  res.json({ invoices });
});

export default router;
