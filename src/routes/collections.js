import express from "express";
import { pool } from "../db.js";
import { requireCapability } from "../middleware.js";
import { requireFlag } from "../featureFlags.js";
import { recordAudit } from "../audit.js";
import { listInvoices } from "../finance/invoices.js";
import { listPayments } from "../finance/payments.js";
import { createEcheq, listEcheqs } from "../finance/echeq.js";
import { computeClientBalance, listMovements } from "../finance/ledger.js";
import { listReceivables, listOpenInstallments } from "../finance/receivables.js";
import {
  registerClientPayment, createCustomerCredit, applyCustomerCredit,
  reverseRegisteredPayment, CREDIT_CATEGORIES
} from "../finance/clientCollections.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const router = express.Router();
const validId = (value) => UUID_RE.test(String(value || ""));

router.get("/admin/finance/clients", requireFlag("financial"), requireCapability("financial.reports.view"), async (req, res) => {
  try {
    res.json(await listReceivables({
      search: req.query.search, filter: req.query.filter, sort: req.query.sort,
      direction: req.query.direction, limit: req.query.limit, offset: req.query.offset
    }));
  } catch (error) {
    console.error(error); res.status(500).json({ error: "receivables_failed", detail: error.message });
  }
});

router.get("/admin/clients/:clientId/open-installments", requireFlag("financial"), requireCapability("payments.view"), async (req, res) => {
  if (!validId(req.params.clientId)) return res.status(400).json({ error: "invalid_id" });
  res.json({ installments: await listOpenInstallments(req.params.clientId) });
});
router.get("/admin/clients/:clientId/invoices", requireFlag("financial"), requireCapability("invoices.view"), async (req, res) => {
  if (!validId(req.params.clientId)) return res.status(400).json({ error: "invalid_id" });
  res.json({ invoices: await listInvoices({ clientId: req.params.clientId }) });
});
router.get("/admin/clients/:clientId/payments", requireFlag("financial"), requireCapability("payments.view"), async (req, res) => {
  if (!validId(req.params.clientId)) return res.status(400).json({ error: "invalid_id" });
  res.json({ payments: await listPayments({ clientId: req.params.clientId }) });
});
router.get("/admin/clients/:clientId/echeqs", requireFlag("echeq"), requireCapability("echeq.view"), async (req, res) => {
  if (!validId(req.params.clientId)) return res.status(400).json({ error: "invalid_id" });
  res.json({ echeqs: await listEcheqs({ clientId: req.params.clientId }) });
});
router.get("/admin/clients/:clientId/account", requireFlag("currentAccount"), requireCapability("account.view"), async (req, res) => {
  if (!validId(req.params.clientId)) return res.status(400).json({ error: "invalid_id" });
  const client = (await pool.query(`select id,email,display_name,company_name,client_code,tax_cuit from portal.users where id=$1`, [req.params.clientId])).rows[0];
  if (!client) return res.status(404).json({ error: "not_found" });
  const [balance, movements] = await Promise.all([computeClientBalance(req.params.clientId), listMovements(req.params.clientId)]);
  res.json({ client, balance, movements });
});

router.post("/admin/clients/:clientId/payments", requireFlag("financial"), requireCapability("payments.register"), async (req, res) => {
  if (!validId(req.params.clientId)) return res.status(400).json({ error: "invalid_id" });
  const b = req.body || {};
  try {
    const result = await registerClientPayment({
      clientId: req.params.clientId,
      orderId: validId(b.orderId) ? b.orderId : null,
      method: b.method, amount: b.amount, paymentDate: b.paymentDate || null,
      accountingDate: b.accountingDate || null, reference: b.reference || null, notes: b.notes || null,
      documentId: validId(b.documentId) ? b.documentId : null,
      payerName: b.payerName || null, payerTaxId: b.payerTaxId || null, payerBankRef: b.payerBankRef || null,
      status: b.status === "informed" ? "informed" : "confirmed",
      allocations: Array.isArray(b.allocations) ? b.allocations : [], actorId: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "payment.create.client", entityType: "payment", entityId: result.payment.id, after: { amount: result.payment.amount, allocation: result.allocation } });
    res.status(201).json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error); res.status(500).json({ error: "payment_create_failed", detail: error.message });
  }
});

router.post("/admin/clients/:clientId/credits", requireFlag("currentAccount"), requireCapability("account.manage"), async (req, res) => {
  if (!validId(req.params.clientId)) return res.status(400).json({ error: "invalid_id" });
  const b = req.body || {};
  try {
    const movement = await createCustomerCredit({
      clientId: req.params.clientId, amount: b.amount, category: b.category,
      description: b.description, effectiveDate: b.effectiveDate || null,
      orderId: validId(b.orderId) ? b.orderId : null,
      documentId: validId(b.documentId) ? b.documentId : null, actorId: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "customer_credit.create", entityType: "account_movement", entityId: movement.id, after: { amount: movement.credit_amount, category: b.category } });
    res.status(201).json({ movement, categories: CREDIT_CATEGORIES });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error); res.status(500).json({ error: "customer_credit_create_failed" });
  }
});
router.post("/admin/clients/:clientId/credits/apply", requireFlag("currentAccount"), requireCapability("payments.apply"), async (req, res) => {
  if (!validId(req.params.clientId)) return res.status(400).json({ error: "invalid_id" });
  try {
    const result = await applyCustomerCredit({ clientId: req.params.clientId, allocations: req.body?.allocations || [], notes: req.body?.notes || null, actorId: req.user.id });
    await recordAudit({ actorUserId: req.user.id, action: "customer_credit.apply", entityType: "payment", entityId: result.payment.id, after: result.allocation });
    res.status(201).json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error); res.status(500).json({ error: "customer_credit_apply_failed" });
  }
});

// Se monta antes del router financiero existente para poder tratar el método
// customer_credit y recomputar todos los pedidos de una cobranza multi-pedido.
router.post("/admin/payments/:paymentId/reverse", requireFlag("financial"), requireCapability("payments.reverse"), async (req, res) => {
  if (!validId(req.params.paymentId)) return res.status(400).json({ error: "invalid_id" });
  try {
    const result = await reverseRegisteredPayment(req.params.paymentId, { actorId: req.user.id, reason: req.body?.reason || null });
    await recordAudit({ actorUserId: req.user.id, action: "payment.reverse.client", entityType: "payment", entityId: req.params.paymentId, metadata: result });
    res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error); res.status(500).json({ error: "payment_reverse_failed" });
  }
});

router.post("/admin/clients/:clientId/echeqs", requireFlag("echeq"), requireCapability("echeq.manage"), async (req, res) => {
  if (!validId(req.params.clientId)) return res.status(400).json({ error: "invalid_id" });
  const b = req.body || {};
  try {
    const orderId = validId(b.orderId) ? b.orderId : null;
    if (orderId) {
      const order = (await pool.query(`select user_id from portal.quote_requests where id=$1`, [orderId])).rows[0];
      if (!order) return res.status(404).json({ error: "pedido_no_encontrado" });
      if (order.user_id !== req.params.clientId) return res.status(400).json({ error: "pedido_de_otro_cliente" });
    }
    const result = await createEcheq({
      clientId: req.params.clientId, orderId,
      amount: b.amount, echeqNumber: b.echeqNumber || null, bankName: b.bankName || null,
      issuerName: b.issuerName || null, issuerTaxId: b.issuerTaxId || null, issueDate: b.issueDate || null,
      paymentDate: b.paymentDate || null, expectedCreditDate: b.expectedCreditDate || null,
      documentId: validId(b.documentId) ? b.documentId : null, notes: b.notes || null, createdBy: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "echeq.create.client", entityType: "echeq", entityId: result.echeq.id, after: { amount: result.payment.amount } });
    res.status(201).json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error); res.status(500).json({ error: "echeq_create_failed" });
  }
});

export default router;
