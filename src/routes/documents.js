import express from "express";
import { requireAdmin, requireApproved } from "../middleware.js";
import { recordAudit } from "../audit.js";
import { storageProviderName, getStorageProvider } from "../storage/index.js";
import {
  saveDocument, getDocumentForUser, downloadDocument, listDocuments,
  softDeleteDocument, maxBytes, DOCUMENT_TYPES
} from "../documents.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const router = express.Router();

// Estado del almacenamiento (para que la UI avise si falta configurar Drive).
router.get("/admin/documents/status", requireAdmin, (req, res) => {
  res.json({
    provider: storageProviderName(),
    configured: getStorageProvider().isConfigured(),
    maxMb: Number(process.env.DOCUMENTS_MAX_MB) || 25,
    types: DOCUMENT_TYPES
  });
});

// Subida (solo admin). El archivo llega como cuerpo crudo (express.raw); los
// metadatos por query. El MIME sale del Content-Type. Sin multer/dependencias.
router.post("/admin/documents", requireAdmin, express.raw({ type: () => true, limit: maxBytes() }), async (req, res) => {
  try {
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || !buffer.length) return res.status(400).json({ error: "archivo_vacio" });
    const { documentType, orderId, clientId, paymentId, shipmentId, filename, label } = req.query;
    if (orderId && !UUID_RE.test(String(orderId))) return res.status(400).json({ error: "order_id_invalido" });
    if (clientId && !UUID_RE.test(String(clientId))) return res.status(400).json({ error: "client_id_invalido" });
    const doc = await saveDocument({
      buffer,
      mimeType: req.headers["content-type"],
      originalFilename: String(filename || "documento"),
      documentType: String(documentType || ""),
      orderId: orderId || null,
      clientId: clientId || null,
      paymentId: paymentId && UUID_RE.test(String(paymentId)) ? paymentId : null,
      shipmentId: shipmentId && UUID_RE.test(String(shipmentId)) ? shipmentId : null,
      label: label || null,
      visibleToCustomer: String(req.query.visibleToCustomer) === "true",
      uploadedBy: req.user.id
    });
    await recordAudit({ actorUserId: req.user.id, action: "document.upload", entityType: "document", entityId: doc.id, metadata: { type: doc.document_type, order_id: doc.order_id, size: doc.file_size } });
    res.status(201).json({ document: { id: doc.id, document_type: doc.document_type, original_filename: doc.original_filename, stored_filename: doc.stored_filename, mime_type: doc.mime_type, file_size: doc.file_size, visible_to_customer: doc.visible_to_customer, created_at: doc.created_at } });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: "upload_failed", detail: error.message });
  }
});

// Listado admin (por pedido o cliente).
router.get("/admin/documents", requireAdmin, async (req, res) => {
  const { orderId, clientId } = req.query;
  if (orderId && !UUID_RE.test(String(orderId))) return res.status(400).json({ error: "order_id_invalido" });
  if (clientId && !UUID_RE.test(String(clientId))) return res.status(400).json({ error: "client_id_invalido" });
  const documents = await listDocuments({ orderId: orderId || null, clientId: clientId || null });
  res.json({ documents });
});

// Borrado lógico (solo admin).
router.delete("/admin/documents/:id", requireAdmin, async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid_id" });
  const ok = await softDeleteDocument(req.params.id);
  if (!ok) return res.status(404).json({ error: "not_found" });
  await recordAudit({ actorUserId: req.user.id, action: "document.delete", entityType: "document", entityId: req.params.id });
  res.json({ ok: true });
});

// Listado para el cliente: solo sus documentos visibles.
router.get("/documents", requireApproved, async (req, res) => {
  const { orderId } = req.query;
  if (orderId && !UUID_RE.test(String(orderId))) return res.status(400).json({ error: "order_id_invalido" });
  const documents = await listDocuments({ clientId: req.user.id, orderId: orderId || null, onlyVisible: true });
  res.json({ documents });
});

// Descarga SIEMPRE por el backend (nunca link público de Drive). Valida permiso
// y transmite los bytes. Admin: cualquiera; cliente: solo propio y visible.
router.get("/documents/:id/download", requireApproved, async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).send("Documento inválido");
  const { doc, error } = await getDocumentForUser(req.params.id, req.user);
  if (error === "not_found") return res.status(404).send("Documento no encontrado");
  if (error === "forbidden") return res.status(403).send("No tenés acceso a este documento");
  try {
    const { buffer, mimeType, filename } = await downloadDocument(doc);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buffer);
  } catch (error2) {
    console.error(error2);
    res.status(502).send("No se pudo obtener el archivo del almacenamiento");
  }
});

export default router;
