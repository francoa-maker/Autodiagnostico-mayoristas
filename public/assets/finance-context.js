// Captura el pedido que abre admin.js sin modificar el archivo legado.
// fetchJson usa window.fetch en cada llamada; envolvemos la función una sola vez
// y clonamos únicamente la respuesta GET /api/admin/quotes/:id.

let currentContext = null;
let installed = false;

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url || "";
}

function quoteIdFromUrl(value) {
  try {
    const url = new URL(value, location.origin);
    const match = url.pathname.match(/^\/api\/admin\/quotes\/([0-9a-f-]{36})$/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function normalizeQuote(quote, fallbackId) {
  if (!quote) return null;
  return {
    orderId: String(quote.id || fallbackId || ""),
    clientId: String(quote.user_id || ""),
    paymentTerms: String(quote.payment_terms || ""),
    paymentCondition: String(quote.payment_condition || ""),
    dueDate: quote.due_date ? String(quote.due_date).slice(0, 10) : "",
    currency: String(quote.currency || "ARS")
  };
}

function emit(name, detail = {}) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

export function installFinanceContextCapture() {
  if (installed) return;
  installed = true;
  const previousFetch = window.fetch.bind(window);

  window.fetch = async (...args) => {
    const id = quoteIdFromUrl(requestUrl(args[0]));
    if (id) {
      currentContext = null;
      emit("finance:context-cleared", { orderId: id });
    }
    const response = await previousFetch(...args);
    if (id && response.ok) {
      response.clone().json().then((body) => {
        const next = normalizeQuote(body?.quote, id);
        if (!next?.orderId) return;
        currentContext = next;
        emit("finance:context", next);
      }).catch(() => {});
    }
    return response;
  };
}

export function readFinanceContext() {
  const section = document.getElementById("financeSection");
  if (!section || !section.isConnected) return null;
  if (section.dataset.orderId) {
    return {
      orderId: section.dataset.orderId,
      clientId: section.dataset.clientId || "",
      paymentTerms: section.dataset.paymentTerms || "",
      paymentCondition: section.dataset.paymentCondition || "",
      dueDate: section.dataset.dueDate || "",
      currency: section.dataset.currency || "ARS"
    };
  }
  return currentContext;
}

export function updatePaymentCondition(value) {
  if (currentContext) currentContext.paymentCondition = value || "";
  const section = document.getElementById("financeSection");
  if (section) section.dataset.paymentCondition = value || "";
}

export function refreshFinanceOrder(orderId) {
  const escaped = window.CSS?.escape ? CSS.escape(String(orderId)) : String(orderId).replace(/"/g, "\\\"");
  const row = document.querySelector(`[data-bill="${escaped}"]`);
  if (row) {
    row.click();
    return true;
  }
  emit("finance:refresh-requested", { orderId: String(orderId) });
  return false;
}

installFinanceContextCapture();
