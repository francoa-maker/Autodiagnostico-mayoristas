import { fetchJson } from "./api.js";

const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { active: "dashboard", productView: "cards", orderView: "quotes", pagers: new Map() };

function injectStyles() {
  for (const file of ["tokens.css", "base.css", "components.css", "admin-v5.css"]) {
    const id = `v5-${file}`;
    if (document.getElementById(id)) continue;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `/assets/${file}?v=20260731-v5`;
    document.head.appendChild(link);
  }
}

function installSprite() {
  if (q("#v5-icon-sprite")) return;
  const host = document.createElement("div");
  host.id = "v5-icon-sprite";
  host.hidden = true;
  host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">
    <symbol id="v5-i-home" viewBox="0 0 24 24"><path d="M3 11l9-8 9 8v10H3z"/><path d="M9 21v-7h6v7"/></symbol>
    <symbol id="v5-i-orders" viewBox="0 0 24 24"><path d="M6 3h12l2 4v14H4V7z"/><path d="M4 7h16M8 11h8M8 15h6"/></symbol>
    <symbol id="v5-i-box" viewBox="0 0 24 24"><path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/></symbol>
    <symbol id="v5-i-tags" viewBox="0 0 24 24"><path d="M3 4h8l10 10-7 7L4 11z"/><circle cx="8" cy="8" r="1.2"/></symbol>
    <symbol id="v5-i-truck" viewBox="0 0 24 24"><path d="M3 5h11v12H3zM14 9h4l3 4v4h-7z"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></symbol>
    <symbol id="v5-i-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21c1-5 3.5-7 7-7s6 2 7 7M16 5c3 0 5 2 5 5M17 14c3 .5 4.5 2.5 5 6"/></symbol>
    <symbol id="v5-i-settings" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 13.5l2 1.5-2 3-2.3-1a8 8 0 0 1-2.2 1.3L14 21h-4l-.5-2.7A8 8 0 0 1 7.3 17L5 18l-2-3 2-1.5a8 8 0 0 1 0-3L3 9l2-3 2.3 1a8 8 0 0 1 2.2-1.3L10 3h4l.5 2.7A8 8 0 0 1 16.7 7L19 6l2 3-2 1.5a8 8 0 0 1 0 3z"/></symbol>
    <symbol id="v5-i-download" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></symbol>
    <symbol id="v5-i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
  </svg>`;
  document.body.prepend(host);
}

function icon(name) {
  return `<svg class="v5-icon" aria-hidden="true"><use href="#v5-i-${name}"></use></svg>`;
}

function installToastChannel() {
  if (!q("#v5ToastStack")) {
    const stack = document.createElement("div");
    stack.id = "v5ToastStack";
    stack.className = "v5-toast-stack";
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  window.v5Toast = (message, type = "") => {
    const toast = document.createElement("div");
    toast.className = `v5-toast ${type}`.trim();
    toast.innerHTML = `<span>${type === "error" ? "!" : "✓"}</span><div></div><button type="button" aria-label="Cerrar">×</button>`;
    toast.children[1].textContent = String(message);
    toast.querySelector("button").addEventListener("click", () => toast.remove());
    q("#v5ToastStack").appendChild(toast);
    setTimeout(() => toast.remove(), 4800);
  };
  window.alert = (message) => window.v5Toast(message);
}

function legacyLink(section) {
  return q(`#adminNav > a[data-section="${section}"]`);
}

function clickLegacy(section) {
  const link = legacyLink(section);
  if (!link) return;
  link.click();
}

function roleTargets(role) {
  const normalized = role === "admin" ? "superadmin" : role;
  if (normalized === "logistics") return new Set(["logistics"]);
  if (normalized === "administration") return new Set(["dashboard", "orders", "clients"]);
  if (normalized === "sales_billing") return new Set(["dashboard", "orders", "logistics", "products", "taxonomy", "clients"]);
  return new Set(["dashboard", "orders", "logistics", "products", "taxonomy", "clients", "settings"]);
}

function navButton(target, label, iconName) {
  return `<button type="button" class="v5-nav-item" data-v5-admin-target="${target}">${icon(iconName)}<span>${label}</span></button>`;
}

async function installNavigation() {
  const nav = q("#adminNav");
  if (!nav || q(".v5-admin-nav", nav)) return;
  let role = "superadmin";
  try { role = (await fetchJson("/api/me")).user?.role || role; } catch { /* admin.js handles auth */ }
  const allowed = roleTargets(role);
  const shell = document.createElement("div");
  shell.className = "v5-admin-nav";
  const groups = [
    ["OPERACIÓN", [["dashboard", "Inicio", "home"], ["orders", "Pedidos", "orders"], ["logistics", "Logística", "truck"]]],
    ["CATÁLOGO", [["products", "Productos", "box"], ["taxonomy", "Marcas y categorías", "tags"]]],
    ["ADMINISTRACIÓN", [["clients", "Clientes", "users"], ["settings", "Configuración", "settings"]]]
  ];
  shell.innerHTML = groups.map(([label, items]) => {
    const visible = items.filter(([target]) => allowed.has(target));
    if (!visible.length) return "";
    return `<div class="v5-nav-group">${label}</div>${visible.map(([target, text, iconName]) => navButton(target, text, iconName)).join("")}`;
  }).join("");
  nav.appendChild(shell);
  qa("[data-v5-admin-target]", shell).forEach((button) => button.addEventListener("click", () => showTarget(button.dataset.v5AdminTarget)));

  const mobileButton = document.createElement("button");
  mobileButton.className = "v5-mobile-menu";
  mobileButton.type = "button";
  mobileButton.setAttribute("aria-label", "Abrir navegación");
  mobileButton.innerHTML = icon("menu");
  mobileButton.addEventListener("click", () => document.body.classList.toggle("v5-menu-open"));
  document.body.appendChild(mobileButton);

  const mobileHead = document.createElement("div");
  mobileHead.className = "v5-mobile-head";
  mobileHead.innerHTML = `<strong>Portal Autodiagnóstico</strong><span id="v5MobileSection">Inicio</span>`;
  q(".admin-main")?.prepend(mobileHead);
}

function ensureProductSwitch(section) {
  if (!section || q(".v5-product-switch", section)) return;
  const bar = document.createElement("div");
  bar.className = "v5-section-toolbar v5-product-switch";
  bar.innerHTML = `<div class="v5-tabs"><button type="button" class="v5-tab" data-v5-product-view="cards">Tarjetas</button><button type="button" class="v5-tab" data-v5-product-view="table">Tabla y precios</button></div><span class="v5-spacer"></span><button class="v5-btn" type="button" data-v5-export="products">${icon("download")} Exportar CSV</button>`;
  section.querySelector(".admin-topline")?.after(bar);
  qa("[data-v5-product-view]", bar).forEach((button) => button.addEventListener("click", () => showProducts(button.dataset.v5ProductView)));
  q('[data-v5-export="products"]', bar)?.addEventListener("click", () => exportTable(q("#section-products table") || q("#section-catalog table"), "productos.csv"));
}

function showProducts(view = "cards") {
  state.active = "products";
  state.productView = view;
  clickLegacy(view === "table" ? "products" : "catalog");
  const section = q(view === "table" ? "#section-products" : "#section-catalog");
  const title = section?.querySelector("h1");
  if (title) title.textContent = "Productos";
  ensureProductSwitch(section);
  qa("[data-v5-product-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.v5ProductView === view));
  updateNavState("products", `Productos · ${view === "table" ? "Tabla" : "Tarjetas"}`);
  updateHash(`productos/${view}`);
}

function ensureOrderSwitch(section) {
  if (!section || q(".v5-order-switch", section)) return;
  const bar = document.createElement("div");
  bar.className = "v5-section-toolbar v5-order-switch";
  bar.innerHTML = `<div class="v5-tabs"><button type="button" class="v5-tab" data-v5-order-view="quotes">Detalle comercial</button><button type="button" class="v5-tab" data-v5-order-view="billing">Facturación, pagos y cuenta</button></div><span class="v5-spacer"></span><button class="v5-btn" type="button" data-v5-export="orders">${icon("download")} Exportar CSV</button>`;
  section.querySelector(".admin-topline")?.after(bar);
  qa("[data-v5-order-view]", bar).forEach((button) => button.addEventListener("click", () => showOrders(button.dataset.v5OrderView)));
  q('[data-v5-export="orders"]', bar)?.addEventListener("click", () => exportTable(q("#section-quotes table"), "pedidos.csv"));
  const axes = document.createElement("div");
  axes.className = "v5-state-axes";
  axes.innerHTML = `<div class="v5-axis"><b>Venta</b>Cotización · Enviada · Orden · Despachado</div><div class="v5-axis"><b>Pago</b>Impago · Parcial · Pendiente · Vencido · Pagado</div><div class="v5-axis"><b>Logística</b>Pendiente · Autorizado · Preparando · Listo · Entregado</div>`;
  bar.after(axes);
}

function showOrders(view = "quotes") {
  state.active = "orders";
  state.orderView = view;
  clickLegacy(view === "billing" ? "billing" : "quotes");
  const section = q(view === "billing" ? "#section-billing" : "#section-quotes");
  const title = section?.querySelector("h1");
  if (title) title.textContent = "Pedidos";
  ensureOrderSwitch(section);
  qa("[data-v5-order-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.v5OrderView === view));
  updateNavState("orders", `Pedidos · ${view === "billing" ? "Facturación" : "Detalle"}`);
  updateHash(`pedidos/${view}`);
  setTimeout(refreshAllWorklists, 80);
}

function showTaxonomy() {
  state.active = "taxonomy";
  clickLegacy("catalog");
  updateNavState("taxonomy", "Marcas y categorías");
  updateHash("taxonomias");
  setTimeout(() => q("#catManageBtn")?.click(), 60);
}

function showSimple(section, target, title) {
  state.active = target;
  clickLegacy(section);
  updateNavState(target, title);
  updateHash(target === "dashboard" ? "inicio" : target);
  setTimeout(refreshAllWorklists, 80);
}

function showTarget(target) {
  document.body.classList.remove("v5-menu-open");
  if (target === "products") return showProducts(state.productView);
  if (target === "orders") return showOrders(state.orderView);
  if (target === "taxonomy") return showTaxonomy();
  const map = {
    dashboard: ["dashboard", "Inicio"],
    logistics: ["logistics", "Logística"],
    clients: ["clients", "Clientes"],
    settings: ["settings", "Configuración"]
  };
  const [section, title] = map[target] || map.dashboard;
  showSimple(section, target, title);
}

function updateNavState(target, mobileTitle) {
  qa("[data-v5-admin-target]").forEach((button) => button.classList.toggle("is-active", button.dataset.v5AdminTarget === target));
  const label = q("#v5MobileSection");
  if (label) label.textContent = mobileTitle;
}

function updateHash(path) {
  const next = `#/admin/${path}`;
  if (location.hash !== next) history.pushState(null, "", next);
}

function restoreHash() {
  const path = location.hash.replace(/^#\/?admin\/?/, "");
  if (path.startsWith("productos/table")) return showProducts("table");
  if (path.startsWith("productos")) return showProducts("cards");
  if (path.startsWith("pedidos/billing")) return showOrders("billing");
  if (path.startsWith("pedidos")) return showOrders("quotes");
  if (path.startsWith("taxonom")) return showTaxonomy();
  if (path.startsWith("logistics") || path.startsWith("logistica")) return showTarget("logistics");
  if (path.startsWith("clients") || path.startsWith("clientes")) return showTarget("clients");
  if (path.startsWith("settings") || path.startsWith("config")) return showTarget("settings");
  showTarget("dashboard");
}

function parseMoney(text) {
  const cleaned = String(text || "").replace(/[^\d,-]/g, "").replace(/\./g, "").replace(",", ".");
  return Number(cleaned) || 0;
}

function money(value) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(Number(value || 0));
}

function ensureKpis(section, key) {
  if (!section) return null;
  let strip = q(`[data-v5-kpis="${key}"]`, section);
  if (strip) return strip;
  strip = document.createElement("div");
  strip.className = "v5-kpi-strip";
  strip.dataset.v5Kpis = key;
  const anchor = q(".v5-state-axes", section) || q(".v5-section-toolbar", section) || q(".admin-topline", section);
  anchor?.after(strip);
  return strip;
}

function rowsOf(body) {
  return body ? qa(":scope > tr", body).filter((row) => !row.querySelector(".empty-row")) : [];
}

function renderQuoteKpis() {
  const body = q("#quotesBody");
  const strip = ensureKpis(q("#section-quotes"), "quotes");
  if (!strip) return;
  const rows = rowsOf(body);
  const total = rows.reduce((sum, row) => sum + parseMoney(row.cells[3]?.textContent), 0);
  const pending = rows.filter((row) => /cotizaci|pendiente/i.test(row.cells[2]?.textContent || "")).length;
  strip.innerHTML = `<div class="v5-kpi"><span>Registros</span><b>${rows.length}</b></div><div class="v5-kpi"><span>Pendientes</span><b>${pending}</b></div><div class="v5-kpi"><span>Total visible</span><b>${money(total)}</b></div><div class="v5-kpi"><span>Vista</span><b>Comercial</b></div>`;
}

function renderClientKpis() {
  const body = q("#clientsBody");
  const strip = ensureKpis(q("#section-clients"), "clients");
  if (!strip) return;
  const rows = rowsOf(body);
  const pending = rows.filter((row) => /pendiente|pending/i.test(row.cells[5]?.textContent || "")).length;
  const approved = rows.filter((row) => /aprobado|approved/i.test(row.cells[5]?.textContent || "")).length;
  strip.innerHTML = `<div class="v5-kpi"><span>Clientes</span><b>${rows.length}</b></div><div class="v5-kpi"><span>Pendientes</span><b>${pending}</b></div><div class="v5-kpi"><span>Aprobados</span><b>${approved}</b></div><div class="v5-kpi"><span>Estado</span><b>${pending ? "Revisar" : "Al día"}</b></div>`;
}

function renderProductKpis() {
  const body = q("#productsBody");
  const strip = ensureKpis(q("#section-products"), "products");
  if (!strip) return;
  const rows = rowsOf(body);
  const visible = rows.filter((row) => row.cells[8]?.querySelector("input:checked") || /visible|si|sí/i.test(row.cells[8]?.textContent || "")).length;
  strip.innerHTML = `<div class="v5-kpi"><span>Productos</span><b>${rows.length}</b></div><div class="v5-kpi"><span>Visibles</span><b>${visible}</b></div><div class="v5-kpi"><span>Ocultos</span><b>${Math.max(0, rows.length - visible)}</b></div><div class="v5-kpi"><span>Tramos</span><b>1 · 4 · 8</b></div>`;
}

function installPager(bodyId, pageSize = 25) {
  const body = q(`#${bodyId}`);
  if (!body || state.pagers.has(bodyId)) return;
  const table = body.closest("table");
  if (!table) return;
  const pager = document.createElement("div");
  pager.className = "v5-pager";
  pager.innerHTML = `<span data-v5-page-label></span><button type="button" data-v5-prev aria-label="Página anterior">‹</button><button type="button" data-v5-next aria-label="Página siguiente">›</button>`;
  table.parentElement?.after(pager);
  const model = { page: 0, pageSize, pager };
  state.pagers.set(bodyId, model);
  q("[data-v5-prev]", pager).addEventListener("click", () => { model.page = Math.max(0, model.page - 1); applyPager(bodyId); });
  q("[data-v5-next]", pager).addEventListener("click", () => { model.page += 1; applyPager(bodyId); });
  new MutationObserver(() => { model.page = 0; applyPager(bodyId); refreshAllWorklists(); }).observe(body, { childList: true });
  applyPager(bodyId);
}

function applyPager(bodyId) {
  const body = q(`#${bodyId}`);
  const model = state.pagers.get(bodyId);
  if (!body || !model) return;
  const rows = rowsOf(body).filter((row) => row.dataset.v5FilterHidden !== "true");
  const pages = Math.max(1, Math.ceil(rows.length / model.pageSize));
  model.page = Math.min(model.page, pages - 1);
  const start = model.page * model.pageSize;
  rows.forEach((row, index) => { row.hidden = index < start || index >= start + model.pageSize; });
  const label = q("[data-v5-page-label]", model.pager);
  if (label) label.textContent = rows.length ? `${start + 1}-${Math.min(rows.length, start + model.pageSize)} / ${rows.length}` : "0 / 0";
  q("[data-v5-prev]", model.pager).disabled = model.page === 0;
  q("[data-v5-next]", model.pager).disabled = model.page >= pages - 1;
}

function exportTable(table, filename) {
  if (!table) return window.v5Toast("No hay una tabla disponible para exportar", "error");
  const rows = qa("tr", table).filter((row) => !row.hidden);
  const csv = rows.map((row) => qa("th,td", row).map((cell) => `"${String(cell.innerText || "").replace(/"/g, '""').trim()}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  window.v5Toast(`Exportado: ${filename}`, "success");
}

function installClientExport() {
  const section = q("#section-clients");
  if (!section || q('[data-v5-export="clients"]', section)) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "v5-btn";
  button.dataset.v5Export = "clients";
  button.innerHTML = `${icon("download")} Exportar CSV`;
  button.addEventListener("click", () => exportTable(q("#section-clients table"), "clientes.csv"));
  q(".admin-topline > div:last-child", section)?.prepend(button);
}

function installSavedViews() {
  const inputs = ["clientSearch", "clientMonthFilter", "clientStatusFilter", "quoteSearch", "quoteMonthFilter", "quoteStatusFilter", "billingSearch", "billingFilter", "productSearch", "catSearch", "catBrandFilter", "catCategoryFilter"];
  const saved = JSON.parse(localStorage.getItem("autodiag:v5:views") || "{}");
  inputs.forEach((id) => {
    const element = q(`#${id}`);
    if (!element) return;
    if (saved[id] !== undefined) element.value = saved[id];
    element.addEventListener("change", () => saveViews(inputs));
  });
  qa("[data-save-view], #saveBillingView").forEach((button) => button.addEventListener("click", () => {
    saveViews(inputs);
    window.v5Toast("Vista guardada en este dispositivo", "success");
  }));
}

function saveViews(ids) {
  const values = {};
  ids.forEach((id) => { const element = q(`#${id}`); if (element) values[id] = element.value; });
  localStorage.setItem("autodiag:v5:views", JSON.stringify(values));
}

function enhanceDetail(container) {
  if (!container || container.dataset.v5Enhanced === "true") return;
  const candidates = qa("details", container).filter((details) => /factur|pago|cuenta|document|log[ií]st|actividad|serial/i.test(details.querySelector("summary")?.textContent || ""));
  if (candidates.length < 2) return;
  container.dataset.v5Enhanced = "true";
  const tabs = document.createElement("div");
  tabs.className = "v5-tabs";
  tabs.style.marginBottom = "12px";
  candidates.forEach((details, index) => {
    const label = (details.querySelector("summary")?.textContent || `Sección ${index + 1}`).trim();
    const button = document.createElement("button");
    button.type = "button";
    button.className = `v5-tab${index === 0 ? " is-active" : ""}`;
    button.textContent = label;
    button.addEventListener("click", () => {
      qa(".v5-tab", tabs).forEach((tab) => tab.classList.toggle("is-active", tab === button));
      candidates.forEach((item) => { item.hidden = item !== details; item.open = item === details; });
    });
    tabs.appendChild(button);
    details.hidden = index !== 0;
    details.open = index === 0;
  });
  candidates[0].before(tabs);
}

function installDetailObservers() {
  for (const id of ["quoteDetailBody", "billingDetailBody", "logiDetailAdmin"]) {
    const container = q(`#${id}`);
    if (!container) continue;
    new MutationObserver(() => { container.dataset.v5Enhanced = "false"; enhanceDetail(container); }).observe(container, { childList: true, subtree: true });
    enhanceDetail(container);
  }
}

function refreshAllWorklists() {
  renderQuoteKpis();
  renderClientKpis();
  renderProductKpis();
  for (const id of state.pagers.keys()) applyPager(id);
}

function boot() {
  injectStyles();
  installSprite();
  installToastChannel();
  document.body.classList.add("v5-admin");
  setTimeout(async () => {
    await installNavigation();
    installPager("quotesBody");
    installPager("clientsBody");
    installPager("productsBody");
    installClientExport();
    installSavedViews();
    installDetailObservers();
    restoreHash();
    refreshAllWorklists();
    window.addEventListener("hashchange", restoreHash);
    window.addEventListener("popstate", restoreHash);
  }, 80);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
