import express from "express";
import { pool } from "../db.js";
import { requireApproved, requireAdmin, requireCapability } from "../middleware.js";
import { requireFlag, flags } from "../featureFlags.js";
import { recordAudit } from "../audit.js";
import { createInvoice, listInvoices, voidInvoice, setOrderPaymentCondition, PAYMENT_CONDITIONS, INVOICE_TYPES } from "../finance/invoices.js";

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
