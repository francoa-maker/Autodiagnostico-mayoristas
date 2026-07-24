import express from "express";
import { pool } from "../db.js";
import { requireApproved, requireCapability } from "../middleware.js";
import { requireFlag } from "../featureFlags.js";
import { can, isSuperadmin } from "../permissions.js";
import { recordAudit } from "../audit.js";
import { setPreparedQuantity, registerSerials, removeSerial, listSerialsByOrder } from "../logistics/serials.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const router = express.Router();
const LOCKED_STATES = ["dispatched", "delivered"];

// Pedidos autorizados para preparación (SIN datos financieros).
router.get("/logistics/orders", requireFlag("serialNumbers"), requireCapability("logistics.prepare"), async (req, res) => {
  const r = await pool.query(
    `select q.id, q.request_number, q.logistics_status, q.authorized_at,
            u.display_name, u.company_name, u.client_code,
            u.ship_street, u.ship_number, u.ship_city, u.ship_province
     from portal.quote_requests q join portal.users u on u.id = q.user_id
     where q.logistics_status in ('authorized','preparing','ready','dispatched')
     order by q.authorized_at desc nulls last, q.submitted_at desc`
  );
  res.json({ orders: r.rows });
});

// Detalle de un pedido para logística: ítems con cantidades + seriales (sin $).
router.get("/logistics/orders/:id", requireFlag("serialNumbers"), requireCapability("logistics.prepare"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid_id" });
  const q = (await pool.query(
    `select q.id, q.request_number, q.logistics_status, u.display_name, u.company_name, u.client_code,
            u.ship_street, u.ship_number, u.ship_floor, u.ship_apartment, u.ship_postal_code, u.ship_city, u.ship_province, u.ship_phone, u.ship_notes
     from portal.quote_requests q join portal.users u on u.id = q.user_id where q.id = $1`, [req.params.id]
  )).rows[0];
  if (!q) return res.status(404).json({ error: "not_found" });
  const items = (await pool.query(
    `select qi.id, qi.sku_snapshot, qi.product_name_snapshot, qi.quantity, qi.prepared_quantity, qi.product_id,
            (select count(*)::int from portal.order_item_serial_numbers s where s.order_item_id = qi.id and s.status = 'assigned') as serial_count
     from portal.quote_items qi where qi.quote_request_id = $1 order by qi.sort_order nulls last, qi.created_at`, [req.params.id]
  )).rows;
  const serials = await listSerialsByOrder(req.params.id);
  res.json({ order: q, items, serials });
});

router.patch("/logistics/order-items/:itemId/prepared", requireFlag("serialNumbers"), requireCapability("logistics.prepare"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.itemId))) return res.status(400).json({ error: "invalid_id" });
  try {
    const r = await setPreparedQuantity(req.params.itemId, req.body?.quantity, req.user.id);
    res.json(r);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error); res.status(500).json({ error: "prepared_failed" });
  }
});

async function orderLocked(orderItemId) {
  const r = await pool.query(
    `select q.logistics_status from portal.quote_items qi join portal.quote_requests q on q.id = qi.quote_request_id where qi.id = $1`, [orderItemId]
  );
  return r.rows[0] && LOCKED_STATES.includes(r.rows[0].logistics_status);
}

router.post("/logistics/order-items/:itemId/serials", requireFlag("serialNumbers"), requireCapability("logistics.serial_numbers.create"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.itemId))) return res.status(400).json({ error: "invalid_id" });
  if (await orderLocked(req.params.itemId) && !isSuperadmin(req.user.role)) {
    return res.status(403).json({ error: "pedido_despachado", detail: "El pedido está despachado/entregado; solo Superadmin puede corregir." });
  }
  try {
    const r = await registerSerials(req.params.itemId, req.body?.serials || [], req.user.id);
    await recordAudit({ actorUserId: req.user.id, action: "serial.register", entityType: "quote_item", entityId: req.params.itemId, metadata: { count: r.inserted } });
    res.status(201).json(r);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    console.error(error); res.status(500).json({ error: "serial_register_failed" });
  }
});

router.delete("/logistics/serials/:id", requireFlag("serialNumbers"), requireCapability("logistics.serial_numbers.remove"), async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid_id" });
  const ok = await removeSerial(req.params.id, { reason: req.body?.reason || null, actorId: req.user.id });
  if (!ok) return res.status(404).json({ error: "not_found_or_not_assigned" });
  await recordAudit({ actorUserId: req.user.id, action: "serial.remove", entityType: "order_item_serial", entityId: req.params.id, metadata: { reason: req.body?.reason || null } });
  res.json({ ok: true });
});

// Trazabilidad para Ventas/Superadmin (solo lectura): seriales de un pedido.
router.get("/admin/orders/:id/serials", requireFlag("serialNumbers"), requireApproved, async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid_id" });
  if (!can(req.user, "sales.serial_numbers.view") && !can(req.user, "logistics.serial_numbers.view")) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json({ serials: await listSerialsByOrder(req.params.id) });
});

export default router;
