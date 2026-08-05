// Diálogo de confirmación con un campo opcional para las acciones destructivas
// de los historiales financieros. Se monta sobre el overlay existente del panel.

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function confirmDialog({ title, body = "", confirmLabel = "Confirmar", danger = false, field = null }) {
  const overlay = document.getElementById("modalOverlay");
  const box = document.getElementById("modalBox");
  if (!overlay || !box) {
    const ok = window.confirm(body ? `${title}\n\n${body}` : title);
    if (!ok) return Promise.resolve({ ok: false, value: null });
    if (!field) return Promise.resolve({ ok: true, value: null });
    const value = window.prompt(field.label, field.value || "");
    if (value === null || (field.required && !value.trim())) return Promise.resolve({ ok: false, value: null });
    return Promise.resolve({ ok: true, value: value.trim() });
  }

  return new Promise((resolve) => {
    const fieldHtml = field
      ? `<label class="confirm-field">${esc(field.label)}
           ${field.type === "textarea"
            ? '<textarea id="confirmFieldInput" rows="3"></textarea>'
            : `<input id="confirmFieldInput" type="${esc(field.type || "text")}" value="${esc(field.value || "")}">`}
         </label>`
      : "";

    box.innerHTML = `
      <div class="modal-head"><h3>${esc(title)}</h3></div>
      <div class="confirm-body">${esc(body)}</div>
      ${fieldHtml}
      <div class="confirm-actions">
        <span class="msg" id="confirmMsg"></span>
        <button type="button" class="link-btn ghost" data-confirm-cancel>Cancelar</button>
        <button type="button" class="${danger ? "btn-danger" : "btn-primary"}" data-confirm-ok>${esc(confirmLabel)}</button>
      </div>`;
    overlay.hidden = false;

    const input = document.getElementById("confirmFieldInput");
    if (input) input.focus();
    else box.querySelector("[data-confirm-ok]").focus();

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.removeEventListener("click", onBackdrop);
      overlay.hidden = true;
      box.innerHTML = "";
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      finish({ ok: false, value: null });
    };
    const onBackdrop = (event) => { if (event.target === overlay) finish({ ok: false, value: null }); };

    box.querySelector("[data-confirm-cancel]").addEventListener("click", () => finish({ ok: false, value: null }));
    box.querySelector("[data-confirm-ok]").addEventListener("click", () => {
      const value = input ? input.value.trim() : null;
      if (field?.required && !value) {
        document.getElementById("confirmMsg").textContent = "Hace falta completar este campo.";
        input.focus();
        return;
      }
      finish({ ok: true, value });
    });
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", onBackdrop);
  });
}

export function confirmIsOpen() {
  const overlay = document.getElementById("modalOverlay");
  return Boolean(overlay && !overlay.hidden);
}
