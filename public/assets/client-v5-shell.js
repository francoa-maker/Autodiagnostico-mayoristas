import { fetchJson, money } from "./api.js";

const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
const routes = new Set(["catalogo", "pedidos", "cuenta"]);
let currentRoute = "catalogo";

function injectStyles() {
  const files = ["tokens.css", "base.css", "components.css", "client-v5.css"];
  for (const file of files) {
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
    <symbol id="v5-i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></symbol>
    <symbol id="v5-i-orders" viewBox="0 0 24 24"><path d="M6 3h12l2 4v14H4V7z"/><path d="M4 7h16M8 11h8M8 15h6"/></symbol>
    <symbol id="v5-i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7"/></symbol>
    <symbol id="v5-i-cart" viewBox="0 0 24 24"><path d="M3 4h2l2 11h10l3-8H6"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/></symbol>
    <symbol id="v5-i-file" viewBox="0 0 24 24"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></symbol>
  </svg>`;
  document.body.prepend(host);
}

function icon(name) {
  return `<svg class="v5-icon" aria-hidden="true"><use href="#v5-i-${name}"></use></svg>`;
}

function installToastChannel() {
  if (q("#v5ToastStack")) return;
  const stack = document.createElement("div");
  stack.id = "v5ToastStack";
  stack.className = "v5-toast-stack";
  stack.setAttribute("aria-live", "polite");
  document.body.appendChild(stack);
  window.v5Toast = (message, type = "") => {
    const toast = document.createElement("div");
    toast.className = `v5-toast ${type}`.trim();
    toast.innerHTML = `<span aria-hidden="true">${type === "error" ? "!" : "✓"}</span><div>${String(message)}</div><button type="button" aria-label="Cerrar">×</button>`;
    toast.querySelector("button").addEventListener("click", () => toast.remove());
    stack.appendChild(toast);
    setTimeout(() => toast.remove(), 4800);
  };
  const nativeAlert = window.alert.bind(window);
  window.alert = (message) => {
    if (typeof window.v5Toast === "function") window.v5Toast(message);
    else nativeAlert(message);
  };
}

function installMainNavigation() {
  const nav = q(".cat-nav");
  if (!nav || q(".v5-client-nav", nav)) return;
  const shell = document.createElement("div");
  shell.className = "v5-client-nav";
  shell.innerHTML = `
    <button type="button" class="v5-route-btn" data-v5-route="catalogo">${icon("grid")}<span>Catálogo</span></button>
    <button type="button" class="v5-route-btn" data-v5-route="pedidos">${icon("orders")}<span>Mis pedidos</span></button>
    <button type="button" class="v5-route-btn" data-v5-route="cuenta">${icon("user")}<span>Mi cuenta</span></button>`;
  nav.prepend(shell);
  qa("[data-v5-route]", shell).forEach((button) => button.addEventListener("click", () => navigate(button.dataset.v5Route)));

  const cart = q("#cartBtn");
  if (cart) {
    cart.setAttribute("aria-label", "Abrir mi solicitud");
    const iconHolder = q(".rb-ico", cart);
    if (iconHolder) iconHolder.innerHTML = icon("cart");
  }
  q("#logoBtn")?.addEventListener("click", () => navigate("catalogo"));
}

function buildRoutePages() {
  const main = q(".cat-main-wrap");
  const catalog = q("#catalogPage");
  if (!main || !catalog || q("#clientOrdersPage")) return;
  catalog.classList.add("v5-page");

  const ordersPage = document.createElement("section");
  ordersPage.id = "clientOrdersPage";
  ordersPage.className = "v5-client-page v5-page";
  ordersPage.hidden = true;
  ordersPage.innerHTML = `<div class="v5-route-title"><div><h1>Mis pedidos</h1><p>Solicitudes, cotizaciones, compras, facturas y seguimiento en un único lugar.</p></div><a class="v5-btn" href="/api/catalog/pdf" target="_blank" rel="noopener">${icon("file")} Lista de precios</a></div>
    <div class="v5-orders-toolbar" role="group" aria-label="Filtrar pedidos">
      <button class="v5-order-filter is-active" type="button" data-v5-order-filter="all">Todos</button>
      <button class="v5-order-filter" type="button" data-v5-order-filter="cotizacion">Cotización</button>
      <button class="v5-order-filter" type="button" data-v5-order-filter="enviada">Enviada</button>
      <button class="v5-order-filter" type="button" data-v5-order-filter="orden">Orden</button>
      <button class="v5-order-filter" type="button" data-v5-order-filter="despachado">Despachado</button>
    </div>
    <div class="v5-order-stepper" aria-label="Estados del pedido"><span>Cotización</span><span>Enviada</span><span>Orden</span><span>Preparación</span><span>Despachado</span></div>`;

  const requestsModal = q("#requestsModal");
  if (requestsModal) ordersPage.appendChild(requestsModal);
  q("#requestsOverlay")?.classList.add("v5-detached");

  const accountPage = document.createElement("section");
  accountPage.id = "clientAccountPage";
  accountPage.className = "v5-client-page v5-page";
  accountPage.hidden = true;
  accountPage.innerHTML = `<div class="v5-route-title"><div><h1>Mi cuenta</h1><p>Cuenta corriente, movimientos, datos fiscales y dirección de entrega.</p></div></div>
    <div class="v5-tabs v5-account-tabs" role="tablist">
      <button class="v5-tab is-active" type="button" data-v5-account-tab="account">Cuenta corriente</button>
      <button class="v5-tab" type="button" data-v5-account-tab="profile">Mis datos</button>
    </div>
    <div class="v5-account-grid"></div>`;
  const accountGrid = q(".v5-account-grid", accountPage);
  const accountModal = q("#accountOverlay .account-modal");
  const profileModal = q("#profileModal");
  if (accountModal) {
    const panel = document.createElement("div");
    panel.className = "v5-account-panel";
    panel.dataset.v5AccountPanel = "account";
    panel.appendChild(accountModal);
    accountGrid.appendChild(panel);
  }
  if (profileModal) {
    const panel = document.createElement("div");
    panel.className = "v5-account-panel";
    panel.dataset.v5AccountPanel = "profile";
    panel.hidden = true;
    panel.appendChild(profileModal);
    accountGrid.appendChild(panel);
  }
  q("#accountOverlay")?.classList.add("v5-detached");
  q("#profileOverlay")?.classList.add("v5-detached");

  main.append(ordersPage, accountPage);

  qa("[data-v5-account-tab]", accountPage).forEach((button) => {
    button.addEventListener("click", () => activateAccountTab(button.dataset.v5AccountTab));
  });
  qa("[data-v5-order-filter]", ordersPage).forEach((button) => {
    button.addEventListener("click", () => {
      qa("[data-v5-order-filter]", ordersPage).forEach((item) => item.classList.toggle("is-active", item === button));
      filterOrders(button.dataset.v5OrderFilter);
    });
  });

  const requestsBody = q("#requestsBody");
  if (requestsBody) new MutationObserver(() => filterOrders(q(".v5-order-filter.is-active")?.dataset.v5OrderFilter || "all")).observe(requestsBody, { childList: true, subtree: true });
}

function activateAccountTab(tab) {
  qa("[data-v5-account-tab]").forEach((button) => button.classList.toggle("is-active", button.dataset.v5AccountTab === tab));
  qa("[data-v5-account-panel]").forEach((panel) => { panel.hidden = panel.dataset.v5AccountPanel !== tab; });
  if (tab === "profile") q("#myDataBtn")?.click();
  else q("#accountBtn")?.click();
}

function normalizeText(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function orderItems() {
  const body = q("#requestsBody");
  if (!body) return [];
  const preferred = qa(":scope > article, :scope > details, :scope > .request-card, :scope > .quote-card, :scope > .request-row", body);
  return preferred.length ? preferred : qa(":scope > *", body).filter((node) => !node.classList.contains("loading-row"));
}

function filterOrders(filter) {
  const aliases = {
    cotizacion: ["cotizacion", "solicitud"],
    enviada: ["enviada", "pre-compra", "precompra"],
    orden: ["orden", "compra"],
    despachado: ["despachado", "entregado", "envio"]
  };
  for (const item of orderItems()) {
    const text = normalizeText(item.textContent);
    const visible = filter === "all" || (aliases[filter] || [filter]).some((word) => text.includes(word));
    item.hidden = !visible;
  }
}

function triggerOrdersLoad() {
  const legacy = q('.cn-link[data-nav="solicitudes"]');
  legacy?.click();
  const overlay = q("#requestsOverlay");
  if (overlay) overlay.hidden = true;
}

function setRoute(route, { updateHash = true } = {}) {
  currentRoute = routes.has(route) ? route : "catalogo";
  q("#catalogPage").hidden = currentRoute !== "catalogo";
  q("#clientOrdersPage").hidden = currentRoute !== "pedidos";
  q("#clientAccountPage").hidden = currentRoute !== "cuenta";
  qa("[data-v5-route]").forEach((button) => button.classList.toggle("is-active", button.dataset.v5Route === currentRoute));
  if (currentRoute === "pedidos") triggerOrdersLoad();
  if (currentRoute === "cuenta") activateAccountTab(q("[data-v5-account-tab].is-active")?.dataset.v5AccountTab || "account");
  if (updateHash) history.pushState(null, "", `#/${currentRoute}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function navigate(route) {
  setRoute(route);
}

function routeFromHash() {
  return location.hash.replace(/^#\/?/, "").split("?")[0] || "catalogo";
}

async function enhanceIdentity() {
  try {
    const { user } = await fetchJson("/api/me");
    if (!user) return;
    const company = user.company_name || user.display_name || user.email || "Cliente";
    document.title = `${company} · Portal Autodiagnóstico`;
    const profileName = q("#ppName");
    if (profileName && profileName.textContent === "...") profileName.textContent = company;
  } catch { /* session handling remains in catalog.js */ }
}

function improveCartCopy() {
  const title = q(".cart-head h3");
  if (title) title.textContent = "Mi solicitud";
  const request = q("#cartBtn .rb-line1");
  if (request) request.childNodes[0].textContent = "Mi solicitud · ";
}

function boot() {
  injectStyles();
  installSprite();
  installToastChannel();
  document.body.classList.add("v5-client");
  installMainNavigation();
  buildRoutePages();
  improveCartCopy();
  enhanceIdentity();
  setRoute(routeFromHash(), { updateHash: false });
  window.addEventListener("hashchange", () => setRoute(routeFromHash(), { updateHash: false }));
  window.addEventListener("popstate", () => setRoute(routeFromHash(), { updateHash: false }));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
