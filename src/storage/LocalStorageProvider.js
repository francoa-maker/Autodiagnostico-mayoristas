import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DocumentStorageProvider } from "./DocumentStorageProvider.js";

// Proveedor de DESARROLLO/PRUEBAS: guarda en el filesystem local. NO usar en
// producción (los documentos deben ir a Drive). Sirve para validar todo el
// flujo (validaciones, rutas, base, descarga por backend) sin credenciales.
export class LocalStorageProvider extends DocumentStorageProvider {
  constructor(rootDir) {
    super();
    this.root = rootDir || path.join(process.cwd(), ".local-documents");
  }
  // En producción NO debe usarse (disco efímero): se reporta como no
  // configurado para que las subidas se bloqueen hasta activar Drive.
  isConfigured() { return process.env.NODE_ENV !== "production"; }

  async ensureFolderPath(segments) {
    const dir = path.join(this.root, ...segments.map(seg));
    fs.mkdirSync(dir, { recursive: true });
    return path.relative(this.root, dir) || ".";
  }
  async upload({ folderId, filename, buffer }) {
    const id = crypto.randomUUID() + "__" + seg(filename);
    const rel = path.join(folderId, id);
    fs.mkdirSync(path.dirname(path.join(this.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(this.root, rel), buffer);
    return { fileId: rel.split(path.sep).join("/") };
  }
  async download(fileId) {
    const buffer = fs.readFileSync(path.join(this.root, fileId));
    return { buffer, mimeType: "application/octet-stream", size: buffer.length };
  }
  async getMetadata(fileId) {
    const st = fs.statSync(path.join(this.root, fileId));
    return { id: fileId, name: path.basename(fileId), size: st.size };
  }
  async delete(fileId) {
    try { fs.unlinkSync(path.join(this.root, fileId)); } catch { /* ya no está */ }
  }
}
function seg(s) { return String(s).replace(/[\\/:*?"<>|]/g, "_"); }
