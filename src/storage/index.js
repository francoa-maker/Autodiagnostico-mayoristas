import { GoogleDriveStorageProvider } from "./GoogleDriveStorageProvider.js";
import { LocalStorageProvider } from "./LocalStorageProvider.js";

// Selector de proveedor de almacenamiento. STORAGE_PROVIDER=google usa Google
// Drive (producción); cualquier otro valor (o vacío) usa el proveedor local de
// desarrollo. Cambiar de proveedor no toca ni el servicio ni las rutas.
let cached = null;

export function storageProviderName() {
  const k = (process.env.STORAGE_PROVIDER || "local").toLowerCase();
  return k === "drive" || k === "google_drive" ? "google" : k;
}

export function getStorageProvider() {
  if (cached) return cached;
  if (storageProviderName() === "google") {
    cached = new GoogleDriveStorageProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
      rootFolderName: process.env.GOOGLE_DRIVE_ROOT_FOLDER_NAME,
      rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID
    });
  } else {
    cached = new LocalStorageProvider(process.env.DOCUMENTS_LOCAL_DIR);
  }
  return cached;
}
