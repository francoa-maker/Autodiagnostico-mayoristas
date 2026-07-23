import crypto from "node:crypto";
import { DocumentStorageProvider } from "./DocumentStorageProvider.js";

// Google Drive vía la API REST + OAuth (mismo patrón que el envío por Gmail:
// refresh_token -> access_token con fetch, sin dependencias extra). Scope
// drive.file: la app SOLO ve/toca archivos y carpetas que ella misma creó.
// Los archivos quedan en el Drive de la cuenta que autorizó (franco.a@...).
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export class GoogleDriveStorageProvider extends DocumentStorageProvider {
  constructor({ clientId, clientSecret, refreshToken, rootFolderName, rootFolderId }) {
    super();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.rootFolderName = rootFolderName || "AUTODIAGNOSTICO ERP";
    this.rootFolderId = rootFolderId || null;
    this._token = null;
    this._tokenExp = 0;
    this._folderCache = new Map(); // pathKey -> folderId (evita recrear/re-buscar)
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken);
  }

  async _accessToken() {
    if (this._token && Date.now() < this._tokenExp - 30000) return this._token;
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token"
      })
    });
    if (!r.ok) throw new Error(`drive_token_refresh_failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    this._token = j.access_token;
    this._tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
    return this._token;
  }

  async _api(url, opts = {}) {
    const token = await this._accessToken();
    return fetch(url, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  }

  async _findFolder(name, parentId) {
    const q = `name = '${String(name).replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and '${parentId}' in parents and trashed = false`;
    const r = await this._api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`);
    if (!r.ok) throw new Error(`drive_list_failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).files?.[0]?.id || null;
  }
  async _createFolder(name, parentId) {
    const body = JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) });
    const r = await this._api(`${DRIVE}/files?fields=id`, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!r.ok) throw new Error(`drive_folder_create_failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).id;
  }
  async _ensureRoot() {
    if (this.rootFolderId) return this.rootFolderId;
    let id = await this._findFolder(this.rootFolderName, "root");
    if (!id) id = await this._createFolder(this.rootFolderName, "root");
    this.rootFolderId = id;
    return id;
  }

  async ensureFolderPath(segments) {
    let parent = await this._ensureRoot();
    let pathKey = "root";
    for (const s of segments) {
      pathKey += "/" + s;
      let id = this._folderCache.get(pathKey);
      if (!id) {
        id = (await this._findFolder(s, parent)) || (await this._createFolder(s, parent));
        this._folderCache.set(pathKey, id);
      }
      parent = id;
    }
    return parent;
  }

  async upload({ folderId, filename, mimeType, buffer }) {
    const boundary = "b_" + crypto.randomBytes(12).toString("hex");
    const meta = JSON.stringify({ name: filename, parents: [folderId] });
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      "utf8"
    );
    const post = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([pre, buffer, post]);
    const r = await this._api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body
    });
    if (!r.ok) throw new Error(`drive_upload_failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return { fileId: (await r.json()).id };
  }

  async download(fileId) {
    const r = await this._api(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`);
    if (!r.ok) throw new Error(`drive_download_failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const buffer = Buffer.from(await r.arrayBuffer());
    return { buffer, mimeType: r.headers.get("content-type") || "application/octet-stream", size: buffer.length };
  }

  async getMetadata(fileId) {
    const r = await this._api(`${DRIVE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,parents`);
    if (!r.ok) throw new Error(`drive_metadata_failed: ${r.status}`);
    return await r.json();
  }

  async delete(fileId) {
    // Borrado físico futuro: mandar a la papelera (no se usa todavía).
    const r = await this._api(`${DRIVE}/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trashed: true })
    });
    if (!r.ok) throw new Error(`drive_trash_failed: ${r.status}`);
  }
}
