import { fetchJson, postJson, putJson, money, STOCK_LABEL } from "/assets/api.js";

// Validación de formato de documento en el cliente (UX); el server valida de
// forma autoritativa en PUT /api/profile. El tipo depende de la condición:
// RI/Monotributo/Exento -> CUIT; Consumidor Final -> DNI/CUIL/CUIT.
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
  return isValidCuit(d); // CUIT y CUIL comparten algoritmo
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

const state = { brand: null, category: "ALL", search: "", brands: [], categories: [] };
const cart = new Map(); // productId -> { product, quantity }

function tierForQuantity(qty) {
  if (qty >= 8) return "eight";
  if (qty >= 4) return "four";
  return "one";
}

function priceFor(product, tier) {
  return product.prices?.[tier] || product.prices?.pvp || { state: "hidden", amount: null };
}

// Espeja src/pricing.js para la vista del catálogo: precio del tier, o 15% off
// PVP si no hay mayorista, o "consultar" si pidió más de lo estipulado.
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

function renderWatermark(user) {
  const el = document.getElementById("wmOverlay");
  if (!el) return;
  const who = user.company_name || user.display_name || user.email || "";
  const day = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const tag = `CONFIDENCIAL · ${who} · ${user.client_code || ""} · ${user.email || ""} · ${day}`;
  const safe = tag.replace(/[<>&]/g, "");
  const line = `<div class="wm-line">${(safe + "    ").repeat(3)}</div>`;
  el.innerHTML = line.repeat(16);
}

async function loadMe() {
  const { user } = await fetchJson("/api/me");
  if (!user) return (location.href = "/login");
  const avatar = document.getElementById("avatar");
  avatar.textContent = (user.display_name || user.email).slice(0, 2).toUpperCase();
  document.getElementById("freshness").innerHTML = '<span class="dot"></span>Sesión: ' + user.email;
  renderWatermark(user);
}

async function loadBrands() {
  const { brands } = await fetchJson("/api/catalog/brands");
  state.brands = brands;
  const total = brands.reduce((sum, b) => sum + Number(b.count), 0);
  document.getElementById("hubDesc").textContent = `${total} productos activos · ${brands.length} marcas`;

  document.getElementById("hubGrid").innerHTML = brands
    .map(
      (b) => `<div class="brand-card" data-brand="${b.brand}">
        <div class="bc-top"><div class="bc-icon" style="background:${brandColor(b.brand)}">${b.brand.slice(0, 4)}</div><div class="bc-name">${b.brand}</div></div>
        <div class="bc-cnt">${b.count}<span>productos</span></div>
      </div>`
    )
    .join("");

  document.getElementById("brandList").innerHTML =
    `<button class="cs-item${!state.brand ? " active" : ""}" data-brand="">Todas <span class="n">${total}</span></button>` +
    brands.map((b) => `<button class="cs-item${state.brand === b.brand ? " active" : ""}" data-brand="${b.brand}">${b.brand} <span class="n">${b.count}</span></button>`).join("");
}

async function loadCategories() {
  const qs = state.brand ? `?brand=${encodeURIComponent(state.brand)}` : "";
  const { categories } = await fetchJson(`/api/catalog/categories${qs}`);
  state.categories = categories;

  document.getElementById("catFilterList").innerHTML = categories
    .map((c) => `<button class="cs-item${state.category === c.category ? " active" : ""}" data-cat="${c.category}">${c.category} <span class="n">${c.count}</span></button>`)
    .join("");
  document.getElementById("catTabs").innerHTML =
    `<button class="tab-chip${state.category === "ALL" ? " active" : ""}" data-cat="ALL">Todas</button>` +
    categories.map((c) => `<button class="tab-chip${state.category === c.category ? " active" : ""}" data-cat="${c.category}">${c.category}</button>`).join("");
}

async function loadProducts() {
  const params = new URLSearchParams();
  if (state.brand) params.set("brand", state.brand);
  if (state.category && state.category !== "ALL") params.set("category", state.category);
  if (state.search) params.set("q", state.search);

  const { products } = await fetchJson(`/api/catalog/products?${params}`);
  document.getElementById("catalogTitle").textContent = state.brand || (state.search ? `Resultados para "${state.search}"` : "Todos");
  document.getElementById("resultCount").textContent = `${products.length} producto${products.length === 1 ? "" : "s"}`;

  const grid = document.getElementById("productGrid");
  grid.innerHTML =
    products
      .map((p) => {
        const cartEntry = cart.get(p.id);
        const qty = cartEntry ? cartEntry.quantity : 1;
        const pvp = priceFor(p, "pvp");
        const one = resolveDisplay(p, "one");
        const four = resolveDisplay(p, "four");
        const eight = resolveDisplay(p, "eight");
        return `<div class="pcard" data-id="${p.id}">
          <div class="img-wrap">
            <div class="cat-chip">${p.category}</div>
            ${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}" loading="lazy">` : '<div class="img-ph"></div>'}
          </div>
          <div class="body">
            <div class="pname">${p.name}</div>
            <div class="psku">${p.sku}</div>
            <span class="stock-pill ${p.stockStatus}">${STOCK_LABEL[p.stockStatus]}</span>
            ${p.note ? `<div class="pnote">${p.note}</div>` : ""}
            <div class="price-table">
              <div class="price-row pvp"><span class="pl">PVP</span><span class="pv tabular">${priceCell(pvp)}</span></div>
              <div class="price-row"><span class="pl">1u</span><span class="pv tabular">${priceCell(one)}</span></div>
              <div class="price-row"><span class="pl">4u</span><span class="pv tabular">${priceCell(four)}</span></div>
              <div class="price-row"><span class="pl">8u</span><span class="pv tabular">${priceCell(eight)}</span></div>
            </div>
            <div class="qty-row">
              <div class="qty-stepper"><button class="qminus" type="button">&minus;</button><input class="qval" value="${qty}" inputmode="numeric" pattern="[0-9]*"><button class="qplus" type="button">+</button></div>
              <div class="est-price">Estimado<b class="tabular estval">${estText(p, qty)}</b></div>
            </div>
            <button class="add-btn${cartEntry ? " added" : ""}">${cartEntry ? `Agregado ✓ (${qty})` : "Agregar al pedido"}</button>
          </div>
        </div>`;
      })
      .join("") || '<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted)">Sin resultados para este filtro.</div>';

  window.__products = new Map(products.map((p) => [p.id, p]));
}

function priceCell(price) {
  if (!price || price.state === "hidden") return '<span style="color:#ccc;font-weight:400">-</span>';
  if (price.state === "consult") return '<span style="color:#888;font-weight:400">Consultar</span>';
  if (price.state === "custom") return price.label || "-";
  if (price.state === "unavailable") return '<span style="color:#ccc;font-weight:400">N/D</span>';
  return money(price.amount, price.currency);
}

function renderCart() {
  const entries = [...cart.values()];
  document.getElementById("cartCount").textContent = entries.reduce((sum, e) => sum + e.quantity, 0);
  const itemsEl = document.getElementById("cartItems");
  const footEl = document.getElementById("cartFoot");

  if (!entries.length) {
    itemsEl.innerHTML = '<div class="cart-empty">Todavía no agregaste productos.<br>Elegí cantidades desde el catálogo.</div>';
    footEl.style.display = "none";
    return;
  }

  let total = 0;
  itemsEl.innerHTML = entries
    .map(({ product, quantity }) => {
      const price = resolveDisplay(product, tierForQuantity(quantity));
      const isValue = price.state === "value";
      const sub = isValue ? price.amount * quantity : null;
      if (isValue) total += sub;
      return `<div class="cart-item" data-id="${product.id}">
        <div class="thumb"></div>
        <div class="info">
          <div class="name">${product.name}</div>
          <div class="tier">${quantity} u · ${isValue ? money(price.amount) + " c/u" : "Consultar"}</div>
          <div class="row"><span class="sub tabular">${isValue ? money(sub) : "Consultar"}</span><button class="remove-link">Quitar</button></div>
        </div>
      </div>`;
    })
    .join("");
  footEl.style.display = "flex";
  document.getElementById("cartTotal").textContent = money(total);
}

function openCatalog() {
  document.getElementById("hubView").style.display = "none";
  document.getElementById("catalogView").style.display = "block";
}
function openHub() {
  document.getElementById("hubView").style.display = "block";
  document.getElementById("catalogView").style.display = "none";
}

async function selectBrand(brand) {
  state.brand = brand || null;
  state.category = "ALL";
  await loadCategories();
  await loadBrands(); // re-render active state in sidebar
  if (state.brand) {
    openCatalog();
    await loadProducts();
  } else {
    openHub();
  }
}

document.getElementById("logoBtn").addEventListener("click", () => selectBrand(null));
document.getElementById("hubGrid").addEventListener("click", (e) => {
  const card = e.target.closest(".brand-card");
  if (card) selectBrand(card.dataset.brand);
});
document.getElementById("brandList").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (btn) selectBrand(btn.dataset.brand || null);
});
document.getElementById("catFilterList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.category = btn.dataset.cat;
  await loadCategories();
  openCatalog();
  await loadProducts();
});
document.getElementById("catTabs").addEventListener("click", async (e) => {
  const btn = e.target.closest(".tab-chip");
  if (!btn) return;
  state.category = btn.dataset.cat;
  await loadCategories();
  await loadProducts();
});
document.getElementById("backBtn").addEventListener("click", () => selectBrand(null));

let searchTimer;
document.getElementById("searchInput").addEventListener("input", (e) => {
  state.search = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    if (state.search) {
      openCatalog();
      await loadProducts();
    } else if (state.brand) {
      await loadProducts();
    } else {
      openHub();
    }
  }, 250);
});

document.getElementById("productGrid").addEventListener("click", (e) => {
  const card = e.target.closest(".pcard");
  if (!card) return;
  const id = card.dataset.id;
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
    return;
  } else {
    return;
  }

  qtyInput.value = qty;
  card.querySelector(".estval").textContent = estText(product, qty);
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
});

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
  const btn = e.target.closest(".remove-link");
  if (!btn) return;
  const id = e.target.closest(".cart-item").dataset.id;
  cart.delete(id);
  renderCart();
});

document.getElementById("submitQuoteBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  // Con nombre + email alcanza para solicitar; los datos fiscales quedan
  // opcionales (se completan en "Mis datos" para la proforma/despacho).
  btn.disabled = true;
  btn.textContent = "Enviando...";
  try {
    const items = [...cart.entries()].map(([productId, entry]) => ({ productId, quantity: entry.quantity }));
    const { quote } = await postJson("/api/quotes", { items });
    cart.clear();
    document.getElementById("cartCount").textContent = "0";
    document.getElementById("cartFoot").style.display = "none";
    document.getElementById("cartItems").innerHTML = `<div class="cart-success"><div class="ok-icon">&#10003;</div>
      <p><strong>Solicitud #${quote.requestNumber} enviada.</strong><br>Te contactaremos para confirmar precios y disponibilidad.</p></div>`;
  } catch (error) {
    alert("No se pudo enviar la solicitud: " + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar solicitud de cotización";
  }
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
    // Aviso sutil en el botón si faltan datos.
    const btn = document.getElementById("myDataBtn");
    if (!complete) btn.textContent = "\u{1F464} Completá tus datos";
    else btn.innerHTML = "\u{1F464} Mis datos";
  } catch { /* no bloquear el catálogo si falla */ }
}

// Ajusta el selector de tipo de documento a la condición de IVA: para
// RI/Monotributo/Exento queda fijo en CUIT; para Consumidor Final ofrece
// DNI/CUIL/CUIT. Actualiza también la etiqueta y el placeholder.
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
function closeProfileModal() {
  profileOverlay.hidden = true;
}

document.getElementById("myDataBtn").addEventListener("click", () => openProfileModal(""));
document.getElementById("profileClose").addEventListener("click", closeProfileModal);
document.getElementById("profileCancel").addEventListener("click", closeProfileModal);
profileOverlay.addEventListener("click", (e) => { if (e.target === profileOverlay) closeProfileModal(); });

profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("profileMsg");
  const f = e.target;
  // Sin chequeo de formato del documento: se guarda tal cual.
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

// ==================== Mis solicitudes ====================

const requestsOverlay = document.getElementById("requestsOverlay");
const REQ_STATUS_LABEL = { submitted: "Enviada", reviewing: "En revisión", quoted: "Cotizada", accepted: "Aceptada", rejected: "Rechazada", expired: "Vencida", cancelled: "Cancelada" };

function fmtDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

async function openRequests() {
  requestsOverlay.hidden = false;
  const body = document.getElementById("requestsBody");
  body.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px">Cargando...</div>';
  try {
    const { quotes } = await fetchJson("/api/quotes");
    if (!quotes.length) {
      body.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px">Todavía no hiciste ninguna solicitud.</div>';
      return;
    }
    body.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th style="text-align:left;padding:8px;border-bottom:2px solid #1a1a1a">#</th>
        <th style="text-align:left;padding:8px;border-bottom:2px solid #1a1a1a">Fecha</th>
        <th style="text-align:left;padding:8px;border-bottom:2px solid #1a1a1a">Estado</th>
        <th style="text-align:right;padding:8px;border-bottom:2px solid #1a1a1a">Total</th>
        <th style="text-align:left;padding:8px;border-bottom:2px solid #1a1a1a">Cotizada por</th>
        <th style="padding:8px;border-bottom:2px solid #1a1a1a"></th>
      </tr></thead>
      <tbody>${quotes
        .map(
          (q) => `<tr>
            <td style="padding:8px;border-bottom:1px solid #eee"><strong>#${q.request_number}</strong></td>
            <td style="padding:8px;border-bottom:1px solid #eee">${fmtDate(q.submitted_at)}</td>
            <td style="padding:8px;border-bottom:1px solid #eee">${REQ_STATUS_LABEL[q.status] || q.status}</td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right" class="tabular">${q.quoted_total != null ? money(q.quoted_total) : "<span style='color:#999'>a confirmar</span>"}</td>
            <td style="padding:8px;border-bottom:1px solid #eee">${q.quoted_by_name ? q.quoted_by_name : "<span style='color:#999'>pendiente</span>"}${q.quoted_at ? `<br><span style='color:#999;font-size:11px'>${fmtDate(q.quoted_at)}</span>` : ""}</td>
            <td style="padding:8px;border-bottom:1px solid #eee">${q.quoted_at ? `<button class="btn-primary" data-proforma="${q.id}" style="padding:6px 12px;font-size:12px">Ver proforma</button>` : ""}</td>
          </tr>`
        )
        .join("")}</tbody></table></div>`;
    body.querySelectorAll("[data-proforma]").forEach((btn) => {
      btn.addEventListener("click", () => window.open(`/api/quotes/${btn.dataset.proforma}/proforma`, "_blank"));
    });
  } catch (error) {
    body.innerHTML = `<div style="text-align:center;color:var(--danger,#c8102e);padding:30px">No se pudieron cargar: ${error.message}</div>`;
  }
}
function closeRequests() { requestsOverlay.hidden = true; }

document.getElementById("myRequestsBtn").addEventListener("click", openRequests);
document.getElementById("requestsClose").addEventListener("click", closeRequests);
requestsOverlay.addEventListener("click", (e) => { if (e.target === requestsOverlay) closeRequests(); });

(async function init() {
  await loadMe();
  await loadProfile();
  await loadBrands();
  await loadCategories();
})();
