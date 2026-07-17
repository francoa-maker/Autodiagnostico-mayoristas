import { fetchJson, postJson, money, STOCK_LABEL } from "/assets/api.js";

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

async function loadMe() {
  const { user } = await fetchJson("/api/me");
  if (!user) return (location.href = "/login");
  const avatar = document.getElementById("avatar");
  avatar.textContent = (user.display_name || user.email).slice(0, 2).toUpperCase();
  document.getElementById("freshness").innerHTML = '<span class="dot"></span>Sesión: ' + user.email;
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
        const one = priceFor(p, "one");
        const four = priceFor(p, "four");
        const eight = priceFor(p, "eight");
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
              <div class="est-price">Estimado<b class="tabular estval">${money(priceFor(p, tierForQuantity(qty)).amount)}</b></div>
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
      const tier = tierForQuantity(quantity);
      const price = priceFor(product, tier);
      const sub = (price.amount || 0) * quantity;
      total += sub;
      return `<div class="cart-item" data-id="${product.id}">
        <div class="thumb"></div>
        <div class="info">
          <div class="name">${product.name}</div>
          <div class="tier">${quantity} u · ${money(price.amount, price.currency)} c/u</div>
          <div class="row"><span class="sub tabular">${money(sub)}</span><button class="remove-link">Quitar</button></div>
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
  card.querySelector(".estval").textContent = money(priceFor(product, tierForQuantity(qty)).amount);
});

document.getElementById("productGrid").addEventListener("input", (e) => {
  const qtyInput = e.target.closest(".qval");
  if (!qtyInput) return;
  const digitsOnly = qtyInput.value.replace(/[^0-9]/g, "");
  if (digitsOnly !== qtyInput.value) qtyInput.value = digitsOnly;

  const card = qtyInput.closest(".pcard");
  const product = window.__products.get(card.dataset.id);
  const qty = parseInt(digitsOnly, 10) || 1;
  card.querySelector(".estval").textContent = money(priceFor(product, tierForQuantity(qty)).amount);
});

document.getElementById("productGrid").addEventListener("change", (e) => {
  const qtyInput = e.target.closest(".qval");
  if (!qtyInput) return;
  const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
  qtyInput.value = qty;

  const card = qtyInput.closest(".pcard");
  const product = window.__products.get(card.dataset.id);
  card.querySelector(".estval").textContent = money(priceFor(product, tierForQuantity(qty)).amount);
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

(async function init() {
  await loadMe();
  await loadBrands();
  await loadCategories();
})();
