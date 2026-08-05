import { fetchJson, postJson, patchJson, money } from "./api.js";
import { localIsoDate } from "./finance-math.js";
import { confirmDialog } from "./ui-confirm.js";
import { refreshFinanceOrder } from "./finance-context.js";

const STYLE_LINK_ID = "finance-drawer-css";
export { fetchJson, postJson, patchJson, money, localIsoDate };

export function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function linkFinanceStyles() {
  if (document.getElementById(STYLE_LINK_ID)) return;
  const link = document.createElement("link");
  link.id = STYLE_LINK_ID;
  link.rel = "stylesheet";
  link.href = "/assets/finance-drawer.css?v=20260806-drawer2";
  document.head.appendChild(link);
}

export function notify(message, type = "") {
  if (typeof window.v5Toast === "function") window.v5Toast(message, type);
  else window.alert(message);
}

export function friendly(error) {
  const raw = error?.body?.error || error?.message || "";
  const labels = {
    suma_cuotas_distinta_al_total: "Los vencimientos no suman el total.",
    vencimiento_fecha_invalida: "Hay un vencimiento con fecha inválida.",
    vencimiento_monto_invalido: "Hay un vencimiento con monto inválido.",
    total_invalido: "El total no es válido.",
    tipo_factura_invalido: "El tipo de comprobante no es válido.",
    monto_invalido: "El monto no es válido.",
    metodo_no_soportado_en_esta_etapa: "Ese medio de pago no se registra por esta vía.",
    excede_saldo_del_pago: "La imputación excede el monto del pago.",
    excede_saldo_de_la_cuota: "La imputación excede lo que debe la cuota.",
    cuota_no_encontrada: "No se encontró la cuota a imputar.",
    factura_anulada: "La factura está anulada.",
    cuota_de_otro_cliente: "La cuota es de otro cliente.",
    sin_asignaciones: "No se indicó ninguna imputación."
  };
  return labels[raw] || error?.body?.detail || raw || "error desconocido";
}

let financeStatus = null;
let documentsStatus = null;
export async function getFinanceStatus() {
  if (financeStatus) return financeStatus;
  try { financeStatus = await fetchJson("/api/admin/finance/status"); }
  catch { financeStatus = null; }
  return financeStatus;
}
export async function getDocumentsStatus() {
  if (documentsStatus) return documentsStatus;
  try { documentsStatus = await fetchJson("/api/admin/documents/status"); }
  catch { documentsStatus = { configured: false, maxMb: 25 }; }
  return documentsStatus;
}

function modalIsOpen() {
  const overlay = document.getElementById("modalOverlay");
  return Boolean(overlay && !overlay.hidden);
}

let drawer = null;
export function currentDrawerOrderId() { return drawer?.orderId || null; }
export function closeFinanceDrawer() {
  if (!drawer) return;
  const current = drawer;
  drawer = null;
  current.cleanup?.();
  current.panel.classList.remove("is-open");
  current.overlay.classList.remove("is-open");
  document.body.classList.remove("finance-drawer-open");
  setTimeout(() => { current.overlay.remove(); current.panel.remove(); }, 240);
  try { current.restoreFocus?.(); } catch { /* nodo destruido */ }
}

export function openFinanceDrawer({ title, subtitle, orderId }) {
  closeFinanceDrawer();
  const restoreTo = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "admin-drawer-overlay";
  const panel = document.createElement("aside");
  panel.className = "admin-drawer";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", title);
  panel.innerHTML = `<div class="admin-drawer-head"><div class="copy"><strong></strong><small></small></div><button type="button" class="admin-drawer-x" data-drawer-close aria-label="Cerrar">&times;</button></div><div class="admin-drawer-body"></div><div class="admin-drawer-foot"><div class="foot-sum"></div></div>`;
  panel.querySelector(".copy strong").textContent = title;
  panel.querySelector(".copy small").textContent = subtitle || "";
  document.body.append(overlay, panel);
  document.body.classList.add("finance-drawer-open");
  requestAnimationFrame(() => { overlay.classList.add("is-open"); panel.classList.add("is-open"); });
  const onKey = (event) => { if (event.key === "Escape" && !modalIsOpen()) closeFinanceDrawer(); };
  const onOverlay = () => { if (!modalIsOpen()) closeFinanceDrawer(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", onOverlay);
  panel.querySelector("[data-drawer-close]").addEventListener("click", closeFinanceDrawer);
  drawer = {
    overlay, panel, body: panel.querySelector(".admin-drawer-body"), foot: panel.querySelector(".admin-drawer-foot"),
    footSum: panel.querySelector(".foot-sum"), orderId: String(orderId), restoreFocus: () => restoreTo?.focus?.(),
    cleanup: () => { document.removeEventListener("keydown", onKey); overlay.removeEventListener("click", onOverlay); }
  };
  return drawer;
}

export function drawerFooter(drawerRef, { primaryLabel, onPrimary }) {
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "link-btn ghost"; cancel.textContent = "Cancelar";
  cancel.addEventListener("click", closeFinanceDrawer);
  const primary = document.createElement("button");
  primary.type = "button"; primary.className = "btn-primary"; primary.textContent = primaryLabel;
  primary.addEventListener("click", () => onPrimary(primary));
  drawerRef.foot.append(cancel, primary);
  return primary;
}

const ALLOWED_UPLOAD = { "application/pdf": ["pdf"], "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"] };
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";
function fmtBytes(value) {
  const kb = Number(value) / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
function uploadProblem(file, maxBytes) {
  const mime = String(file.type || "").split(";")[0].trim().toLowerCase();
  const extensions = ALLOWED_UPLOAD[mime];
  if (!extensions) return "Sólo se aceptan PDF, JPG, PNG o WEBP.";
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  if (!extensions.includes(extension)) return `La extensión .${extension} no coincide con el tipo de archivo.`;
  if (!file.size) return "El archivo está vacío.";
  if (maxBytes && file.size > maxBytes) return `El archivo pesa ${fmtBytes(file.size)} y el máximo es ${fmtBytes(maxBytes)}.`;
  return null;
}

export function mountDropzone(host, { maxBytes, label, hint, onChange }) {
  host.innerHTML = `<div class="fin-dropzone" tabindex="0" role="button"><span class="fin-dropzone-icon" aria-hidden="true">&#128206;</span><strong>${esc(label)}</strong><small>${esc(hint)}</small></div><div class="fin-file" hidden><div class="fin-file-thumb" aria-hidden="true">&#128196;</div><div class="fin-file-meta"><b></b><span></span></div><button type="button" class="link-btn ghost" data-file-clear>Quitar</button></div><p class="fin-hint is-bad" data-file-error hidden></p><input type="file" accept="${ACCEPT}" hidden>`;
  const zone = host.querySelector(".fin-dropzone");
  const card = host.querySelector(".fin-file");
  const input = host.querySelector('input[type="file"]');
  const error = host.querySelector("[data-file-error]");
  let picked = null;
  const set = (file) => {
    error.hidden = true; error.textContent = "";
    if (!file) { picked = null; card.hidden = true; zone.hidden = false; input.value = ""; onChange(null); return; }
    const problem = uploadProblem(file, maxBytes);
    if (problem) { error.hidden = false; error.textContent = problem; return; }
    picked = file;
    host.querySelector(".fin-file-meta b").textContent = file.name;
    host.querySelector(".fin-file-meta span").textContent = fmtBytes(file.size);
    card.hidden = false; zone.hidden = true; onChange(file);
  };
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input.click(); } });
  ["dragenter", "dragover"].forEach((type) => zone.addEventListener(type, (event) => { event.preventDefault(); zone.classList.add("is-over"); }));
  ["dragleave", "dragend"].forEach((type) => zone.addEventListener(type, () => zone.classList.remove("is-over")));
  zone.addEventListener("drop", (event) => { event.preventDefault(); zone.classList.remove("is-over"); set(event.dataTransfer?.files?.[0] || null); });
  input.addEventListener("change", () => set(input.files[0] || null));
  host.querySelector("[data-file-clear]").addEventListener("click", () => set(null));
  const onPaste = (event) => { const file = event.clipboardData?.files?.[0]; if (file) { event.preventDefault(); set(file); } };
  document.addEventListener("paste", onPaste);
  return { get file() { return picked; }, dispose: () => document.removeEventListener("paste", onPaste) };
}

export async function uploadDocument(file, { documentType, orderId, visibleToCustomer = false }) {
  const query = new URLSearchParams({ documentType, orderId, filename: file.name, visibleToCustomer: String(Boolean(visibleToCustomer)) });
  const response = await fetch(`/api/admin/documents?${query}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  if (response.status === 401) { location.href = "/login"; throw new Error("sesión vencida"); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || body.error || "no se pudo subir el archivo");
  return body.document?.id || null;
}

function dataKeyToAttr(key) { return "data-" + key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`); }

export function mountMirroredHistory(host, { summary, groups, orderId }) {
  const details = document.createElement("details");
  details.className = "fin-history";
  details.innerHTML = `<summary>${esc(summary)}</summary><div class="fin-history-body"></div>`;
  host.appendChild(details);
  const body = details.querySelector(".fin-history-body");
  const render = () => {
    body.innerHTML = "";
    let visible = 0;
    for (const group of groups) {
      const source = document.getElementById(group.sourceId);
      const feature = source?.closest("#financeSection,#paymentsSection,#echeqSection,#accountSection");
      if (!source || feature?.hidden) continue;
      visible++;
      const section = document.createElement("section");
      section.className = "fin-history-group";
      section.innerHTML = `${group.label ? `<strong class="fin-history-label">${esc(group.label)}</strong>` : ""}<div class="fin-history-clone">${source.innerHTML}</div>`;
      body.appendChild(section);
    }
    details.hidden = visible === 0;
  };
  const reload = () => { if (orderId) refreshFinanceOrder(orderId); };
  const runAction = async (button) => {
    if (button.dataset.doc) { window.open(`/api/documents/${button.dataset.doc}/download`, "_blank"); return true; }
    if (button.dataset.void) {
      const answer = await confirmDialog({ title: "Anular factura", body: "La factura quedará anulada y no se contará en el saldo.", confirmLabel: "Anular factura", danger: true });
      if (!answer.ok) return true; await postJson(`/api/admin/invoices/${button.dataset.void}/void`, {}); reload(); return true;
    }
    if (button.dataset.payconfirm) {
      const answer = await confirmDialog({ title: "Confirmar pago", body: "El pago generará crédito y podrá imputarse a las facturas pendientes.", confirmLabel: "Confirmar pago" });
      if (!answer.ok) return true; await postJson(`/api/admin/payments/${button.dataset.payconfirm}/confirm`, {}); reload(); return true;
    }
    if (button.dataset.payreverse) {
      const answer = await confirmDialog({ title: "Reversar pago", body: "La reversa deshará el crédito y sus imputaciones.", confirmLabel: "Reversar pago", danger: true, field: { label: "Motivo de la reversa", type: "textarea", required: true } });
      if (!answer.ok) return true; await postJson(`/api/admin/payments/${button.dataset.payreverse}/reverse`, { reason: answer.value }); reload(); return true;
    }
    if (button.dataset.echacc) {
      const answer = await confirmDialog({ title: "Aceptar eCheq", body: "El eCheq pasará a pendiente de acreditación.", confirmLabel: "Aceptar" });
      if (!answer.ok) return true; await postJson(`/api/admin/echeqs/${button.dataset.echacc}/accept`, {}); reload(); return true;
    }
    if (button.dataset.echcred) {
      const answer = await confirmDialog({ title: "Acreditar eCheq", body: "Al acreditarlo se generará el crédito correspondiente.", confirmLabel: "Acreditar", field: { label: "Fecha real de acreditación", type: "date", value: localIsoDate(), required: false } });
      if (!answer.ok) return true; await postJson(`/api/admin/echeqs/${button.dataset.echcred}/accredit`, { actualCreditDate: answer.value || null }); reload(); return true;
    }
    if (button.dataset.echrej) {
      const answer = await confirmDialog({ title: "Rechazar eCheq", body: "El eCheq quedará rechazado y no generará crédito.", confirmLabel: "Rechazar", danger: true, field: { label: "Motivo del rechazo", type: "textarea", required: true } });
      if (!answer.ok) return true; await postJson(`/api/admin/echeqs/${button.dataset.echrej}/reject`, { reason: answer.value }); reload(); return true;
    }
    if (button.dataset.revmov) {
      const answer = await confirmDialog({ title: "Reversar movimiento", body: "Se creará el movimiento compensatorio en la cuenta corriente.", confirmLabel: "Reversar", danger: true, field: { label: "Motivo de la reversa", type: "textarea", required: true } });
      if (!answer.ok) return true; await postJson(`/api/admin/movements/${button.dataset.revmov}/reverse`, { reason: answer.value }); reload(); return true;
    }
    return false;
  };
  const forward = async (event) => {
    const button = event.target.closest("button[data-doc],button[data-void],button[data-payconfirm],button[data-payapply],button[data-payreverse],button[data-echacc],button[data-echcred],button[data-echrej],button[data-revmov]");
    if (!button) return;
    event.preventDefault();
    try {
      if (await runAction(button)) return;
      const key = Object.keys(button.dataset).find((name) => name !== "rem" && name !== "currency");
      if (!key) return;
      const attr = dataKeyToAttr(key);
      const value = button.dataset[key];
      for (const group of groups) {
        const source = document.getElementById(group.sourceId);
        const candidates = source ? [...source.querySelectorAll(`[${attr}]`)] : [];
        const original = candidates.find((node) => node.getAttribute(attr) === value);
        if (original) { original.click(); break; }
      }
    } catch (error) { notify(`No se pudo completar la acción: ${friendly(error)}`, "error"); }
  };
  body.addEventListener("click", forward);
  const observers = groups.map((group) => document.getElementById(group.sourceId)).filter(Boolean).map((source) => {
    const observer = new MutationObserver(render);
    observer.observe(source, { childList: true, subtree: true, characterData: true, attributes: true });
    return observer;
  });
  render();
  return () => { body.removeEventListener("click", forward); observers.forEach((observer) => observer.disconnect()); };
}
