import { fetchJson, postJson, putJson, money, STOCK_LABEL } from "/assets/api.js";

// ============================================================================
// Catálogo Distribuidor (cliente). Rediseño: carga todos los productos una vez
// y filtra/ordena en el cliente (marcas, categorías, disponibilidad, precio,
// búsqueda), con favoritos persistentes, productos frecuentes y vistas
// grilla/lista. El flujo de solicitud (pre-cotización -> revisión admin) NO
// cambia: se sigue enviando { productId, quantity } a POST /api/quotes.
// ============================================================================

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function norm(s) {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// --- Validación de documento (UX; el server valida de forma autoritativa) ---
function isValidCuit(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length !== 11) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * w[i];
  let c = 11 - (sum % 11);
  if (c === 11) c = 0;
  if (c === 10) return false;
  return c === Number(d[10]);
}
function isValidTaxId(type, raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (type === "DNI") return d.length >= 7 && d.length <= 8;
  return isValidCuit(d);
}
function allowedTaxIdTypes(condition) {
  return condition === "consumidor_final" ? ["DNI", "CUIL", "CUIT"] : ["CUIT"];
}
function defaultTaxIdType(condition) {
  return condition === "consumidor_final" ? "DNI" : "CUIT";
}

const BRAND_COLORS = ["#c8102e", "#1f6feb", "#0f766e", "#7c3aed", "#b45309", "#334155", "#0369a1", "#be123c", "#4d7c0f", "#9333ea", "#0891b2", "#444444"];
function brandColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return BRAND_COLORS[hash % BRAND_COLORS.length];
}

// ---------------------------------------------------------------- estado ----
const state = {
  products: [],
  brands: [],
  categories: [],
  favorites: new Set(),
  frequentIds: [],
  filters: { brands: new Set(), categories: new Set(), availability: new Set(), priceMin: null, priceMax: null },
  quick: "all",
  search: "",
  sort: "default",
  view: "grid",
  catExpanded: false,
  compare: new Set()
};
const cart = new Map(); // productId -> { product, quantity }
const CAT_INITIAL = 8;

// ------------------------------------------------------------- precios ------
function tierForQuantity(qty) {
  if (qty >= 8) return "eight";
  if (qty >= 4) return "four";
  return "one";
}
function priceFor(product, tier) {
  return product.prices?.[tier] || product.prices?.pvp || { state: "hidden", amount: null };
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function pvpAmount(product) {
  const p = product.prices?.pvp;
  return p && p.state === "value" && p.amount != null ? Number(p.amount) : null;
}
function hasAnyWholesale(product) {
  return ["one", "four", "eight"].some((t) => {
    const x = product.prices?.[t];
    return x && x.state === "value" && x.amount != null;
  });
}
// Espeja src/pricing.js: precio del tier, o 15% off PVP si no hay mayorista, o
// "consultar" si pidió más de lo estipulado / no hay precio.
function resolveDisplay(product, tier) {
  const e = product.prices?.[tier];
  if (e && e.state === "value" && e.amount != null) return { state: "value", amount: Number(e.amount), currency: "ARS" };
  if (!hasAnyWholesale(product)) {
    const pvp = pvpAmount(product);
    if (pvp != null && pvp > 0) return { state: "value", amount: round2(pvp * 0.85), currency: "ARS" };
    return { state: "consult", amount: null };
  }
  return { state: "consult", amount: null };
}
function estText(product, qty) {
  const r = resolveDisplay(product, tierForQuantity(qty));
  return r.state === "value" ? money(r.amount) : "Consultar";
}
// Precio "de referencia" (1u) para filtrar/ordenar por precio.
function refPrice(product) {
  const r = resolveDisplay(product, "one");
  return r.state === "value" ? r.amount : null;
}
function priceCell(price) {
  if (!price || price.state === "hidden") return '<span style="color:#ccc;font-weight:400">-</span>';
  if (price.state === "consult") return '<span style="color:#888;font-weight:400">Consultar</span>';
  if (price.state === "custom") return price.label || "-";
  if (price.state === "unavailable") return '<span style="color:#ccc;font-weight:400">N/D</span>';
  return money(price.amount, price.currency);
}
function pubLink(url, inner, cls) {
  if (!url) return inner;
  const safe = String(url).replace(/"/g, "%22");
  return `<a class="${cls}" href="${safe}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

// ------------------------------------------------------------ watermark -----
function renderWatermark(user) {
  const el = document.getElementById("wmOverlay");
  if (!el) return;
  const who = user.company_name || user.display_name || user.email || "";
  const day = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const tag = `CONFIDENCIAL · ${who} · ${user.client_code || ""} · ${user.email || ""} · ${day}`;
  const safe = tag.replace(/[<>&]/g, "");
  const line = `<div class="wm-line">${(safe + "    ").repeat(3)}</div>`;
  el.innerHTML = line.repeat(16);
}

// ------------------------------------------------------------- toast --------
let toastTimer;
function toast(msg, isError) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 2200);
}

// -------------------------------------------------------------- carga -------
let currentUser = null;
async function loadMe() {
  const { user } = await fetchJson("/api/me");
  if (!user) return (location.href = "/login");
  currentUser = user;
  const initials = (user.display_name || user.email).slice(0, 2).toUpperCase();
  document.getElementById("avatar").textContent = initials;
  document.getElementById("ppName").textContent = user.display_name || user.email;
  document.getElementById("ppEmail").textContent = user.email;
  renderWatermark(user);
}

async function loadCatalogData() {
  const [{ brands }, { categories }, { products }, favRes, freqRes] = await Promise.all([
    fetchJson("/api/catalog/brands"),
    fetchJson("/api/catalog/categories"),
    fetchJson("/api/catalog/products"),
    fetchJson("/api/catalog/favorites").catch(() => ({ productIds: [] })),
    fetchJson("/api/catalog/frequent").catch(() => ({ productIds: [] }))
  ]);
  state.brands = brands;
  state.categories = categories;
  state.products = products;
  state.favorites = new Set(favRes.productIds || []);
  state.frequentIds = freqRes.productIds || [];
}

// ----------------------------------------------------------- estadísticas ---
function availCount() {
  return state.products.filter((p) => p.stockStatus !== "out_of_stock").length;
}
function renderStats() {
  document.getElementById("statProducts").textContent = state.products.length;
  document.getElementById("statBrands").textContent = state.brands.length;
  document.getElementById("statAvail").textContent = availCount();
  document.getElementById("qaAll").textContent = state.products.length;
  document.getElementById("qaAvail").textContent = availCount();
  document.getElementById("qaFav").textContent = state.favorites.size;
  document.getElementById("qaFreq").textContent = state.frequentIds.length || "—";
}

// ------------------------------------------------------- tarjetas de marca --
function renderBrandCards() {
  const el = document.getElementById("brandCards");
  el.innerHTML = state.brands
    .map((b) => {
      const icon = b.logoUrl
        ? `<div class="bc-icon logo"><img src="${String(b.logoUrl).replace(/"/g, "%22")}" alt="${esc(b.brand)}"></div>`
        : `<div class="bc-icon" style="background:${brandColor(b.brand)}">${esc(b.brand.slice(0, 4))}</div>`;
      return `<div class="brand-card" data-brand="${esc(b.brand)}">
        <div class="bc-top">${icon}<div class="bc-name">${esc(b.brand)}</div></div>
        <div class="bc-cnt">${b.count}<span>productos</span></div>
        <button class="bc-btn" data-brand="${esc(b.brand)}">Ver productos</button>
      </div>`;
    })
    .join("");
  el.querySelectorAll(".bc-icon.logo img").forEach((img) => {
    img.addEventListener("error", () => {
      const icon = img.parentElement;
      const brand = icon.closest(".brand-card")?.dataset.brand || "";
      icon.classList.remove("logo");
      icon.style.background = brandColor(brand);
      icon.textContent = brand.slice(0, 4);
    });
  });
}

// ---------------------------------------------------------------- filtros ---
function renderBrandFilter() {
  document.getElementById("brandFilterList").innerHTML = state.brands
    .map(
      (b) => `<label class="fg-check"><input type="checkbox" data-brand="${esc(b.brand)}"${state.filters.brands.has(b.brand) ? " checked" : ""}> <span>${esc(b.brand)}</span> <span class="n">${b.count}</span></label>`
    )
    .join("");
}
function renderCategoryFilter() {
  const q = norm(document.getElementById("catSearchInput").value);
  // Respeta el orden que viene del servidor (orden manual del admin, o por
  // cantidad de productos por defecto). No re-ordenar acá.
  let cats = state.categories.slice();
  if (q) cats = cats.filter((c) => norm(c.category).includes(q));
  const showAll = state.catExpanded || !!q;
  const shown = showAll ? cats : cats.slice(0, CAT_INITIAL);
  document.getElementById("catFilterList").innerHTML =
    shown
      .map(
        (c) => `<label class="fg-check"><input type="checkbox" data-cat="${esc(c.category)}"${state.filters.categories.has(c.category) ? " checked" : ""}> <span>${esc(c.category)}</span> <span class="n">${c.count}</span></label>`
      )
      .join("") || '<div class="fg-empty">Sin categorías.</div>';
  const moreBtn = document.getElementById("catMoreBtn");
  if (!q && cats.length > CAT_INITIAL) {
    moreBtn.hidden = false;
    moreBtn.textContent = state.catExpanded ? "Ver menos" : `Ver más (${cats.length - CAT_INITIAL})`;
  } else {
    moreBtn.hidden = true;
  }
}
function renderAvailCounts() {
  const c = { in_stock: 0, low_stock: 0, out_of_stock: 0 };
  for (const p of state.products) c[p.stockStatus] = (c[p.stockStatus] || 0) + 1;
  document.getElementById("cnt_in_stock").textContent = c.in_stock;
  document.getElementById("cnt_low_stock").textContent = c.low_stock;
  document.getElementById("cnt_out_of_stock").textContent = c.out_of_stock;
  document.querySelectorAll('#availFilterList input[type=checkbox]').forEach((chk) => {
    chk.checked = state.filters.availability.has(chk.value);
  });
}

const QUICK_LABEL = { avail: "Con disponibilidad", novedades: "Novedades", favoritos: "Favoritos", frecuentes: "Pedidos frecuentes" };
function renderActiveChips() {
  const chips = [];
  if (state.quick && state.quick !== "all") chips.push({ type: "quick", label: QUICK_LABEL[state.quick] || state.quick });
  for (const b of state.filters.brands) chips.push({ type: "brand", value: b, label: b });
  for (const c of state.filters.categories) chips.push({ type: "category", value: c, label: c });
  for (const a of state.filters.availability) chips.push({ type: "availability", value: a, label: STOCK_LABEL[a] || a });
  if (state.filters.priceMin != null) chips.push({ type: "priceMin", label: `Desde ${money(state.filters.priceMin)}` });
  if (state.filters.priceMax != null) chips.push({ type: "priceMax", label: `Hasta ${money(state.filters.priceMax)}` });
  if (state.search) chips.push({ type: "search", label: `“${state.search}”` });
  const el = document.getElementById("activeChips");
  el.innerHTML = chips
    .map((c) => `<button class="chip" data-chip="${c.type}" data-val="${esc(c.value || "")}">${esc(c.label)} <span aria-hidden="true">×</span></button>`)
    .join("");
}

// --------------------------------------------------------- filtrar/ordenar --
function computeFiltered() {
  let list = state.products;
  if (state.quick === "favoritos") list = list.filter((p) => state.favorites.has(p.id));
  else if (state.quick === "frecuentes") list = list.filter((p) => state.frequentIds.includes(p.id));
  else if (state.quick === "avail") list = list.filter((p) => p.stockStatus !== "out_of_stock");

  const f = state.filters;
  if (f.brands.size) list = list.filter((p) => f.brands.has(p.brand));
  if (f.categories.size) list = list.filter((p) => f.categories.has(p.category));
  if (f.availability.size) list = list.filter((p) => f.availability.has(p.stockStatus));
  if (f.priceMin != null) list = list.filter((p) => { const v = refPrice(p); return v != null && v >= f.priceMin; });
  if (f.priceMax != null) list = list.filter((p) => { const v = refPrice(p); return v != null && v <= f.priceMax; });
  if (state.search) {
    const q = norm(state.search);
    list = list.filter((p) => norm(p.name).includes(q) || norm(p.sku).includes(q) || norm(p.brand).includes(q) || norm(p.category).includes(q));
  }

  let sort = state.sort;
  if (state.quick === "novedades" && sort === "default") sort = "new";
  list = list.slice();
  if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "es"));
  else if (sort === "new") list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  else if (sort === "price_asc" || sort === "price_desc") {
    list.sort((a, b) => {
      const pa = refPrice(a), pb = refPrice(b);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return sort === "price_asc" ? pa - pb : pb - pa;
    });
  } else if (state.quick === "frecuentes") {
    const order = new Map(state.frequentIds.map((id, i) => [id, i]));
    list.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  }
  return list;
}

// ---------------------------------------------------- descarga PDF filtrada --
function hasActiveFilters() {
  const f = state.filters;
  return !!(state.search || (state.quick && state.quick !== "all") ||
    f.brands.size || f.categories.size || f.availability.size ||
    f.priceMin != null || f.priceMax != null);
}
function filterSummaryText() {
  const parts = [];
  if (state.quick && state.quick !== "all") parts.push(QUICK_LABEL[state.quick] || state.quick);
  if (state.filters.brands.size) parts.push("Marca: " + [...state.filters.brands].join(", "));
  if (state.filters.categories.size) parts.push("Categoría: " + [...state.filters.categories].join(", "));
  if (state.filters.availability.size) parts.push([...state.filters.availability].map((a) => STOCK_LABEL[a] || a).join(", "));
  if (state.filters.priceMin != null) parts.push("Desde " + money(state.filters.priceMin));
  if (state.filters.priceMax != null) parts.push("Hasta " + money(state.filters.priceMax));
  if (state.search) parts.push(`“${state.search}”`);
  return parts.join(" · ");
}
// El botón arma la descarga desde lo que el cliente ve: con filtros activos manda
// los SKU visibles (?skus=...) para que el PDF -con marca de agua- respete
// marca/categoría/disponibilidad/precio/favoritos/frecuentes/búsqueda; sin filtros
// baja el catálogo completo. CSP-safe: solo setea href/texto, sin JS inline.
function updateDownloadBtn(list) {
  const a = document.getElementById("downloadCatalogBtn");
  if (!a) return;
  const label = a.querySelector(".dl-label");
  const narrowed = hasActiveFilters() && list.length > 0 && list.length < state.products.length;
  if (narrowed) {
    const skus = list.map((p) => p.sku).filter(Boolean).join(",");
    const params = new URLSearchParams({ skus });
    const resumen = filterSummaryText();
    if (resumen) params.set("resumen", resumen);
    a.href = "/api/catalog/pdf?" + params.toString();
    if (label) label.textContent = `Descargar filtrado (${list.length})`;
  } else {
    a.href = "/api/catalog/pdf";
    if (label) label.textContent = "Descargar catálogo (PDF)";
  }
}

// ------------------------------------------------------------- productos ----
function heartIco(on) { return on ? "&#9829;" : "&#9825;"; }

function productCardHtml(p) {
  const cartEntry = cart.get(p.id);
  const qty = cartEntry ? cartEntry.quantity : 1;
  const isFav = state.favorites.has(p.id);
  const pvp = priceFor(p, "pvp");
  const one = resolveDisplay(p, "one");
  const four = resolveDisplay(p, "four");
  const eight = resolveDisplay(p, "eight");
  const comparing = state.compare.has(p.id);
  return `<div class="pcard" data-id="${p.id}">
    <div class="img-wrap">
      <div class="cat-chip">${esc(p.category)}</div>
      <button class="fav-btn${isFav ? " on" : ""}" data-fav aria-label="${isFav ? "Quitar de favoritos" : "Agregar a favoritos"}" aria-pressed="${isFav}">${heartIco(isFav)}</button>
      ${p.imageUrl ? pubLink(p.publicationUrl, `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy">`, "imglink") : '<div class="img-ph"></div>'}
    </div>
    <div class="body">
      <div class="pbrand">${esc(p.brand)}</div>
      <div class="pname">${pubLink(p.publicationUrl, `${esc(p.name)}${p.publicationUrl ? ' <span class="ext" aria-hidden="true">↗</span>' : ""}`, "plink")}</div>
      <div class="psku">${esc(p.sku)}</div>
      <span class="stock-pill ${p.stockStatus}"><span class="sp-dot" aria-hidden="true"></span>${STOCK_LABEL[p.stockStatus]}</span>
      ${p.note ? `<div class="pnote">${esc(p.note)}</div>` : ""}
      <div class="price-table">
        <div class="price-row pvp"><span class="pl">PVP</span><span class="pv tabular">${priceCell(pvp)}</span></div>
        <div class="price-row"><span class="pl">1u</span><span class="pv tabular">${priceCell(one)}</span></div>
        <div class="price-row"><span class="pl">4u</span><span class="pv tabular">${priceCell(four)}</span></div>
        <div class="price-row"><span class="pl">8u</span><span class="pv tabular">${priceCell(eight)}</span></div>
      </div>
      <div class="price-disclaimer">Precio y cantidad sujetos a confirmación.</div>
      <button class="compare-toggle${comparing ? " active" : ""}" type="button" data-compare aria-pressed="${comparing}">
        ${comparing ? "✓ Seleccionado para comparar" : "Comparar"}
      </button>
      <div class="qty-row">
        <div class="qty-stepper"><button class="qminus" type="button" aria-label="Menos">&minus;</button><input class="qval" value="${qty}" inputmode="numeric" pattern="[0-9]*" aria-label="Cantidad"><button class="qplus" type="button" aria-label="Más">+</button></div>
        <div class="est-price">Estimado<b class="tabular estval">${estText(p, qty)}</b></div>
      </div>
      <button class="add-btn${cartEntry ? " added" : ""}">${cartEntry ? `Agregado ✓ (${qty})` : "Agregar a solicitud"}</button>
    </div>
  </div>`;
}

function renderProducts() {
  const list = computeFiltered();
  updateDownloadBtn(list);
  window.__products = new Map(state.products.map((p) => [p.id, p]));
  const grid = document.getElementById("productGrid");
  grid.className = "grid" + (state.view === "list" ? " list" : "");
  document.getElementById("resultCount").textContent = `${list.length} producto${list.length === 1 ? "" : "s"}`;
  document.getElementById("resultsTitle").textContent =
    state.quick && state.quick !== "all" ? (QUICK_LABEL[state.quick] || "Productos") : (state.filters.brands.size === 1 ? [...state.filters.brands][0] : "Todos los productos");

  if (!list.length) {
    let msg = "Sin resultados para este filtro.";
    if (state.quick === "favoritos" && !state.favorites.size) msg = "Todavía no marcaste favoritos. Tocá el corazón ♡ en cualquier producto para guardarlo acá.";
    else if (state.quick === "frecuentes" && !state.frequentIds.length) msg = "Todavía no tenés productos frecuentes. Marcá productos como favoritos o hacé tu primera solicitud para encontrarlos rápido.";
    grid.innerHTML = `<div class="grid-empty">${msg}</div>`;
    return;
  }
  grid.innerHTML = list.map(productCardHtml).join("");
}

// --------------------------------------------------------------- favoritos --
function updateFavBtn(btn, on) {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", on ? "Quitar de favoritos" : "Agregar a favoritos");
  btn.innerHTML = heartIco(on);
}
async function toggleFavorite(id, btn) {
  const wasFav = state.favorites.has(id);
  if (wasFav) state.favorites.delete(id);
  else state.favorites.add(id);
  updateFavBtn(btn, !wasFav);
  document.getElementById("qaFav").textContent = state.favorites.size;
  try {
    if (wasFav) await fetchJson(`/api/catalog/favorites/${id}`, { method: "DELETE" });
    else await postJson("/api/catalog/favorites", { productId: id });
    toast(wasFav ? "Producto eliminado de favoritos." : "Producto agregado a favoritos.");
    if (state.quick === "favoritos") renderProducts();
  } catch (error) {
    // revertir en caso de error (actualización optimista)
    if (wasFav) state.favorites.add(id);
    else state.favorites.delete(id);
    updateFavBtn(btn, wasFav);
    document.getElementById("qaFav").textContent = state.favorites.size;
    toast("No se pudo actualizar favoritos.", true);
  }
}

// ------------------------------------------------------------- solicitud ----
function cartEstimateTotal() {
  let total = 0;
  for (const { product, quantity } of cart.values()) {
    const price = resolveDisplay(product, tierForQuantity(quantity));
    if (price.state === "value") total += price.amount * quantity;
  }
  return total;
}
function renderCart() {
  const entries = [...cart.values()];
  const count = entries.reduce((sum, e) => sum + e.quantity, 0);
  document.getElementById("cartCount").textContent = count;
  const quick = document.getElementById("cartQuickBtn");
  const quickCount = document.getElementById("cartQuickCount");
  quick.hidden = !entries.length;
  quickCount.textContent = `${count} producto${count === 1 ? "" : "s"}`;
  const total = cartEstimateTotal();
  document.getElementById("cartEstLine").textContent = "Total estimado: " + money(total);
  const itemsEl = document.getElementById("cartItems");
  const footEl = document.getElementById("cartFoot");

  if (!entries.length) {
    itemsEl.innerHTML = '<div class="cart-empty">Todavía no agregaste productos.<br>Elegí cantidades desde el catálogo.</div>';
    footEl.style.display = "none";
    return;
  }
  itemsEl.innerHTML = entries
    .map(({ product, quantity }) => {
      const price = resolveDisplay(product, tierForQuantity(quantity));
      const isValue = price.state === "value";
      const sub = isValue ? price.amount * quantity : null;
      return `<div class="cart-item" data-id="${product.id}">
        <div class="ci-thumb">${product.imageUrl ? `<img src="${esc(product.imageUrl)}" alt="">` : ""}</div>
        <div class="info">
          <div class="name">${esc(product.name)}</div>
          <div class="ci-qty">
            <div class="qty-stepper mini"><button class="ci-minus" type="button" aria-label="Menos">&minus;</button><input class="ci-qval" value="${quantity}" inputmode="numeric" aria-label="Cantidad"><button class="ci-plus" type="button" aria-label="Más">+</button></div>
            <span class="ci-unit">${isValue ? money(price.amount) + " c/u" : "Consultar"}</span>
          </div>
          <div class="row"><span class="sub tabular">${isValue ? money(sub) : "Consultar"}</span><button class="remove-link">Quitar</button></div>
        </div>
      </div>`;
    })
    .join("");
  document.getElementById("cartTotal").textContent = money(total);
  footEl.style.display = "flex";
}

function renderCompareBar() {
  const bar = document.getElementById("compareBar");
  const count = state.compare.size;
  bar.hidden = count === 0;
  document.getElementById("compareCount").textContent = String(count);
  document.getElementById("compareOpen").disabled = count < 2;
}

function toggleCompare(id) {
  if (state.compare.has(id)) {
    state.compare.delete(id);
  } else {
    if (state.compare.size >= 3) {
      toast("Podés comparar hasta 3 productos.", true);
      return;
    }
    state.compare.add(id);
  }
  renderProducts();
  renderCompareBar();
}

function openCompare() {
  const selected = [...state.compare].map((id) => state.products.find((p) => p.id === id)).filter(Boolean);
  if (selected.length < 2) return;
  const cells = (render) => selected.map(render).join("");
  document.getElementById("compareBody").innerHTML = `<div class="compare-table-wrap"><table class="compare-table">
    <thead><tr><th>Característica</th>${cells((p) => `<th>${esc(p.name)}</th>`)}</tr></thead>
    <tbody>
      <tr><th>Imagen</th>${cells((p) => `<td>${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="">` : "Sin imagen"}</td>`)}</tr>
      <tr><th>Marca</th>${cells((p) => `<td>${esc(p.brand)}</td>`)}</tr>
      <tr><th>SKU</th>${cells((p) => `<td class="tabular">${esc(p.sku)}</td>`)}</tr>
      <tr><th>Disponibilidad</th>${cells((p) => `<td><span class="stock-pill ${p.stockStatus}">${STOCK_LABEL[p.stockStatus]}</span></td>`)}</tr>
      <tr><th>1 unidad</th>${cells((p) => `<td class="tabular"><b>${priceCell(resolveDisplay(p, "one"))}</b></td>`)}</tr>
      <tr><th>4 unidades</th>${cells((p) => `<td class="tabular"><b>${priceCell(resolveDisplay(p, "four"))}</b></td>`)}</tr>
      <tr><th>8 unidades</th>${cells((p) => `<td class="tabular"><b>${priceCell(resolveDisplay(p, "eight"))}</b></td>`)}</tr>
      <tr><th></th>${cells((p) => `<td><button class="btn-primary sm" data-compare-add="${p.id}">Agregar a solicitud</button></td>`)}</tr>
    </tbody>
  </table></div>`;
  document.getElementById("compareOverlay").hidden = false;
}
function setCartQty(id, qty) {
  const entry = cart.get(id);
  if (!entry) return;
  entry.quantity = Math.max(1, qty || 1);
  renderCart();
  // reflejar en la tarjeta si está visible
  const card = document.querySelector(`#productGrid .pcard[data-id="${id}"]`);
  if (card) {
    card.querySelector(".qval").value = entry.quantity;
    card.querySelector(".estval").textContent = estText(entry.product, entry.quantity);
    const btn = card.querySelector(".add-btn");
    btn.textContent = `Agregado ✓ (${entry.quantity})`;
  }
}

// --------------------------------------------------------- scroll a catálogo
function scrollToCatalog() {
  document.getElementById("catalogSection").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ============================ RENDER GENERAL ================================
function renderFiltersUI() {
  renderBrandFilter();
  renderCategoryFilter();
  renderAvailCounts();
}
function renderAll() {
  renderStats();
  renderBrandCards();
  renderFiltersUI();
  renderActiveChips();
  renderProducts();
}

// =============================== EVENTOS ===================================
function setQuick(q, scroll) {
  state.quick = q;
  renderActiveChips();
  renderProducts();
  if (scroll) scrollToCatalog();
}

// Accesos rápidos
document.getElementById("quickAccess").addEventListener("click", (e) => {
  const card = e.target.closest(".qa-card");
  if (!card) return;
  setQuick(card.dataset.quick === "all" ? "all" : card.dataset.quick, true);
});

// Tarjetas de marca
document.getElementById("brandCards").addEventListener("click", (e) => {
  const card = e.target.closest(".brand-card");
  if (!card) return;
  const brand = card.dataset.brand;
  state.quick = "all";
  state.filters.brands = new Set([brand]);
  renderFiltersUI();
  renderActiveChips();
  renderProducts();
  scrollToCatalog();
});

// Filtros: marca (live)
document.getElementById("brandFilterList").addEventListener("change", (e) => {
  const chk = e.target.closest("input[data-brand]");
  if (!chk) return;
  if (chk.checked) state.filters.brands.add(chk.dataset.brand);
  else state.filters.brands.delete(chk.dataset.brand);
  renderActiveChips();
  renderProducts();
});
// Filtros: categoría (live)
document.getElementById("catFilterList").addEventListener("change", (e) => {
  const chk = e.target.closest("input[data-cat]");
  if (!chk) return;
  if (chk.checked) state.filters.categories.add(chk.dataset.cat);
  else state.filters.categories.delete(chk.dataset.cat);
  renderActiveChips();
  renderProducts();
});
let catSearchTimer;
document.getElementById("catSearchInput").addEventListener("input", () => {
  clearTimeout(catSearchTimer);
  catSearchTimer = setTimeout(renderCategoryFilter, 150);
});
document.getElementById("catMoreBtn").addEventListener("click", () => {
  state.catExpanded = !state.catExpanded;
  renderCategoryFilter();
});
// Filtros: disponibilidad (live)
document.getElementById("availFilterList").addEventListener("change", (e) => {
  const chk = e.target.closest("input[type=checkbox]");
  if (!chk) return;
  if (chk.checked) state.filters.availability.add(chk.value);
  else state.filters.availability.delete(chk.value);
  renderActiveChips();
  renderProducts();
});
// Precio: se aplica con el botón (o Enter)
function applyPriceInputs() {
  const min = document.getElementById("priceMin").value.trim();
  const max = document.getElementById("priceMax").value.trim();
  state.filters.priceMin = min === "" ? null : Number(min);
  state.filters.priceMax = max === "" ? null : Number(max);
  if (state.filters.priceMin != null && !Number.isFinite(state.filters.priceMin)) state.filters.priceMin = null;
  if (state.filters.priceMax != null && !Number.isFinite(state.filters.priceMax)) state.filters.priceMax = null;
}
document.getElementById("applyFilters").addEventListener("click", () => {
  applyPriceInputs();
  renderActiveChips();
  renderProducts();
  closeFilters();
});
document.querySelectorAll("#priceMin, #priceMax").forEach((inp) =>
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("applyFilters").click(); })
);
document.getElementById("clearFilters").addEventListener("click", () => {
  state.filters = { brands: new Set(), categories: new Set(), availability: new Set(), priceMin: null, priceMax: null };
  state.quick = "all";
  state.search = "";
  document.getElementById("searchInput").value = "";
  document.getElementById("priceMin").value = "";
  document.getElementById("priceMax").value = "";
  document.getElementById("catSearchInput").value = "";
  state.catExpanded = false;
  renderFiltersUI();
  renderActiveChips();
  renderProducts();
});

// Chips de filtros activos: quitar individual
document.getElementById("activeChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const type = chip.dataset.chip;
  const val = chip.dataset.val;
  if (type === "quick") state.quick = "all";
  else if (type === "brand") state.filters.brands.delete(val);
  else if (type === "category") state.filters.categories.delete(val);
  else if (type === "availability") state.filters.availability.delete(val);
  else if (type === "priceMin") { state.filters.priceMin = null; document.getElementById("priceMin").value = ""; }
  else if (type === "priceMax") { state.filters.priceMax = null; document.getElementById("priceMax").value = ""; }
  else if (type === "search") { state.search = ""; document.getElementById("searchInput").value = ""; }
  renderFiltersUI();
  renderActiveChips();
  renderProducts();
});

// Orden
document.getElementById("sortSelect").addEventListener("change", (e) => {
  state.sort = e.target.value;
  renderProducts();
});
// Vista grilla/lista
function setView(v) {
  state.view = v;
  document.getElementById("viewGrid").classList.toggle("active", v === "grid");
  document.getElementById("viewGrid").setAttribute("aria-pressed", String(v === "grid"));
  document.getElementById("viewList").classList.toggle("active", v === "list");
  document.getElementById("viewList").setAttribute("aria-pressed", String(v === "list"));
  renderProducts();
}
document.getElementById("viewGrid").addEventListener("click", () => setView("grid"));
document.getElementById("viewList").addEventListener("click", () => setView("list"));

// Panel de filtros en móvil
function openFilters() {
  document.getElementById("filtersPanel").classList.add("open");
  document.getElementById("filtersOverlay").classList.add("open");
}
function closeFilters() {
  document.getElementById("filtersPanel").classList.remove("open");
  document.getElementById("filtersOverlay").classList.remove("open");
}
document.getElementById("filtersToggle").addEventListener("click", openFilters);
document.getElementById("filtersClose").addEventListener("click", closeFilters);
document.getElementById("filtersOverlay").addEventListener("click", closeFilters);

// Búsqueda principal
let searchTimer;
document.getElementById("searchInput").addEventListener("input", (e) => {
  state.search = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    renderActiveChips();
    renderProducts();
  }, 220);
});

// Navegación
document.getElementById("logoBtn").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
document.querySelector(".cat-nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".cn-link");
  if (!btn) return;
  document.querySelectorAll(".cn-link").forEach((b) => b.classList.remove("active"));
  const nav = btn.dataset.nav;
  if (nav === "catalogo") { btn.classList.add("active"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  else if (nav === "favoritos") { btn.classList.add("active"); setQuick("favoritos", true); }
  else if (nav === "solicitudes") openRequests("all");
  else if (nav === "cotizaciones") openRequests("quoted");
});

// Interacción con las tarjetas de producto
document.getElementById("productGrid").addEventListener("click", (e) => {
  const card = e.target.closest(".pcard");
  if (!card) return;
  const id = card.dataset.id;
  const favBtn = e.target.closest(".fav-btn");
  if (favBtn) { toggleFavorite(id, favBtn); return; }
  if (e.target.closest("[data-compare]")) { toggleCompare(id); return; }
  const product = window.__products.get(id);
  const qtyInput = card.querySelector(".qval");
  let qty = parseInt(qtyInput.value, 10) || 1;
  if (e.target.closest(".qminus")) qty = Math.max(1, qty - 1);
  else if (e.target.closest(".qplus")) qty = qty + 1;
  else if (e.target.closest(".add-btn")) {
    cart.set(id, { product, quantity: qty });
    renderCart();
    const btn = card.querySelector(".add-btn");
    btn.textContent = `Agregado ✓ (${qty})`;
    btn.classList.add("added");
    toast("Producto agregado a tu solicitud.");
    return;
  } else return;
  qtyInput.value = qty;
  card.querySelector(".estval").textContent = estText(product, qty);
  if (cart.has(id)) setCartQty(id, qty);
});
document.getElementById("productGrid").addEventListener("input", (e) => {
  const qtyInput = e.target.closest(".qval");
  if (!qtyInput) return;
  const digitsOnly = qtyInput.value.replace(/[^0-9]/g, "");
  if (digitsOnly !== qtyInput.value) qtyInput.value = digitsOnly;
  const card = qtyInput.closest(".pcard");
  const product = window.__products.get(card.dataset.id);
  const qty = parseInt(digitsOnly, 10) || 1;
  card.querySelector(".estval").textContent = estText(product, qty);
});
document.getElementById("productGrid").addEventListener("change", (e) => {
  const qtyInput = e.target.closest(".qval");
  if (!qtyInput) return;
  const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
  qtyInput.value = qty;
  const card = qtyInput.closest(".pcard");
  const product = window.__products.get(card.dataset.id);
  card.querySelector(".estval").textContent = estText(product, qty);
  if (cart.has(card.dataset.id)) setCartQty(card.dataset.id, qty);
});

// Drawer "Solicitud actual"
const cartDrawer = document.getElementById("cartDrawer");
const cartOverlay = document.getElementById("cartOverlay");
document.getElementById("cartBtn").addEventListener("click", () => {
  cartDrawer.classList.add("open");
  cartOverlay.classList.add("open");
});
function closeCart() {
  cartDrawer.classList.remove("open");
  cartOverlay.classList.remove("open");
}
document.getElementById("cartClose").addEventListener("click", closeCart);
cartOverlay.addEventListener("click", closeCart);
document.getElementById("cartItems").addEventListener("click", (e) => {
  const item = e.target.closest(".cart-item");
  if (!item) return;
  const id = item.dataset.id;
  const entry = cart.get(id);
  if (e.target.closest(".remove-link")) {
    cart.delete(id);
    renderCart();
    const card = document.querySelector(`#productGrid .pcard[data-id="${id}"]`);
    if (card) { const b = card.querySelector(".add-btn"); b.textContent = "Agregar a solicitud"; b.classList.remove("added"); }
    toast("Producto quitado de tu solicitud.");
    return;
  }
  if (!entry) return;
  if (e.target.closest(".ci-minus")) setCartQty(id, entry.quantity - 1);
  else if (e.target.closest(".ci-plus")) setCartQty(id, entry.quantity + 1);
});
document.getElementById("cartQuickBtn").addEventListener("click", () => document.getElementById("cartBtn").click());
document.getElementById("compareOpen").addEventListener("click", openCompare);
document.getElementById("compareClear").addEventListener("click", () => {
  state.compare.clear();
  renderCompareBar();
  renderProducts();
});
document.getElementById("compareClose").addEventListener("click", () => (document.getElementById("compareOverlay").hidden = true));
document.getElementById("compareOverlay").addEventListener("click", (e) => {
  if (e.target.id === "compareOverlay") e.currentTarget.hidden = true;
});
document.getElementById("compareBody").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-compare-add]");
  if (!btn) return;
  const product = state.products.find((p) => p.id === btn.dataset.compareAdd);
  if (!product) return;
  const current = cart.get(product.id);
  cart.set(product.id, { product, quantity: current?.quantity || 1 });
  renderCart();
  toast("Producto agregado a tu solicitud.");
});
document.getElementById("cartItems").addEventListener("change", (e) => {
  const inp = e.target.closest(".ci-qval");
  if (!inp) return;
  const id = e.target.closest(".cart-item").dataset.id;
  setCartQty(id, Math.max(1, parseInt(inp.value, 10) || 1));
});

document.getElementById("submitQuoteBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Enviando...";
  try {
    const items = [...cart.entries()].map(([productId, entry]) => ({ productId, quantity: entry.quantity }));
    const customerNotes = document.getElementById("cartNotes").value.trim() || undefined;
    const { quote } = await postJson("/api/quotes", { items, customerNotes });
    cart.clear();
    document.getElementById("cartCount").textContent = "0";
    document.getElementById("cartEstLine").textContent = "Total estimado: $ 0";
    document.getElementById("cartFoot").style.display = "none";
    document.getElementById("cartItems").innerHTML = `<div class="cart-success"><div class="ok-icon">&#10003;</div>
      <p><strong>Solicitud #${quote.requestNumber} enviada.</strong><br>Un administrador la va a revisar y te confirmará precios y disponibilidad.</p></div>`;
    renderProducts(); // limpia los "Agregado ✓" de las tarjetas
    toast(`Solicitud #${quote.requestNumber} enviada correctamente.`);
  } catch (error) {
    alert("No se pudo enviar la solicitud: " + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar solicitud de cotización";
  }
});

// ==================== Notificaciones ====================
const notifPanel = document.getElementById("notifPanel");
function fmtDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}
async function loadNotifications() {
  try {
    const { quotes } = await fetchJson("/api/quotes");
    const ready = quotes.filter((q) => q.quoted_at);
    const badge = document.getElementById("notifBadge");
    if (ready.length) { badge.hidden = false; badge.textContent = ready.length > 9 ? "9+" : String(ready.length); }
    else badge.hidden = true;
    if (!ready.length) {
      notifPanel.innerHTML = '<div class="np-empty">Sin novedades por ahora.<br>Te avisamos cuando tengas una cotización lista.</div>';
      return;
    }
    notifPanel.innerHTML =
      '<div class="np-head">Cotizaciones listas</div>' +
      ready
        .slice(0, 8)
        .map(
          (q) => `<button class="np-item" data-proforma="${q.id}">
            <span>Solicitud <b>#${q.request_number}</b> cotizada</span>
            <span class="np-date">${fmtDate(q.quoted_at)}${q.quoted_total != null ? " · " + money(q.quoted_total) : ""}</span>
          </button>`
        )
        .join("");
    notifPanel.querySelectorAll("[data-proforma]").forEach((b) =>
      b.addEventListener("click", () => window.open(`/api/quotes/${b.dataset.proforma}/proforma`, "_blank"))
    );
  } catch { /* no bloquear el catálogo */ }
}
function toggleNotif(open) {
  const willOpen = open ?? notifPanel.hidden;
  notifPanel.hidden = !willOpen;
  document.getElementById("notifBtn").setAttribute("aria-expanded", String(willOpen));
}
document.getElementById("notifBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleNotif(); toggleProfile(false); });

// ==================== Menú de perfil ====================
const profilePanel = document.getElementById("profilePanel");
function toggleProfile(open) {
  const willOpen = open ?? profilePanel.hidden;
  profilePanel.hidden = !willOpen;
  document.getElementById("avatar").setAttribute("aria-expanded", String(willOpen));
}
document.getElementById("avatar").addEventListener("click", (e) => { e.stopPropagation(); toggleProfile(); toggleNotif(false); });
document.addEventListener("click", (e) => {
  if (!e.target.closest(".notif-wrap")) toggleNotif(false);
  if (!e.target.closest(".profile-wrap")) toggleProfile(false);
});

// ==================== Mis datos (perfil fiscal + entrega) ====================
const profileState = { complete: false, profile: {} };
const profileOverlay = document.getElementById("profileOverlay");
const profileForm = document.getElementById("profileForm");

async function loadProfile() {
  try {
    const { profile, complete } = await fetchJson("/api/profile");
    profileState.profile = profile || {};
    profileState.complete = complete;
    const item = document.getElementById("myDataBtn");
    if (!complete) item.innerHTML = "&#128100; Completá tus datos";
    else item.innerHTML = "&#128100; Mis datos";
  } catch { /* no bloquear el catálogo si falla */ }
}
function syncTaxIdType(preferredType) {
  const condition = profileForm.tax_condition.value;
  const types = allowedTaxIdTypes(condition);
  const sel = profileForm.tax_id_type;
  const keep = types.includes(preferredType) ? preferredType : (types.includes(sel.value) ? sel.value : defaultTaxIdType(condition));
  sel.innerHTML = types.map((t) => `<option value="${t}"${t === keep ? " selected" : ""}>${t}</option>`).join("");
  sel.disabled = types.length === 1;
  const t = sel.value;
  document.getElementById("taxIdLabel").textContent = `${t} *`;
  profileForm.tax_cuit.placeholder = t === "DNI" ? "12345678" : "30-71610175-0";
}
function openProfileModal(message) {
  const p = profileState.profile || {};
  for (const field of ["company_name", "tax_cuit", "tax_condition", "ship_street", "ship_number", "ship_floor", "ship_apartment", "ship_postal_code", "ship_city", "ship_province", "ship_phone", "ship_notes"]) {
    if (profileForm[field]) profileForm[field].value = p[field] || "";
  }
  syncTaxIdType(p.tax_id_type);
  document.getElementById("profileMsg").textContent = message || "";
  document.getElementById("profileMsg").style.color = "var(--muted)";
  profileOverlay.hidden = false;
}
profileForm.tax_condition.addEventListener("change", () => syncTaxIdType());
profileForm.tax_id_type.addEventListener("change", () => syncTaxIdType(profileForm.tax_id_type.value));
function closeProfileModal() { profileOverlay.hidden = true; }
document.getElementById("myDataBtn").addEventListener("click", () => { toggleProfile(false); openProfileModal(""); });
document.getElementById("profileClose").addEventListener("click", closeProfileModal);
document.getElementById("profileCancel").addEventListener("click", closeProfileModal);
profileOverlay.addEventListener("click", (e) => { if (e.target === profileOverlay) closeProfileModal(); });
profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("profileMsg");
  const f = e.target;
  const profile = {};
  for (const field of ["company_name", "tax_cuit", "tax_id_type", "tax_condition", "ship_street", "ship_number", "ship_floor", "ship_apartment", "ship_postal_code", "ship_city", "ship_province", "ship_phone", "ship_notes"]) {
    profile[field] = f[field] ? f[field].value.trim() : "";
  }
  try {
    const r = await putJson("/api/profile", { profile });
    profileState.profile = r.profile;
    profileState.complete = r.complete;
    msg.style.color = "var(--success, #137333)";
    msg.textContent = "Datos guardados ✓";
    await loadProfile();
    setTimeout(closeProfileModal, 900);
  } catch (error) {
    msg.style.color = "var(--danger, #c8102e)";
    msg.textContent = "No se pudo guardar: " + (error.body?.detail || error.message);
  }
});

// ==================== Mis solicitudes / Mis cotizaciones ====================
const requestsOverlay = document.getElementById("requestsOverlay");
// Modelo simplificado de 5 estados (guía §11.2). Se mantienen las claves viejas
// mapeadas al mismo label para que la vista no se rompa si la DB aún no migró.
const REQ_STATUS_LABEL = {
  abierto: "Pedido abierto", cotizacion: "Cotización", enviada: "Cotización enviada", orden: "Orden de venta", despachado: "Despachado", cancelado: "Cancelado",
  submitted: "Cotización", reviewing: "Cotización", quoted: "Cotización enviada", accepted: "Orden de venta", rejected: "Cancelado", expired: "Cancelado", cancelled: "Cancelado"
};
const REQ_STATUS_HINT = {
  abierto: "Podés seguir agregando productos durante el mes", cotizacion: "Recibida, la está revisando un administrador", enviada: "Cotización enviada, esperando tu confirmación", orden: "Confirmada como compra", despachado: "Pedido despachado", cancelado: "Cancelada",
  submitted: "Recibida, la está revisando un administrador", reviewing: "En revisión por un administrador", quoted: "Cotización enviada, esperando tu confirmación", accepted: "Confirmada como compra", rejected: "Cancelada", expired: "Cancelada", cancelled: "Cancelada"
};
// Estados a partir de los cuales existe documento "enviado"/compra.
const REQ_SENT = new Set(["enviada", "orden", "despachado", "quoted", "accepted"]);
const REQ_COMPRA = new Set(["orden", "despachado", "accepted"]);

let finState = {};
async function accountBanner() {
  if (!finState.currentAccount) return "";
  try {
    const { balance } = await fetchJson("/api/account");
    const chip = (l, v, c) => `<span class="hs-chip"><b${c ? ` style="color:${c}"` : ""}>${money(v)}</b> ${l}</span>`;
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      ${chip("deuda", balance.debt, balance.debt > 0 ? "var(--brand-red)" : "")}
      ${chip("vencido", balance.overdue, balance.overdue > 0 ? "var(--brand-red)" : "")}
      ${chip("a vencer", balance.toDue)}
      ${chip("a favor", balance.inFavor, balance.inFavor > 0 ? "var(--success)" : "")}
      ${chip("eCheqs pend.", balance.pendingAccreditation)}
      <button class="btn-primary sm" id="stmtDownload">Estado de cuenta</button>
    </div>`;
  } catch { return ""; }
}

async function openRequests(mode) {
  requestsOverlay.hidden = false;
  const onlyQuoted = mode === "quoted";
  document.getElementById("requestsTitle").textContent = onlyQuoted ? "Mis cotizaciones" : "Mis solicitudes";
  const body = document.getElementById("requestsBody");
  body.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px">Cargando...</div>';
  try {
    const { quotes: all } = await fetchJson("/api/quotes");
    const quotes = onlyQuoted ? all.filter((q) => REQ_SENT.has(q.status) || q.quoted_at) : all;
    const banner = await accountBanner();
    if (!quotes.length) {
      body.innerHTML = banner + `<div style="text-align:center;color:var(--muted);padding:30px">${onlyQuoted ? "Todavía no tenés cotizaciones emitidas." : "Todavía no hiciste ninguna solicitud."}</div>`;
    } else {
      body.innerHTML = banner + `<div style="overflow-x:auto"><table class="req-table">
        <thead><tr><th>#</th><th>Fecha</th><th>Estado</th><th style="text-align:right">Total</th><th>Cotizada por</th><th></th></tr></thead>
        <tbody>${quotes
          .map(
            (q) => `<tr>
              <td><strong>#${q.request_number}</strong></td>
              <td>${fmtDate(q.submitted_at)}</td>
              <td><span class="req-badge ${q.status}">${REQ_STATUS_LABEL[q.status] || q.status}</span><div class="req-hint">${REQ_STATUS_HINT[q.status] || ""}</div></td>
              <td style="text-align:right" class="tabular">${q.quoted_total != null ? money(q.quoted_total) : "<span style='color:#999'>a confirmar</span>"}</td>
              <td>${q.quoted_by_name ? esc(q.quoted_by_name) : "<span style='color:#999'>pendiente</span>"}${q.quoted_at ? `<br><span style='color:#999;font-size:11px'>${fmtDate(q.quoted_at)}</span>` : ""}</td>
              <td style="white-space:nowrap"><button class="btn-primary sm" data-detail="${q.id}" data-num="${q.request_number}">Ver detalle</button> ${(q.quoted_at || REQ_SENT.has(q.status)) ? `<button class="link-btn" data-proforma="${q.id}">Documento</button> ` : ""}<button class="link-btn" data-repeat="${q.id}">Repetir</button></td>
            </tr>`
          )
          .join("")}</tbody></table></div>`;
    }
    body.querySelectorAll("[data-detail]").forEach((b) => b.addEventListener("click", () => {
      history.pushState(null, "", `#/pedido/${b.dataset.detail}`);
      openOrderFinance(b.dataset.detail, b.dataset.num, mode);
    }));
    body.querySelectorAll("[data-proforma]").forEach((b) => b.addEventListener("click", () => window.open(`/api/quotes/${b.dataset.proforma}/proforma`, "_blank")));
    body.querySelectorAll("[data-repeat]").forEach((b) => b.addEventListener("click", () => repeatRequest(b.dataset.repeat)));
    body.querySelectorAll("[data-fin]").forEach((b) => b.addEventListener("click", () => openOrderFinance(b.dataset.fin, b.dataset.num, mode)));
    const stmt = document.getElementById("stmtDownload");
    if (stmt) stmt.addEventListener("click", () => window.open("/api/account/statement", "_blank"));
  } catch (error) {
    body.innerHTML = `<div style="text-align:center;color:var(--danger,#c8102e);padding:30px">No se pudieron cargar: ${esc(error.message)}</div>`;
  }
}

async function repeatRequest(id) {
  try {
    const { items } = await fetchJson(`/api/quotes/${id}`);
    let added = 0;
    let unavailable = 0;
    for (const item of items || []) {
      if (!item.product_id || (item.line_type && item.line_type !== "product")) continue;
      const product = state.products.find((p) => p.id === item.product_id);
      if (!product) { unavailable += 1; continue; }
      cart.set(product.id, { product, quantity: Math.max(1, Number(item.quantity) || 1) });
      added += 1;
    }
    renderCart();
    renderProducts();
    closeRequests();
    document.getElementById("cartBtn").click();
    toast(`${added} producto${added === 1 ? "" : "s"} agregado${added === 1 ? "" : "s"}${unavailable ? ` · ${unavailable} ya no disponible${unavailable === 1 ? "" : "s"}` : ""}.`);
  } catch (error) {
    toast("No se pudo repetir la solicitud.", true);
  }
}

// Detalle financiero de un pedido para el cliente: facturas visibles + informar
// una transferencia (con comprobante opcional).
async function openOrderFinance(orderId, num, mode = "all") {
  const body = document.getElementById("requestsBody");
  requestsOverlay.hidden = false;
  body.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px">Cargando detalle...</div>';
  try {
    const [{ quote, items }, invoiceData, documentData] = await Promise.all([
      fetchJson(`/api/quotes/${orderId}`),
      fetchJson(`/api/orders/${orderId}/invoices`).catch(() => ({ invoices: [] })),
      fetchJson(`/api/documents?orderId=${orderId}`).catch(() => ({ documents: [] }))
    ]);
    num = num || quote.request_number;
    const productItems = (items || []).filter((i) => !i.line_type || i.line_type === "product");
    const itemHtml = productItems.length ? `<div style="overflow-x:auto"><table class="req-table"><thead><tr><th>Producto</th><th>Cantidad</th><th style="text-align:right">Precio</th><th style="text-align:right">Subtotal</th></tr></thead><tbody>${productItems.map((i) => {
      const unit = i.quoted_unit_price == null ? null : Number(i.quoted_unit_price);
      return `<tr><td><b>${esc(i.product_name_snapshot)}</b><br><small>${esc(i.sku_snapshot || "")}</small></td><td>${i.quantity}</td><td style="text-align:right">${unit == null ? "A cotizar" : money(unit)}</td><td style="text-align:right">${unit == null ? "—" : money(unit * Number(i.quantity))}</td></tr>`;
    }).join("")}</tbody></table></div>` : '<p style="color:var(--muted)">Todavía no hay productos.</p>';
    const invoices = invoiceData.invoices || [];
    const invHtml = invoices.length ? invoices.map((i) => {
      const insts = (i.installments || []).map((it) => `<div style="margin:4px 0 0 12px;color:var(--muted)">Cuota ${it.installment_number}: vence ${String(it.due_date).slice(0,10)} · ${money(it.amount)} · ${esc(it.display_status)}</div>`).join("");
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><b>Factura ${esc(i.invoice_type)}</b> ${esc(i.point_of_sale || "")}-${esc(i.invoice_number || "s/n")} · ${money(i.total_amount)}
        ${i.document_id ? `<button class="link-btn" data-doc="${i.document_id}">Ver archivo</button>` : ""}</div>${insts}`;
    }).join("") : '<p style="color:var(--muted)">Sin facturas cargadas todavía.</p>';
    const docs = documentData.documents || [];
    const docsHtml = docs.length ? docs.map((d) => `<button class="link-btn" data-doc="${d.id}">${esc(d.original_filename || d.document_type)}</button>`).join(" · ") : '<span style="color:var(--muted)">Sin documentos visibles.</span>';
    const canAccept = quote.status === "enviada" && (!quote.due_date || String(quote.due_date).slice(0,10) >= new Date().toISOString().slice(0,10));
    body.innerHTML = `
      <button class="link-btn" id="finBack" style="margin-bottom:12px">&larr; Volver a mis pedidos</button>
      <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap">
        <div><h3 style="margin:0">Pedido #${esc(num)}</h3><p style="margin:4px 0;color:var(--muted)">${REQ_STATUS_LABEL[quote.status] || esc(quote.status)} · ${REQ_STATUS_HINT[quote.status] || ""}</p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${quote.quoted_at ? `<button class="link-btn" id="detailProforma">Ver documento</button>` : ""}
          ${canAccept ? '<button class="btn-primary" id="acceptQuote">Aceptar cotización</button>' : ""}
        </div>
      </div>
      <h4 style="margin:18px 0 8px">Productos</h4>${itemHtml}
      <div style="text-align:right;margin:12px 0;font-size:18px"><b>Total: ${quote.quoted_total == null ? "A confirmar" : money(quote.quoted_total)}</b></div>
      <h4 style="margin:18px 0 8px">Facturas y vencimientos</h4>${invHtml}
      <h4 style="margin:18px 0 8px">Documentos</h4><div>${docsHtml}</div>
      <h4 style="margin:20px 0 8px">Informar una transferencia</h4>
      <p style="font-size:12px;color:var(--muted)">Adjuntá el comprobante. Administración verificará la acreditación antes de aplicarla.</p>
      <div class="form-grid">
        <label>Monto<input id="cInfAmount" type="number" min="0.01" step="0.01"></label>
        <label>Referencia bancaria<input id="cInfRef" placeholder="N° de operación"></label>
        <label>Nombre del pagador<input id="cInfPayer" value="${esc(window.currentUser?.display_name || "")}"></label>
        <label>CUIT/DNI del pagador<input id="cInfTax" placeholder="Opcional"></label>
        <label class="full">Comprobante<input id="cInfFile" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*"></label>
        <div class="full" style="display:flex;gap:10px;align-items:center"><button class="btn-primary" id="cInfBtn" type="button">Enviar comprobante</button><span id="cInfMsg" style="font-size:12px"></span></div>
      </div>`;
    document.getElementById("finBack").addEventListener("click", () => { history.pushState(null, "", "#/pedidos"); openRequests(mode); });
    document.getElementById("detailProforma")?.addEventListener("click", () => window.open(`/api/quotes/${orderId}/proforma`, "_blank"));
    document.getElementById("acceptQuote")?.addEventListener("click", async () => {
      const button=document.getElementById("acceptQuote"); button.disabled=true; button.textContent="Confirmando...";
      try { await postJson(`/api/quotes/${orderId}/accept`, {}); toast("Cotización aceptada. Ya es una orden de venta."); await openOrderFinance(orderId,num,mode); }
      catch(e) { button.disabled=false; button.textContent="Aceptar cotización"; toast(e.body?.error || e.message,true); }
    });
    body.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => window.open(`/api/documents/${b.dataset.doc}/download`, "_blank")));
    document.getElementById("cInfBtn").addEventListener("click", async () => {
      const msg=document.getElementById("cInfMsg"), amount=Number(document.getElementById("cInfAmount").value);
      if(!Number.isFinite(amount)||amount<=0){msg.textContent="Ingresá un monto válido.";return;}
      const file=document.getElementById("cInfFile").files[0];
      if(!file){msg.textContent="Adjuntá el comprobante.";return;}
      msg.textContent="Subiendo...";
      try {
        const qs=new URLSearchParams({documentType:"comprobante_transferencia",orderId,filename:file.name});
        const upload=await fetch(`/api/documents?${qs}`,{method:"POST",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});
        const data=await upload.json().catch(()=>({}));
        if(!upload.ok) throw new Error(data.error||"No se pudo subir el archivo");
        await postJson(`/api/orders/${orderId}/payments/inform`,{
          amount,reference:document.getElementById("cInfRef").value.trim()||null,
          payerName:document.getElementById("cInfPayer").value.trim()||null,
          payerTaxId:document.getElementById("cInfTax").value.trim()||null,
          payerBankRef:document.getElementById("cInfRef").value.trim()||null,
          documentId:data.document?.id||null
        });
        msg.style.color="var(--success,#137333)";msg.textContent="Comprobante enviado correctamente.";
      } catch(e) {msg.style.color="var(--danger,#c8102e)";msg.textContent=e.body?.error||e.message;}
    });
  } catch (error) {
    body.innerHTML = `<p style="color:var(--danger,#c8102e)">No se pudo cargar el pedido: ${esc(error.message)}</p>`;
  }
}

function closeRequests() { requestsOverlay.hidden = true; }
document.getElementById("requestsClose").addEventListener("click", closeRequests);
requestsOverlay.addEventListener("click", (e) => { if (e.target === requestsOverlay) closeRequests(); });

window.addEventListener("client:open-order", (event) => {
  const id=event.detail;
  if(id) fetchJson(`/api/quotes/${id}`).then(({quote})=>openOrderFinance(id,quote.request_number,"all")).catch(()=>{});
});

// =============================== INIT ======================================
(async function init() {
  await loadMe();
  await loadCatalogData();
  renderAll();
  renderCart();
  loadProfile();
  loadNotifications();
  fetchJson("/api/finance/status").then((s) => { finState = s; }).catch(() => {});
})();