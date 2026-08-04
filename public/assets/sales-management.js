import { fetchJson, postJson, patchJson } from "./api.js";

const REQUIRED_BUTTON_ID = "sendProformaBtn";
let lastQuoteId = null;
let initialDraft = null;

const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const raw = typeof args[0] === "string" ? args[0] : args[0]?.url;
  const match = String(raw || "").match(/\/api\/admin\/quotes\/([0-9a-f-]{36})(?:\?|$)/i);
  if (match && !String(raw).includes("sales-management")) lastQuoteId = match[1];
  return originalFetch(...args);
};

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function injectStyles() {
  if (document.getElementById("sales-management-styles")) return;
  const style = document.createElement("style");
  style.id = "sales-management-styles";
  style.textContent = `
    .sales-mgmt-overlay{position:fixed;inset:0;z-index:1500;background:rgba(12,16,24,.66);display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto}
    .sales-mgmt-modal{width:min(1040px,100%);background:#fff;border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.3);overflow:hidden}
    .sales-mgmt-head{display:flex;gap:16px;align-items:flex-start;padding:20px 22px;border-bottom:1px solid #e5e7eb;background:linear-gradient(135deg,#111827,#1f2937)}
    .sales-mgmt-head h2{margin:0;color:#fff;font-size:20px}.sales-mgmt-head p{margin:4px 0 0;color:#cbd5e1;font-size:12px}
    .sales-mgmt-close{margin-left:auto;border:0;background:rgba(255,255,255,.08);color:#fff;width:34px;height:34px;border-radius:9px;font-size:20px;cursor:pointer}
    .sales-mgmt-body{padding:20px 22px 22px}.sales-mgmt-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
    .sales-mgmt-card{border:1px solid #e5e7eb;border-radius:11px;padding:11px 13px;background:#f8fafc}.sales-mgmt-card span{display:block;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.06em}.sales-mgmt-card b{display:block;margin-top:3px;color:#0f172a;font-size:14px}
    .sales-mgmt-code{color:#c8102e!important;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px!important}
    .sales-mgmt-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sales-mgmt-field{display:flex;flex-direction:column;gap:5px;color:#475569;font-size:11px;font-weight:700}.sales-mgmt-field.full{grid-column:1/-1}
    .sales-mgmt-field input,.sales-mgmt-field textarea{width:100%;border:1px solid #d7dce3;border-radius:9px;padding:10px 11px;background:#fff;color:#111827;outline:0}.sales-mgmt-field input:focus,.sales-mgmt-field textarea:focus{border-color:#c8102e;box-shadow:0 0 0 3px rgba(200,16,46,.1)}
    .sales-mgmt-recipients{display:flex;flex-wrap:wrap;gap:6px;padding:10px;border:1px solid #e5e7eb;border-radius:10px;background:#f8fafc}.sales-mgmt-chip{padding:5px 8px;border-radius:999px;background:#fff;border:1px solid #dbe1e8;color:#334155;font-size:11px}
    .sales-mgmt-toolbar{display:flex;gap:5px;padding:7px;border:1px solid #d7dce3;border-bottom:0;border-radius:10px 10px 0 0;background:#f8fafc}.sales-mgmt-toolbar button{border:1px solid #d7dce3;background:#fff;border-radius:6px;min-width:32px;height:30px;cursor:pointer}.sales-mgmt-toolbar .restore{margin-left:auto;padding:0 10px;color:#c8102e;font-weight:700}
    .sales-mgmt-editor{min-height:310px;max-height:480px;overflow:auto;border:1px solid #d7dce3;border-radius:0 0 10px 10px;padding:18px;background:#fff;color:#1f2937;line-height:1.5;outline:0}.sales-mgmt-editor:focus{border-color:#c8102e;box-shadow:0 0 0 3px rgba(200,16,46,.1)}
    .sales-mgmt-confirm{display:flex;gap:9px;align-items:flex-start;margin-top:15px;padding:11px 12px;border:1px solid #fecdd3;border-radius:10px;background:#fff1f2;color:#881337;font-size:12px}.sales-mgmt-confirm input{margin-top:2px}
    .sales-mgmt-actions{display:flex;gap:10px;align-items:center;margin-top:16px}.sales-mgmt-message{margin-right:auto;font-size:12px}.sales-mgmt-actions button{height:40px;border-radius:9px;padding:0 15px;font-weight:750;cursor:pointer}.sales-mgmt-cancel{border:1px solid #d7dce3;background:#fff;color:#475569}.sales-mgmt-send{border:0;background:#c8102e;color:#fff}.sales-mgmt-send:disabled{opacity:.55;cursor:not-allowed}
    @media(max-width:760px){.sales-mgmt-overlay{padding:0}.sales-mgmt-modal{min-height:100vh;border-radius:0}.sales-mgmt-meta,.sales-mgmt-grid{grid-template-columns:1fr}.sales-mgmt-field.full{grid-column:auto}.sales-mgmt-body{padding:16px}.sales-mgmt-editor{min-height:260px}.sales-mgmt-actions{position:sticky;bottom:0;background:#fff;padding-top:10px}}
  `;
  document.head.appendChild(style);
}

function quoteIdFromPage() {
  return document.querySelector("#quotesBody tr.quote-row.active")?.dataset.id
    || document.querySelector("#quotesBody tr[data-id].active")?.dataset.id
    || lastQuoteId;
}

function closeModal() {
  document.getElementById("salesManagementOverlay")?.remove();
  document.body.style.overflow = "";
  initialDraft = null;
}

function updateBodyField(field, value) {
  const editor = document.getElementById("salesEmailBody");
  const target = editor?.querySelector(`[data-sales-field="${field}"]`);
  if (target) target.textContent = value;
}

function toolbarCommand(command) {
  document.getElementById("salesEmailBody")?.focus();
  document.execCommand(command, false, null);
}

function toast(message, type = "") {
  if (typeof window.v5Toast === "function") return window.v5Toast(message, type);
  window.alert(message);
}

function currentQuotePatch() {
  const status = document.getElementById("quoteStatus")?.value;
  if (!status) return null;
  return {
    status,
    discount: Number(document.getElementById("qDiscount")?.value || 0),
    discountType: document.getElementById("qDiscountType")?.value || "amount",
    shipping: Number(document.getElementById("qShipping")?.value || 0),
    publicNotes: document.getElementById("qPublicNotes")?.value || "",
    paymentTerms: document.getElementById("qPaymentTerms")?.value || "",
    dueDate: document.getElementById("qDueDate")?.value || null
  };
}

function renderModal(draft, quoteId) {
  initialDraft = structuredClone(draft);
  const overlay = document.createElement("div");
  overlay.id = "salesManagementOverlay";
  overlay.className = "sales-mgmt-overlay";
  overlay.innerHTML = `
    <section class="sales-mgmt-modal" role="dialog" aria-modal="true" aria-labelledby="salesMgmtTitle">
      <header class="sales-mgmt-head">
        <div><h2 id="salesMgmtTitle">${draft.alreadyStarted ? "Reenviar gestión de venta" : "Iniciar gestión de venta"}</h2><p>Este correo abre la cadena compartida entre el cliente y las áreas internas.</p></div>
        <button class="sales-mgmt-close" type="button" aria-label="Cerrar">×</button>
      </header>
      <div class="sales-mgmt-body">
        <div class="sales-mgmt-meta">
          <div class="sales-mgmt-card"><span>Vendedor responsable</span><b>${esc(draft.seller.name)}</b></div>
          <div class="sales-mgmt-card"><span>Código de vendedor</span><b class="sales-mgmt-code">${esc(draft.seller.code)}</b></div>
          <div class="sales-mgmt-card"><span>Código de gestión</span><b class="sales-mgmt-code">${esc(draft.managementCode)}</b></div>
        </div>
        <div class="sales-mgmt-grid">
          <label class="sales-mgmt-field full">Correo del cliente
            <input id="salesClientEmail" type="email" value="${esc(draft.clientEmail)}" autocomplete="off">
          </label>
          <div class="sales-mgmt-field full">Equipo interno incluido en “Para”
            <div class="sales-mgmt-recipients">${draft.internalRecipients.map((email) => `<span class="sales-mgmt-chip">${esc(email)}</span>`).join("")}</div>
          </div>
          <label class="sales-mgmt-field full">Destinatarios adicionales <span style="font-weight:400;color:#94a3b8">(opcional, separados por coma)</span>
            <input id="salesAdditionalRecipients" placeholder="otra.persona@empresa.com">
          </label>
          <label class="sales-mgmt-field">Plazo de entrega
            <input id="salesDeliveryTerms" value="${esc(draft.deliveryTerms)}">
          </label>
          <label class="sales-mgmt-field">Plazo de pago
            <input id="salesPaymentTerms" value="${esc(draft.paymentTermsText)}">
          </label>
          <label class="sales-mgmt-field full">Asunto
            <input id="salesEmailSubject" value="${esc(draft.subject)}">
          </label>
          <div class="sales-mgmt-field full">Contenido del correo
            <div class="sales-mgmt-toolbar" role="toolbar" aria-label="Formato del correo">
              <button type="button" data-cmd="bold" title="Negrita"><b>B</b></button>
              <button type="button" data-cmd="italic" title="Cursiva"><i>I</i></button>
              <button type="button" data-cmd="insertUnorderedList" title="Lista">• Lista</button>
              <button type="button" class="restore" id="salesRestoreTemplate">Restaurar plantilla</button>
            </div>
            <div id="salesEmailBody" class="sales-mgmt-editor" contenteditable="true" spellcheck="true"></div>
          </div>
        </div>
        <label class="sales-mgmt-confirm"><input id="salesTermsConfirmed" type="checkbox"><span>Confirmo que el <strong>plazo de entrega</strong> y el <strong>plazo de pago</strong> son correctos y quedaron expresados de forma clara en el correo.</span></label>
        <div class="sales-mgmt-actions">
          <span class="sales-mgmt-message" id="salesManagementMessage"></span>
          <button class="sales-mgmt-cancel" type="button">Cancelar</button>
          <button class="sales-mgmt-send" id="salesManagementSend" type="button">${draft.alreadyStarted ? "Reenviar gestión" : "Iniciar gestión y enviar"}</button>
        </div>
      </div>
    </section>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  document.getElementById("salesEmailBody").innerHTML = draft.bodyHtml;
  document.getElementById("salesDeliveryTerms").addEventListener("input", (event) => updateBodyField("delivery", event.target.value));
  document.getElementById("salesPaymentTerms").addEventListener("input", (event) => updateBodyField("payment", event.target.value));
  overlay.querySelectorAll("[data-cmd]").forEach((button) => button.addEventListener("click", () => toolbarCommand(button.dataset.cmd)));
  overlay.querySelector(".sales-mgmt-close").addEventListener("click", closeModal);
  overlay.querySelector(".sales-mgmt-cancel").addEventListener("click", closeModal);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeModal(); });
  document.getElementById("salesRestoreTemplate").addEventListener("click", () => {
    document.getElementById("salesEmailSubject").value = initialDraft.subject;
    document.getElementById("salesDeliveryTerms").value = initialDraft.deliveryTerms;
    document.getElementById("salesPaymentTerms").value = initialDraft.paymentTermsText;
    document.getElementById("salesEmailBody").innerHTML = initialDraft.bodyHtml;
  });
  document.getElementById("salesManagementSend").addEventListener("click", () => submitManagement(quoteId));
  setTimeout(() => document.getElementById("salesClientEmail")?.focus(), 30);
}

async function submitManagement(quoteId) {
  const message = document.getElementById("salesManagementMessage");
  const button = document.getElementById("salesManagementSend");
  const clientEmail = document.getElementById("salesClientEmail").value.trim();
  const deliveryTerms = document.getElementById("salesDeliveryTerms").value.trim();
  const paymentTermsText = document.getElementById("salesPaymentTerms").value.trim();
  const subject = document.getElementById("salesEmailSubject").value.trim();
  const bodyHtml = document.getElementById("salesEmailBody").innerHTML.trim();
  if (!clientEmail || !deliveryTerms || !paymentTermsText || !subject || !bodyHtml) {
    message.style.color = "#c8102e";
    message.textContent = "Completá cliente, plazos, asunto y contenido.";
    return;
  }
  if (!document.getElementById("salesTermsConfirmed").checked) {
    message.style.color = "#c8102e";
    message.textContent = "Confirmá que ambos plazos son correctos.";
    return;
  }
  button.disabled = true;
  button.textContent = "Enviando...";
  message.style.color = "#64748b";
  message.textContent = "Guardando la cotización y enviando desde Gmail...";
  try {
    const patch = currentQuotePatch();
    if (patch) await patchJson(`/api/admin/quotes/${quoteId}`, patch);
    const result = await postJson(`/api/admin/quotes/${quoteId}/start-sales-management`, {
      clientEmail,
      additionalRecipients: document.getElementById("salesAdditionalRecipients").value,
      deliveryTerms,
      paymentTermsText,
      subject,
      bodyHtml
    });
    closeModal();
    const originalButton = document.getElementById(REQUIRED_BUTTON_ID);
    if (originalButton) {
      originalButton.textContent = `✓ Gestión iniciada · ${result.managementCode}`;
      originalButton.style.background = "#137333";
    }
    toast(`Gestión ${result.managementCode} iniciada. Correo enviado a ${result.recipients.length} destinatarios.`);
    setTimeout(() => document.querySelector("#quotesBody tr.quote-row.active")?.click(), 250);
  } catch (error) {
    message.style.color = "#c8102e";
    message.textContent = error.body?.detail || error.body?.error || error.message;
    button.disabled = false;
    button.textContent = initialDraft?.alreadyStarted ? "Reenviar gestión" : "Iniciar gestión y enviar";
  }
}

async function openManagement() {
  const quoteId = quoteIdFromPage();
  if (!quoteId) {
    toast("No pude identificar el pedido abierto. Volvé a seleccionarlo en la lista.", "error");
    return;
  }
  try {
    const { user } = await fetchJson("/api/me");
    if (!user?.gmail_connected) {
      if (window.confirm("Necesitás conectar Gmail para enviar desde tu casilla. ¿Conectar ahora?")) location.href = "/auth/google/gmail";
      return;
    }
    const { draft } = await fetchJson(`/api/admin/quotes/${quoteId}/sales-management-draft`);
    renderModal(draft, quoteId);
  } catch (error) {
    toast(error.body?.detail || error.body?.error || error.message, "error");
  }
}

function enhanceButton() {
  const button = document.getElementById(REQUIRED_BUTTON_ID);
  if (!button || button.dataset.salesManagementEnhanced) return;
  button.dataset.salesManagementEnhanced = "true";
  button.textContent = "✉ Iniciar gestión de venta";
  button.title = "Envía el primer correo al cliente y al equipo interno, registrando el vendedor responsable";
}

function boot() {
  injectStyles();
  enhanceButton();
  new MutationObserver(enhanceButton).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (event) => {
    const button = event.target.closest(`#${REQUIRED_BUTTON_ID}`);
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openManagement();
  }, true);
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
