import { fetchJson, postJson, patchJson, putJson, money, STOCK_LABEL } from "/assets/api.js";
import { mountLogistics } from "/assets/logistics.js";

function timeAgo(iso) {
  if (!iso) return "-";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "recién";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return new Date(iso).toLocaleDateString("es-AR");
}

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function norm(value) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const AUDIT_ACTION_INFO = {
  "user.create": ["Se agregó un cliente", "👤"],
  "user.update": ["Se actualizaron el acceso o el rol de un usuario", "👤"],
  "user.profile.update": ["Se actualizaron los datos de un cliente", "👤"],
  "user.delete": ["Se eliminó un cliente", "👤"],
  "brand_logos.update": ["Se actualizaron los logos de las marcas", "🏷️"],
  "catalog.order.update": ["Se cambió el orden del catálogo", "↕️"],
  "product.reorder": ["Se cambió el orden de los productos", "↕️"],
  "brand.rename": ["Se cambió el nombre de una marca", "🏷️"],
  "category.rename": ["Se cambió el nombre de una categoría", "🏷️"],
  "product.bulk_assign": ["Se reasignaron productos en el catálogo", "📦"],
  "product.create": ["Se creó un producto", "📦"],
  "product.update": ["Se actualizaron los datos de un producto", "📦"],
  "product.delete": ["Se eliminó un producto", "📦"],
  "price.update": ["Se actualizaron los precios de un producto", "💲"],
  "quote.create": ["Se creó una cotización", "📝"],
  "quote.submit": ["Un cliente envió una solicitud de cotización", "📝"],
  "quote.update": ["Se actualizó una cotización", "📝"],
  "quote.delete": ["Se eliminó una cotización", "📝"],
  "quote.note": ["Se agregó una nota interna a una cotización", "💬"],
  "quote.items.reorder": ["Se cambió el orden de una cotización", "↕️"],
  "quote.item.add": ["Se agregó un producto a una cotización", "➕"],
  "quote.item.update": ["Se modificó un producto de una cotización", "✏️"],
  "quote.item.delete": ["Se quitó un producto de una cotización", "➖"],
  "quote.line.add": ["Se agregó una sección o nota a una cotización", "➕"],
  "quote.proforma.sent": ["Se envió una pre-compra por email", "✉️"],
  "quote.warehouse.sent": ["Se envió una orden al depósito", "🚚"],
  "order.authorize": ["Se autorizó una orden de venta", "✅"],
  "order.payment_condition.update": ["Se cambió la condición de pago de una orden", "💳"],
  "order.dispatch": ["Se registró el despacho de una orden", "🚚"],
  "invoice.create": ["Se creó una factura", "🧾"],
  "invoice.void": ["Se anuló una factura", "🧾"],
  "account.adjustment": ["Se registró un ajuste de cuenta", "💰"],
  "account.movement.reverse": ["Se revirtió un movimiento de cuenta", "↩️"],
  "payment.create": ["Se registró un pago", "💳"],
  "payment.confirm": ["Se confirmó un pago", "✅"],
  "payment.apply": ["Se aplicó un pago a una factura", "💳"],
  "payment.reverse": ["Se revirtió un pago", "↩️"],
  "payment.inform": ["Un cliente informó un pago", "💳"],
  "echeq.create": ["Se registró un eCheq", "🏦"],
  "echeq.accept": ["Se aceptó un eCheq", "🏦"],
  "echeq.accredit": ["Se acreditó un eCheq", "✅"],
  "echeq.reject": ["Se rechazó un eCheq", "⚠️"],
  "serial.register": ["Se registraron números de serie", "🔢"],
  "serial.remove": ["Se quitó un número de serie", "🔢"],
  "document.upload": ["Se subió un documento", "📎"],
  "document.upload.client": ["Un cliente subió un documento", "📎"],
  "document.delete": ["Se eliminó un documento", "📎"],
  "company_profile.update": ["Se actualizaron los datos de la empresa", "⚙️"],
  "email_recipients.update": ["Se actualizaron los destinatarios de email", "✉️"]
};

const AUDIT_ENTITY_LABELS = {
  user: "Cliente",
  product: "Producto",
  quote_request: "Cotización",
  quote_item: "Producto de cotización",
  invoice: "Factura",
  payment: "Pago",
  echeq: "eCheq",
  account_movement: "Movimiento de cuenta",
  document: "Documento",
  order_item_serial: "Número de serie",
  app_settings: "Configuración"
};

function auditInfo(action) {
  if (AUDIT_ACTION_INFO[action]) {
    const [label, icon] = AUDIT_ACTION_INFO[action];
    return { label, icon };
  }
  const readable = String(action || "actividad")
    .replace(/[._]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return { label: readable, icon: "•" };
}

function auditActor(entry) {
  return entry.actor_name || entry.actor_email || "Sistema";
}

async function deleteJson(url) {
  return fetchJson(url, { method: "DELETE" });
}

let currentUser = null;
let CAN_MANAGE_QUOTES = false; // ventas: editar precios/ítems/estado de la cotización

// Normaliza roles legacy en el front (espeja src/permissions.js).
function roleOf(user) {
  if (!user) return "client";
  if (user.role === "admin") return "superadmin";
  if (user.role === "customer") return "client";
  return user.role || "client";
}

// Qué secciones ve cada rol. La seguridad real vive en el backend (capabilities);
// esto sólo ordena la UI para que cada sector vea lo suyo.
const SECTIONS_BY_ROLE = {
  superadmin: ["dashboard", "catalog", "products", "clients", "quotes", "billing", "logistics", "settings"],
  sales_billing: ["dashboard", "catalog", "products", "clients", "quotes", "billing", "logistics", "settings"],
  administration: ["billing"],
  logistics: ["logistics"]
};
function allowedSections() { return SECTIONS_BY_ROLE[roleOf(currentUser)] || []; }

async function loadMe() {
  const { user } = await fetchJson("/api/me");
  if (!user) return (location.href = "/login");
  // Acceso al panel: todo el personal interno (incluye logística; 'admin' es legacy).
  if (!["superadmin", "sales_billing", "administration", "logistics", "admin"].includes(user.role)) return (location.href = "/");
  currentUser = user;
  CAN_MANAGE_QUOTES = ["superadmin", "sales_billing", "admin"].includes(user.role);
  document.getElementById("adminName").textContent = user.display_name || user.email;
  document.getElementById("adminEmail").textContent = user.email;
  const subtitle = document.getElementById("dashboardSubtitle");
  if (subtitle) {
    subtitle.textContent = roleOf(user) === "superadmin"
      ? "Panorama comercial, clientes, stock y operación"
      : "Prioridades de ventas, cotizaciones y facturación";
  }
}

// ==================== Dashboard ====================

function renderKpis({ totalProducts, withStock, withoutStock, pendingQuotes, pendingUsers }) {
  const items = [
    { label: "Productos del portal", value: totalProducts, icon: "&#128230;", bg: "var(--brand-red-soft)", fg: "var(--brand-red)", section: "products" },
    { label: "Con stock", value: withStock, icon: "&#10003;", bg: "var(--success-soft)", fg: "var(--success)", sub: totalProducts ? `${Math.round((withStock / totalProducts) * 100)}% del total` : "", section: "catalog" },
    { label: "Sin stock", value: withoutStock, icon: "&#9888;", bg: "var(--danger-soft)", fg: "var(--danger)", section: "catalog", quick: "low-stock" },
    { label: "Cotizaciones pendientes", value: pendingQuotes, icon: "&#128172;", bg: "var(--info-soft)", fg: "var(--info)", section: "quotes", filter: "cotizacion" },
    { label: "Usuarios pendientes", value: pendingUsers, icon: "&#128100;", bg: "var(--warning-soft)", fg: "var(--warning)", section: "clients", filter: "pending" }
  ];
  document.getElementById("kpiRow").innerHTML = items
    .map(
      (item) => `<button class="kpi-card kpi-link" type="button" data-kpi-section="${item.section}" data-kpi-filter="${item.filter || ""}" data-kpi-quick="${item.quick || ""}">
        <div class="kpi-icon" style="background:${item.bg};color:${item.fg}">${item.icon}</div>
        <div><div class="kl">${item.label}</div><div class="kv tabular">${item.value}</div>${item.sub ? `<div class="ksub" style="color:${item.fg}">${item.sub}</div>` : ""}</div>
        <span class="kpi-arrow" aria-hidden="true">→</span>
      </button>`
    )
    .join("");
}

async function loadStockHealth() {
  const health = await fetchJson("/api/admin/stock/health");
  const dot = document.getElementById("sourceDot");
  const headline = document.getElementById("sourceHeadline");
  const detail = document.getElementById("sourceDetail");
  if (!health.healthy) {
    dot.className = "source-dot err";
    headline.textContent = `Fuente de stock: ${health.reason || "error"}`;
    detail.textContent = "";
    return;
  }
  dot.className = "source-dot";
  headline.textContent = "Fuente de stock: saludable";
  detail.textContent = `Última lectura ${health.lastUpdate ? new Date(health.lastUpdate).toLocaleString("es-AR") : "desconocida"} · ${health.matched} SKU con match · ${health.unmatched} sin match${health.duplicateSkuCount ? ` · ${health.duplicateSkuCount} SKU duplicados` : ""}`;
}

async function loadLowStock() {
  const { products } = await fetchJson("/api/admin/stock/low");
  const body = document.getElementById("lowStockBody");
  body.innerHTML =
    products
      .map(
        (p) => `<tr>
          <td style="font-family:var(--font-mono)">${p.sku}</td>
          <td>${esc(p.name)}</td>
          <td>${esc(p.brand)}</td>
          <td class="tabular qty-danger">${p.stock.exactQty ?? 0}</td>
          <td><span class="status-pill ${p.stock.status === "out_of_stock" ? "rejected" : "pending"}">${p.stock.status === "out_of_stock" ? "Sin stock" : "Poco stock"}</span></td>
        </tr>`
      )
      .join("") || '<tr><td colspan="5" class="empty-row">Todo el catálogo tiene stock saludable.</td></tr>';
  return products.length;
}

async function loadPendingUsers() {
  const { users } = await fetchJson("/api/admin/users?status=pending");
  const body = document.getElementById("pendingUsersBody");
  body.innerHTML =
    users
      .map(
        (u) => `<tr data-id="${u.id}">
          <td>${esc(u.email)}</td>
          <td>${esc(u.company_name || "-")}</td>
          <td>${timeAgo(u.created_at)}</td>
          <td style="display:flex;gap:6px">
            <button class="link-btn" data-action="approve">Aprobar</button>
            <button class="link-btn ghost" data-action="reject">Rechazar</button>
          </td>
        </tr>`
      )
      .join("") || '<tr><td colspan="4" class="empty-row">No hay usuarios pendientes.</td></tr>';
  return users.length;
}

document.getElementById("pendingUsersBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const row = btn.closest("tr");
  const status = btn.dataset.action === "approve" ? "approved" : "rejected";
  btn.disabled = true;
  try {
    await patchJson(`/api/admin/users/${row.dataset.id}`, { status });
    row.remove();
    refreshKpis();
  } catch (error) {
    alert("No se pudo actualizar el usuario: " + error.message);
    btn.disabled = false;
  }
});

async function loadRecentQuotes() {
  const { quotes } = await fetchJson("/api/admin/quotes");
  const el = document.getElementById("recentQuotes");
  el.innerHTML =
    quotes
      .slice(0, 6)
      .map(
        (q) => `<button class="recent-quote-link" type="button" data-recent-quote="${q.id}">
          <span><strong>#${q.request_number}</strong> · ${esc(q.display_name || q.email)}</span>
          <span class="tabular" style="color:var(--muted)">${money(q.quoted_total ?? q.displayed_subtotal)}</span>
        </button>`
      )
      .join("") || '<div class="empty-row">Todavía no hay cotizaciones.</div>';
  return quotes.filter((q) => normStatus(q.status) === "cotizacion" && !q.assigned_admin_id).length;
}

let auditEntries = [];
function auditGroup(entry) {
  const action = String(entry.action || "");
  if (entry.entity_type === "user" || action.startsWith("user.")) return "user";
  if (["quote_request", "quote_item"].includes(entry.entity_type) || action.startsWith("quote.") || action.startsWith("order.")) return "quote";
  if (entry.entity_type === "product" || action.startsWith("product.") || action.startsWith("price.") || action.startsWith("catalog.")) return "product";
  if (["invoice", "payment", "echeq", "account_movement"].includes(entry.entity_type) || /^(invoice|payment|echeq|account)\./.test(action)) return "finance";
  return "other";
}

function renderAudit() {
  const el = document.getElementById("auditFeed");
  const type = document.getElementById("auditTypeFilter")?.value || "";
  const actor = document.getElementById("auditActorFilter")?.value || "";
  const date = document.getElementById("auditDateFilter")?.value || "";
  const now = Date.now();
  const entries = auditEntries.filter((entry) => {
    if (type && auditGroup(entry) !== type) return false;
    if (actor && auditActor(entry) !== actor) return false;
    if (date === "today" && new Date(entry.created_at).toDateString() !== new Date().toDateString()) return false;
    if (/^\d+$/.test(date) && now - new Date(entry.created_at).getTime() > Number(date) * 86400000) return false;
    return true;
  });
  el.innerHTML = entries.slice(0, 30).map((entry) => {
    const info = auditInfo(entry.action);
    const entity = AUDIT_ENTITY_LABELS[entry.entity_type] || "Registro";
    const exactDate = entry.created_at ? new Date(entry.created_at).toLocaleString("es-AR") : "";
    const canOpen = ["user", "product", "quote_request", "quote_item", "invoice", "payment", "echeq"].includes(entry.entity_type);
    return `<button class="audit-item${canOpen ? " actionable" : ""}" type="button" data-audit-id="${entry.id}" ${canOpen ? "" : "disabled"}>
      <span class="audit-icon" aria-hidden="true">${info.icon}</span>
      <span class="audit-copy">
        <strong>${esc(info.label)}</strong>
        <span>${esc(entity)} · por ${esc(auditActor(entry))}</span>
      </span>
      <time datetime="${esc(entry.created_at)}" title="${esc(exactDate)}">${timeAgo(entry.created_at)}</time>
    </button>`;
  }).join("") || '<div class="empty-row">No hay actividad para esos filtros.</div>';
}

async function loadAudit() {
  const { entries } = await fetchJson("/api/admin/audit");
  auditEntries = entries || [];
  const actors = [...new Set(auditEntries.map(auditActor).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  const actorSelect = document.getElementById("auditActorFilter");
  actorSelect.innerHTML = '<option value="">Todos los usuarios</option>' + actors.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
  renderAudit();
}

function renderAttention({ pendingUsers, pendingQuotes, lowStock, billingDue = null }) {
  const entries = [
    { count: pendingUsers, label: "clientes esperan aprobación", action: "Revisar clientes", section: "clients", filter: "pending", tone: "warning" },
    { count: pendingQuotes, label: "cotizaciones nuevas sin asignar", action: "Revisar cotizaciones", section: "quotes", filter: "cotizacion", tone: "info" },
    { count: lowStock, label: "productos con poco o sin stock", action: "Revisar catálogo", section: "catalog", quick: "low-stock", tone: "danger" }
  ];
  if (billingDue != null) entries.push({ count: billingDue, label: "pedidos pendientes de cobro", action: "Ir a facturación", section: "billing", filter: "por_cobrar", tone: "finance" });
  const total = entries.reduce((sum, item) => sum + Number(item.count || 0), 0);
  document.getElementById("attentionCount").textContent = `${total} pendiente${total === 1 ? "" : "s"}`;
  document.getElementById("attentionGrid").innerHTML = entries.map((item) => `<button class="attention-item ${item.tone}" type="button"
    data-kpi-section="${item.section}" data-kpi-filter="${item.filter || ""}" data-kpi-quick="${item.quick || ""}">
      <strong>${item.count}</strong><span>${item.label}</span><small>${item.action} →</small>
    </button>`).join("");
}

async function refreshKpis() {
  const [{ brands }, withoutStockCount, pendingQuoteCount, pendingUserCount] = await Promise.all([
    fetchJson("/api/catalog/brands"),
    loadLowStock(),
    loadRecentQuotes(),
    loadPendingUsers()
  ]);
  const totalProducts = brands.reduce((sum, b) => sum + Number(b.count), 0);
  renderKpis({
    totalProducts,
    withStock: Math.max(0, totalProducts - withoutStockCount),
    withoutStock: withoutStockCount,
    pendingQuotes: pendingQuoteCount,
    pendingUsers: pendingUserCount
  });
  let billingDue = null;
  try {
    const { orders } = await fetchJson("/api/admin/finance/orders");
    billingDue = orders.filter((order) => order.payState !== "pagada").length;
  } catch { /* el módulo o el rol pueden no tener acceso */ }
  renderAttention({ pendingUsers: pendingUserCount, pendingQuotes: pendingQuoteCount, lowStock: withoutStockCount, billingDue });
}

// ==================== Modal helper ====================

const overlay = document.getElementById("modalOverlay");
const modalBox = document.getElementById("modalBox");
function openModal(html) {
  modalBox.innerHTML = html;
  overlay.hidden = false;
}
function closeModal() {
  overlay.hidden = true;
  modalBox.innerHTML = "";
}
overlay.addEventListener("click", (e) => {
  if (e.target === overlay || e.target.closest("[data-close]")) closeModal();
});

// ==================== Navegación entre secciones ====================

const sectionLoaders = {
  catalog: openCatalogEditor,
  products: loadProducts,
  clients: async () => { await populateMonths("clientMonthFilter", "/api/admin/users/months"); await loadClients(); },
  quotes: async () => { await populateMonths("quoteMonthFilter", "/api/admin/quotes/months"); await loadQuotes(); },
  billing: loadBillingOrders,
  logistics: mountLogisticsSection,
  settings: loadCompanyProfile
};
const loadedSections = new Set();

function openAdminSection(section, { reload = false } = {}) {
  const link = document.querySelector(`#adminNav a[data-section="${section}"]`);
  if (!link || link.style.display === "none") return false;
  document.querySelectorAll("#adminNav a").forEach((a) => a.classList.toggle("active", a === link));
  document.querySelectorAll(".admin-section").forEach((s) => (s.hidden = s.id !== `section-${section}`));
  const loader = sectionLoaders[section];
  if (loader && (reload || !loadedSections.has(section))) {
    loadedSections.add(section);
    loader();
  }
  return true;
}

document.getElementById("adminNav").addEventListener("click", (e) => {
  const link = e.target.closest("a[data-section]");
  if (link) openAdminSection(link.dataset.section);
});

function followDashboardLink(button) {
  const section = button.dataset.kpiSection;
  const filter = button.dataset.kpiFilter;
  if (!openAdminSection(section)) return;
  if (section === "clients" && filter) {
    document.getElementById("clientStatusFilter").value = filter;
    loadClients();
  } else if (section === "quotes" && filter) {
    document.getElementById("quoteStatusFilter").value = filter;
    loadQuotes();
  } else if (section === "billing" && filter) {
    billingFilter = filter;
    document.getElementById("billingFilter").value = filter;
    renderBillingTable();
  }
}
document.getElementById("section-dashboard").addEventListener("click", (e) => {
  const jump = e.target.closest("[data-kpi-section]");
  if (jump) { followDashboardLink(jump); return; }
  const recent = e.target.closest("[data-recent-quote]");
  if (recent && openAdminSection("quotes")) {
    currentQuoteId = recent.dataset.recentQuote;
    renderQuoteEditor(currentQuoteId);
  }
…30764 tokens truncated… error.message); }
    }
  });
}

async function saveQuoteHeader(id) {
  const msg = document.getElementById("quoteSaveMsg");
  try {
    await patchJson(`/api/admin/quotes/${id}`, {
      status: document.getElementById("quoteStatus").value,
      discount: Number(document.getElementById("qDiscount").value || 0),
      discountType: document.getElementById("qDiscountType").value,
      shipping: Number(document.getElementById("qShipping").value || 0),
      publicNotes: document.getElementById("qPublicNotes").value,
      paymentTerms: document.getElementById("qPaymentTerms")?.value ?? "",
      dueDate: document.getElementById("qDueDate")?.value || null
    });
    msg.textContent = "Guardado ✓";
    setTimeout(() => (msg.textContent = ""), 1800);
    await renderQuoteEditor(id);
    await loadQuotes();
  } catch (error) {
    alert("No se pudo guardar la cotización: " + error.message);
  }
}

async function sendWarehouse(id) {
  if (!currentUser?.gmail_connected) {
    if (confirm("Necesitás conectar tu Gmail una vez para enviar desde tu casilla. ¿Conectar ahora?")) location.href = "/auth/google/gmail";
    return;
  }
  const extra = document.getElementById("warehouseExtra").value.trim();
  const btn = document.getElementById("sendWarehouseBtn");
  const msg = document.getElementById("warehouseMsg");
  btn.disabled = true;
  btn.textContent = "Enviando...";
  try {
    const r = await postJson(`/api/admin/quotes/${id}/send-warehouse`, extra ? { extraEmail: extra } : {});
    msg.textContent = "Enviado a: " + (r.recipients || []).join(", ");
  } catch (error) {
    alert("No se pudo enviar al depósito: " + (error.body?.detail || error.message));
  } finally {
    btn.disabled = false;
    btn.textContent = "📦 Enviar al depósito";
  }
}

// Compositor de email multi-destinatario (guía §11.1): Para + CC, desde la casilla
// del vendedor. (Programar envío / plantillas quedan para una próxima iteración.)
async function sendProforma(id, clientEmail) {
  if (!currentUser?.gmail_connected) {
    if (confirm("Necesitás conectar tu Gmail una vez para enviar desde tu casilla. ¿Conectar ahora?")) {
      location.href = "/auth/google/gmail";
    }
    return;
  }
  // Precarga el CC desde la config de notificaciones (CC global + evento "enviada").
  let defaultCc = "";
  try {
    const { recipients } = await fetchJson("/api/admin/email-recipients");
    defaultCc = [recipients.globalCc, recipients.events?.enviada].filter(Boolean).join(", ");
  } catch { /* la config es opcional */ }
  openModal(`
    <div class="modal-head"><h3>Enviar al cliente</h3><button class="modal-x" data-close>&times;</button></div>
    <div class="form-grid">
      <label class="full">Para<input id="emailTo" value="${esc(clientEmail || "")}" placeholder="cliente@correo.com"></label>
      <label class="full">CC <span style="color:var(--muted);font-weight:400">(separá varios con coma)</span><input id="emailCc" value="${esc(defaultCc)}" placeholder="ventas@empresa.com, contador@empresa.com"></label>
    </div>
    <p style="font-size:12px;color:var(--muted);margin:10px 0">El documento (Pre-compra/Compra) se envía en el cuerpo del correo, desde tu casilla de Gmail.</p>
    <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:8px">
      <span id="emailMsg" style="font-size:12px;margin-right:auto"></span>
      <button class="link-btn ghost" data-close>Cancelar</button>
      <button class="btn-primary" id="emailSendBtn" type="button">Enviar</button>
    </div>`);
  document.getElementById("emailSendBtn").addEventListener("click", async () => {
    const to = document.getElementById("emailTo").value.trim();
    const cc = document.getElementById("emailCc").value.split(",").map((s) => s.trim()).filter(Boolean);
    const msg = document.getElementById("emailMsg");
    if (!to) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Ingresá al menos un destinatario."; return; }
    const btn = document.getElementById("emailSendBtn");
    btn.disabled = true; btn.textContent = "Enviando...";
    try {
      // Persistir precios/ajustes en pantalla antes de enviar (el editor sigue montado).
      await patchJson(`/api/admin/quotes/${id}`, {
        status: document.getElementById("quoteStatus").value,
        discount: Number(document.getElementById("qDiscount").value || 0),
        discountType: document.getElementById("qDiscountType").value,
        shipping: Number(document.getElementById("qShipping").value || 0),
        publicNotes: document.getElementById("qPublicNotes").value,
        paymentTerms: document.getElementById("qPaymentTerms")?.value ?? "",
        dueDate: document.getElementById("qDueDate")?.value || null
      });
      await postJson(`/api/admin/quotes/${id}/send-proforma`, { to, cc });
      closeModal();
      await renderQuoteEditor(id);
      await loadQuotes();
    } catch (error) {
      msg.style.color = "var(--danger,#c8102e)";
      msg.textContent = error.body?.detail || error.message;
      btn.disabled = false; btn.textContent = "Enviar";
    }
  });
}

function wireQuoteItemActions(id) {
  document.getElementById("quoteItemsBody").addEventListener("click", async (e) => {
    const row = e.target.closest("tr[data-item]");
    if (!row) return;
    const itemId = row.dataset.item;
    if (e.target.closest('[data-action="save-item"]')) {
      const btn = e.target.closest("button");
      btn.disabled = true;
      try {
        await putJson(`/api/admin/quotes/${id}/items/${itemId}`, {
          quantity: Number(row.querySelector('[data-f="quantity"]').value),
          unitPrice: row.querySelector('[data-f="unitPrice"]').value,
          ivaRate: Number(row.querySelector('[data-f="ivaRate"]').value)
        });
        await renderQuoteEditor(id);
        await loadQuotes();
      } catch (error) {
        alert("No se pudo guardar el item: " + error.message);
        btn.disabled = false;
      }
    } else if (e.target.closest('[data-action="del-item"]')) {
      if (!confirm("¿Quitar este producto de la cotización?")) return;
      try {
        await deleteJson(`/api/admin/quotes/${id}/items/${itemId}`);
        await renderQuoteEditor(id);
        await loadQuotes();
      } catch (error) {
        alert("No se pudo quitar el item: " + error.message);
      }
    }
  });
}

function wireAddProduct(id) {
  const search = document.getElementById("addProductSearch");
  const results = document.getElementById("addProductResults");
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    const term = search.value.trim();
    if (!term) return (results.innerHTML = "");
    timer = setTimeout(async () => {
      const { products } = await fetchJson(`/api/admin/products?search=${encodeURIComponent(term)}`);
      results.innerHTML = products
        .slice(0, 8)
        .map((p) => `<button class="add-result" data-add="${p.id}">${esc(p.sku)} · ${esc(p.name)}</button>`)
        .join("") || '<span style="font-size:12px;color:var(--muted);padding:6px">Sin resultados</span>';
    }, 300);
  });
  results.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-add]");
    if (!btn) return;
    const qty = Number(prompt("Cantidad:", "1"));
    if (!qty || qty < 1) return;
    try {
      await postJson(`/api/admin/quotes/${id}/items`, { productId: btn.dataset.add, quantity: qty });
      search.value = "";
      results.innerHTML = "";
      await renderQuoteEditor(id);
      await loadQuotes();
    } catch (error) {
      alert("No se pudo agregar el producto: " + error.message);
    }
  });
}

document.getElementById("newQuoteBtn").addEventListener("click", () => {
  openModal(`
    <div class="modal-head"><h3>Nueva cotización</h3><button class="modal-x" data-close>&times;</button></div>
    <div class="form-grid">
      <label class="full">Buscar cliente por email, nombre o empresa
        <input type="search" id="newQuoteClientSearch" class="admin-search" style="width:100%">
      </label>
      <div id="newQuoteClientResults" class="add-results full"></div>
    </div>`);
  const search = document.getElementById("newQuoteClientSearch");
  const results = document.getElementById("newQuoteClientResults");
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    const term = search.value.trim();
    if (!term) return (results.innerHTML = "");
    timer = setTimeout(async () => {
      const { users } = await fetchJson(`/api/admin/users?search=${encodeURIComponent(term)}`);
      results.innerHTML =
        users
          .slice(0, 8)
          .map(
            (u) => `<button class="add-result" data-user="${u.id}">${esc(u.display_name || u.email)}${u.company_name ? ` · ${esc(u.company_name)}` : ""} <span style="color:var(--muted)">(${esc(u.email)})</span></button>`
          )
          .join("") || '<span style="font-size:12px;color:var(--muted);padding:6px">Sin resultados</span>';
    }, 300);
  });
  results.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-user]");
    if (!btn) return;
    btn.disabled = true;
    try {
      const { quote } = await postJson("/api/admin/quotes", { userId: btn.dataset.user });
      closeModal();
      await loadQuotes();
      await populateMonths("quoteMonthFilter", "/api/admin/quotes/months");
      currentQuoteId = quote.id;
      document.querySelectorAll(".quote-row").forEach((r) => r.classList.toggle("active", r.dataset.id === quote.id));
      renderQuoteEditor(quote.id);
    } catch (error) {
      alert("No se pudo crear la cotización: " + (error.body?.detail || error.message));
      btn.disabled = false;
    }
  });
});

// ==================== Configuración (perfil de empresa) ====================

// Notificaciones automáticas por email (§11.1): CC global + destinatarios por evento.
async function loadNotifyRecipients() {
  const f = document.getElementById("notifyForm");
  if (!f) return;
  try {
    const { recipients } = await fetchJson("/api/admin/email-recipients");
    f.globalCc.value = recipients.globalCc || "";
    f.ev_enviada.value = recipients.events?.enviada || "";
    f.ev_orden.value = recipients.events?.orden || "";
    f.ev_pago.value = recipients.events?.pago || "";
    f.ev_despachado.value = recipients.events?.despachado || "";
  } catch { /* config opcional */ }
}
document.getElementById("notifyForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById("notifySaveMsg");
  try {
    await putJson("/api/admin/email-recipients", {
      recipients: {
        globalCc: f.globalCc.value.trim(),
        events: {
          enviada: f.ev_enviada.value.trim(),
          orden: f.ev_orden.value.trim(),
          pago: f.ev_pago.value.trim(),
          despachado: f.ev_despachado.value.trim()
        }
      }
    });
    msg.style.color = "var(--success,#137333)";
    msg.textContent = "Guardado ✓";
    setTimeout(() => (msg.textContent = ""), 1800);
  } catch (error) {
    msg.style.color = "var(--danger,#c8102e)";
    msg.textContent = "No se pudo guardar: " + (error.body?.detail || error.message);
  }
});

async function loadCompanyProfile() {
  const { profile } = await fetchJson("/api/admin/company-profile");
  await loadNotifyRecipients();
  const f = document.getElementById("companyForm");
  f.name.value = profile.name || "";
  f.legalName.value = profile.legalName || "";
  f.addressLines.value = (profile.addressLines || []).join("\n");
  f.phone.value = profile.phone || "";
  f.email.value = profile.email || "";
  f.website.value = profile.website || "";
  f.taxId.value = profile.taxId || "";
  f.warehouseEmail.value = profile.warehouseEmail || "";
  f.logoUrl.value = profile.logoUrl || "";
  f.proformaValidityDays.value = profile.proformaValidityDays ?? "";
  f.proformaFooter.value = profile.proformaFooter || "";
}

document.getElementById("companyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById("companySaveMsg");
  try {
    await putJson("/api/admin/company-profile", {
      profile: {
        name: f.name.value.trim(),
        legalName: f.legalName.value.trim(),
        addressLines: f.addressLines.value.split("\n").map((l) => l.trim()).filter(Boolean),
        phone: f.phone.value.trim(),
        email: f.email.value.trim(),
        website: f.website.value.trim(),
        taxId: f.taxId.value.trim(),
        warehouseEmail: f.warehouseEmail.value.trim(),
        logoUrl: f.logoUrl.value.trim(),
        proformaValidityDays: f.proformaValidityDays.value ? Number(f.proformaValidityDays.value) : 0,
        proformaFooter: f.proformaFooter.value.trim()
      }
    });
    msg.textContent = "Guardado ✓";
    setTimeout(() => (msg.textContent = ""), 2000);
  } catch (error) {
    alert("No se pudo guardar: " + error.message);
  }
});

// ==================== init ====================

// ==================== Auto-refresh (polling cada 12s) ====================

let lastSummary = null;

function toast(msg) {
  let host = document.getElementById("toastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 6000);
}

function currentSection() {
  return document.querySelector("#adminNav a.active")?.dataset.section;
}

async function pollSummary() {
  let s;
  try {
    s = await fetchJson("/api/admin/summary");
  } catch {
    return; // error de red puntual: reintenta en el próximo tick
  }
  if (lastSummary) {
    const newQuote = s.latest_quote_at !== lastSummary.latest_quote_at && s.total_quotes > lastSummary.total_quotes;
    const newUser = s.latest_user_at !== lastSummary.latest_user_at && s.total_users > lastSummary.total_users;
    if (newQuote) {
      toast("📩 Llegó una nueva cotización");
      loadRecentQuotes().catch(() => {});
      if (currentSection() === "quotes") {
        loadQuotes().catch(() => {});
        populateMonths("quoteMonthFilter", "/api/admin/quotes/months").catch(() => {});
      }
    }
    if (newUser) {
      toast("👤 Nuevo cliente registrado");
      loadPendingUsers().catch(() => {});
      if (currentSection() === "clients") {
        loadClients().catch(() => {});
        populateMonths("clientMonthFilter", "/api/admin/users/months").catch(() => {});
      }
    }
    if (newQuote || newUser || s.pending_users !== lastSummary.pending_users || s.pending_quotes !== lastSummary.pending_quotes) {
      refreshKpis().catch(() => {});
    }
  }
  lastSummary = s;
}

// ==================== Facturación (worklist por sector) ====================
const BILLING_STATE = {
  sin_facturar: { label: "Sin facturar", cls: "pending" },
  a_cobrar: { label: "A cobrar", cls: "pending" },
  parcial: { label: "Parcial", cls: "pending" },
  vencida: { label: "Vencida", cls: "rejected" },
  pagada: { label: "Pagada", cls: "approved" }
};
let billingFilter = "all";
let billingOrders = [];

async function loadBillingOrders() {
  const box = document.getElementById("billingOrders");
  box.innerHTML = "Cargando...";
  try {
    const { orders } = await fetchJson("/api/admin/finance/orders");
    billingOrders = orders;
    renderBillingTable();
  } catch (e) {
    box.innerHTML = `<p class="empty-row">No se pudo cargar: ${esc(e.body?.detail || e.message)}</p>`;
  }
}

function renderBillingTable() {
  const box = document.getElementById("billingOrders");
  const search = norm(document.getElementById("billingSearch")?.value || "");
  const orders = billingOrders.filter((o) => {
    if (billingFilter === "por_cobrar") return o.payState !== "pagada";
    if (billingFilter === "pagados") return o.payState === "pagada";
    return true;
  }).filter((o) => !search || norm(`${o.request_number} ${o.company_name} ${o.display_name} ${o.client_code} ${o.payState}`).includes(search));
  if (!orders.length) { box.innerHTML = '<p class="empty-row">No hay pedidos con ese filtro.</p>'; return; }
  box.innerHTML = `<div style="overflow-x:auto"><table>
    <thead><tr><th>#</th><th>Cliente</th><th>Estado</th><th class="num">Facturado</th><th class="num">Cobrado</th><th class="num">Saldo</th><th>Pago</th></tr></thead>
    <tbody>${orders.map((o) => {
      const st = BILLING_STATE[o.payState] || { label: o.payState, cls: "pending" };
      return `<tr data-bill="${o.id}" class="quote-row" style="cursor:pointer">
        <td><b>#${o.request_number}</b></td>
        <td>${esc(o.company_name || o.display_name || "")}${o.client_code ? ` <span style="color:var(--muted);font-size:11px">(${esc(o.client_code)})</span>` : ""}</td>
        <td><span class="status-pill ${statusPillClass(o.status)}">${QUOTE_STATUS_LABEL[o.status] || o.status}</span></td>
        <td class="num tabular">${o.invoice_count ? money(o.total_invoiced) : "-"}</td>
        <td class="num tabular">${o.total_paid ? money(o.total_paid) : "-"}</td>
        <td class="num tabular">${o.invoice_count ? money(o.balance) : "-"}</td>
        <td><span class="status-pill ${st.cls}">${st.label}</span></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
  box.querySelectorAll("[data-bill]").forEach((r) => r.addEventListener("click", () => {
    box.querySelectorAll(".quote-row").forEach((x) => x.classList.toggle("active", x === r));
    renderQuoteEditor(r.dataset.bill, "billingDetailBody");
  }));
}

// ==================== Logística (pestaña) ====================
async function mountLogisticsSection() {
  await mountLogistics(document.getElementById("logiOrdersAdmin"), document.getElementById("logiDetailAdmin"));
}

// ==================== Nav por rol ====================
function applyRoleNav() {
  const allowed = allowedSections();
  document.querySelectorAll("#adminNav a[data-section]").forEach((a) => {
    a.style.display = allowed.includes(a.dataset.section) ? "" : "none";
  });
  const landing = allowed[0] || "dashboard";
  document.querySelectorAll("#adminNav a").forEach((a) => a.classList.toggle("active", a.dataset.section === landing));
  document.querySelectorAll(".admin-section").forEach((s) => (s.hidden = s.id !== `section-${landing}`));
  const loader = sectionLoaders[landing];
  if (loader && !loadedSections.has(landing)) { loadedSections.add(landing); loader(); }
}

(async function init() {
  await loadMe();
  restoreSavedViews();
  const billingSel = document.getElementById("billingFilter");
  if (billingSel) billingSel.addEventListener("change", (e) => { billingFilter = e.target.value; renderBillingTable(); });
  document.getElementById("billingSearch")?.addEventListener("input", renderBillingTable);
  document.getElementById("saveBillingView")?.addEventListener("click", () => saveCurrentView("billing"));
  applyRoleNav();
  // El polling/KPIs/auditoría del dashboard sólo corre para roles que lo ven.
  if (allowedSections().includes("dashboard")) {
    await loadStockHealth();
    await refreshKpis();
    await loadAudit();
    await pollSummary(); // siembra lastSummary sin notificar
    setInterval(pollSummary, 12000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollSummary(); });
  }
})();
