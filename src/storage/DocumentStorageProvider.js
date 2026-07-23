// Interfaz de almacenamiento de documentos. El resto del sistema (servicio de
// documentos + rutas) depende SOLO de esta interfaz, nunca de un proveedor
// concreto. Para migrar a S3 / Cloudflare R2 / Supabase Storage basta con
// escribir otra clase que implemente estos métodos y cambiar STORAGE_PROVIDER.
export class DocumentStorageProvider {
  // Asegura (creando lo que falte) la ruta de carpetas y devuelve el id de la
  // carpeta final. segments p.ej.: ["Clientes","Cliente CL-1A2B3","Pedido 42","Facturas"].
  async ensureFolderPath(segments) { throw new Error("not_implemented: ensureFolderPath"); }

  // Sube bytes a una carpeta. Devuelve { fileId }.
  async upload({ folderId, filename, mimeType, buffer }) { throw new Error("not_implemented: upload"); }

  // Descarga por el backend. Devuelve { buffer, mimeType, size }.
  async download(fileId) { throw new Error("not_implemented: download"); }

  // Metadatos del archivo en el proveedor.
  async getMetadata(fileId) { throw new Error("not_implemented: getMetadata"); }

  // Borrado físico. No se usa todavía (el borrado es lógico en la base); queda
  // disponible para una etapa futura.
  async delete(fileId) { throw new Error("not_implemented: delete"); }

  // ¿Está configurado el proveedor (credenciales presentes)?
  isConfigured() { return true; }
}
