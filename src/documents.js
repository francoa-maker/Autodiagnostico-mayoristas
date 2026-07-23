// Servicio de documentos: valida, arma el nombre controlado y la estructura de
// carpetas, sube al proveedor de storage y guarda SOLO metadatos en Postgres.
// El archivo nunca se guarda en la base.
import { pool } from "./db.js";
import { getStorageProvider } from "./storage/index.js";

export const DOCUMENT_TYPES = [
  "proforma", "factura", "nota_credito", "comprobante_transferencia",
  "comprobante_echeq", "remito", "etiqueta_envio", "constancia_entrega", "otro"
];

// A qué subcarpeta va cada tipo dentro del "Pedido N".
const TYPE_FOLDER = {
  proforma: "Proformas", factura: "Facturas", nota_credito: "Facturas",
  comprobante_transferencia: "Pagos", comprobante_echeq: "Pagos",
  remito: "Logística", etiqueta_envio: "Logística", constancia_entrega: "Logística",
  otro: "Otros"
};
// Slug del tipo para el nombre controlado del archivo.
const TYPE_SLUG = {
  proforma: "proforma", factura: "factura", nota_credito: "nota-credito",
  comprobante_transferencia: "transferencia", comprobante_echeq: "echeq",
  remito: "remito", etiqueta_envio: "etiqueta-envio", constancia_entrega: "constancia-entrega",
  otro: "documento"
};

// MIME permitidos y sus extensiones válidas.
const ALLOWED = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"]
};

export function maxBytes() {
  return (Number(process.env.DOCUMENTS_MAX_MB) || 25) * 1024 * 1024;
}

// Valida MIME + extensión + tamaño. Devuelve { ok, ext } o { ok:false, error }.
export function validateUpload({ mimeType, filename, size }) {
  const mt = String(mimeType || "").split(";")[0].trim().toLowerCase();
  const allowedExts = ALLOWED[mt];
  if (!allowedExts) return { ok: false, error: "tipo_no_permitido" };
  const ext = String(filename || "").split(".").pop().toLowerCase();
  if (!allowedExts.includes(ext)) return { ok: false, error: "extension_no_coincide" };
  if (!size || size <= 0) return { ok: false, error: "archivo_vacio" };
  if (size > maxBytes()) return { ok: false, error: "archivo_muy_grande" };
  return { ok: true, ext, mimeType: mt };
}

function slug(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// Nombre controlado, p.ej. pedido-1042_factura.pdf o transferencia_2026-07-23.jpg
export function buildStoredFilename({ type, orderNumber, ext, label }) {
  const parts = [];
  if (orderNumber) parts.push(`pedido-${orderNumber}`);
  parts.push(TYPE_SLUG[type] || "documento");
  if (label) parts.push(slug(label));
  return parts.join("_") + "." + ext;
}

// Sube un documento: valida, resuelve carpetas y nombre, sube al proveedor e
// inserta la fila de metadatos. Devuelve la fila creada.
export async function saveDocument({
  buffer, mimeType, originalFilename, documentType,
  clientId = null, orderId = null, paymentId = null, shipmentId = null,
  label = null, visibleToCustomer = false, uploadedBy
}) {
  if (!DOCUMENT_TYPES.includes(documentType)) {
    throw Object.assign(new Error("tipo_de_documento_invalido"), { statusCode: 400 });
  }
  const v = validateUpload({ mimeType, filename: originalFilename, size: buffer?.length });
  if (!v.ok) throw Object.assign(new Error(v.error), { statusCode: 400 });

  // Datos para nombrar carpetas/archivo: código de cliente y número de pedido.
  let clientCode = null, orderNumber = null, resolvedClientId = clientId;
  if (orderId) {
    const q = await pool.query(
      `select q.request_number, q.user_id, u.client_code
       from portal.quote_requests q join portal.users u on u.id = q.user_id where q.id = $1`,
      [orderId]
    );
    if (!q.rows[0]) throw Object.assign(new Error("pedido_no_encontrado"), { statusCode: 404 });
    orderNumber = q.rows[0].request_number;
    clientCode = q.rows[0].client_code;
    if (!resolvedClientId) resolvedClientId = q.rows[0].user_id;
  } else if (clientId) {
    const u = await pool.query(`select client_code from portal.users where id = $1`, [clientId]);
    clientCode = u.rows[0]?.client_code || null;
  }

  const provider = getStorageProvider();
  if (!provider.isConfigured()) {
    throw Object.assign(new Error("storage_no_configurado"), { statusCode: 503 });
  }

  const clientSeg = `Cliente ${clientCode || resolvedClientId || "sin-cliente"}`;
  const orderSeg = orderNumber ? `Pedido ${orderNumber}` : "Sin pedido";
  const typeSeg = TYPE_FOLDER[documentType] || "Otros";
  const folderId = await provider.ensureFolderPath(["Clientes", clientSeg, orderSeg, typeSeg]);

  const storedFilename = buildStoredFilename({ type: documentType, orderNumber, ext: v.ext, label });
  const { fileId } = await provider.upload({ folderId, filename: storedFilename, mimeType: v.mimeType, buffer });

  const inserted = await pool.query(
    `insert into portal.documents
       (client_id, order_id, payment_id, shipment_id, document_type, google_drive_file_id,
        google_drive_folder_id, original_filename, stored_filename, mime_type, file_size,
        visible_to_customer, uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [resolvedClientId, orderId, paymentId, shipmentId, documentType, fileId, folderId,
     originalFilename, storedFilename, v.mimeType, buffer.length, Boolean(visibleToCustomer), uploadedBy]
  );
  return inserted.rows[0];
}

// Trae la fila (no borrada) validando permiso: admin siempre; cliente sólo si
// es el dueño y el documento es visible_to_customer.
export async function getDocumentForUser(id, user) {
  const r = await pool.query(`select * from portal.documents where id = $1 and deleted_at is null`, [id]);
  const doc = r.rows[0];
  if (!doc) return { error: "not_found" };
  const isOwnerVisible = doc.client_id === user.id && doc.visible_to_customer;
  if (user.role !== "admin" && !isOwnerVisible) return { error: "forbidden" };
  return { doc };
}

// Descarga por el backend (nunca link público). Devuelve { buffer, mimeType, filename }.
export async function downloadDocument(doc) {
  const provider = getStorageProvider();
  const { buffer, mimeType } = await provider.download(doc.google_drive_file_id);
  return { buffer, mimeType: doc.mime_type || mimeType, filename: doc.stored_filename };
}

export async function listDocuments({ orderId, clientId, onlyVisible }) {
  const conds = ["deleted_at is null"];
  const params = [];
  if (orderId) { params.push(orderId); conds.push(`order_id = $${params.length}`); }
  if (clientId) { params.push(clientId); conds.push(`client_id = $${params.length}`); }
  if (onlyVisible) conds.push("visible_to_customer = true");
  const r = await pool.query(
    `select d.id, d.document_type, d.original_filename, d.stored_filename, d.mime_type, d.file_size,
            d.visible_to_customer, d.order_id, d.client_id, d.created_at, u.display_name as uploaded_by_name
     from portal.documents d left join portal.users u on u.id = d.uploaded_by
     where ${conds.join(" and ")} order by d.created_at desc`,
    params
  );
  return r.rows;
}

// Borrado LÓGICO (marca eliminado). El borrado físico en Drive es una etapa futura.
export async function softDeleteDocument(id) {
  const r = await pool.query(
    `update portal.documents set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null returning id`,
    [id]
  );
  return r.rowCount > 0;
}
