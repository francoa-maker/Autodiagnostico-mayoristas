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
}

// ==================== Dashboard ====================

function renderKpis({ totalProducts, withStock, withoutStock, pendingQuotes, pendingUsers }) {
  const items = [
    { label: "Productos del portal", value: totalProducts, icon: "&#128230;", bg: "var(--brand-red-soft)", fg: "var(--brand-red)" },
    { label: "Con stock", value: withStock, icon: "&#10003;", bg: "var(--success-soft)", fg: "var(--success)", sub: totalProducts ? `${Math.round((withStock / totalProducts) * 100)}% del total` : "" },
    { label: "Sin stock", value: withoutStock, icon: "&#9888;", bg: "var(--danger-soft)", fg: "var(--danger)" },
    { label: "Cotizaciones pendientes", value: pendingQuotes, icon: "&#128172;", bg: "var(--info-soft)", fg: "var(--info)" },
    { label: "Usuarios pendientes", value: pendingUsers, icon: "&#128100;", bg: "var(--warning-soft)", fg: "var(--warning)" }
  ];
  document.getElementById("kpiRow").innerHTML = items
    .map(
      (item) => `<div class="kpi-card">
        <div class="kpi-icon" style="background:${item.bg};color:${item.fg}">${item.icon}</div>
        <div><div class="kl">${item.label}</div><div class="kv tabular">${item.value}</div>${item.sub ? `<div class="ksub" style="color:${item.fg}">${item.sub}</div>` : ""}</div>
      </div>`
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
        (q) => `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f1f3;font-size:12.5px">
          <span><strong>#${q.request_number}</strong> · ${esc(q.display_name || q.email)}</span>
          <span class="tabular" style="color:var(--muted)">${money(q.quoted_total ?? q.displayed_subtotal)}</span>
        </div>`
      )
      .join("") || '<div class="empty-row">Todavía no hay cotizaciones.</div>';
  return quotes.filter((q) => normStatus(q.status) === "cotizacion" && !q.assigned_admin_id).length;
}

async function loadAudit() {
  const { entries } = await fetchJson("/api/admin/audit");
  const el = document.getElementById("auditFeed");
  el.innerHTML =
    entries
      .slice(0, 8)
      .map((entry) => {
        const info = auditInfo(entry.action);
        const entity = AUDIT_ENTITY_LABELS[entry.entity_type] || "Registro";
        const exactDate = entry.created_at ? new Date(entry.created_at).toLocaleString("es-AR") : "";
        return `<div class="audit-item">
          <span class="audit-icon" aria-hidden="true">${info.icon}</span>
          <span class="audit-copy">
            <strong>${esc(info.label)}</strong>
            <span>${esc(entity)} · por ${esc(auditActor(entry))}</span>
          </span>
          <time datetime="${esc(entry.created_at)}" title="${esc(exactDate)}">${timeAgo(entry.created_at)}</time>
        </div>`;
      })
      .join("") || '<div class="empty-row">Sin actividad reciente.</div>';
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

document.getElementById("adminNav").addEventListener("click", (e) => {
  const link = e.target.closest("a[data-section]");
  if (!link) return;
  document.querySelectorAll("#adminNav a").forEach((a) => a.classList.toggle("active", a === link));
  document.querySelectorAll(".admin-section").forEach((s) => (s.hidden = s.id !== `section-${link.dataset.section}`));
  const loader = sectionLoaders[link.dataset.section];
  if (loader && !loadedSections.has(link.dataset.section)) {
    loadedSections.add(link.dataset.section);
    loader();
  }
});

// ==================== Productos y precios ====================

const IVA_OPTIONS = [10.5, 21, 0, 27];
// attr es el atributo data completo, p.ej. 'data-field="iva"' (editor de
// productos) o 'data-f="ivaRate"' (filas del editor de cotización).
function ivaSelect(attr, value) {
  const v = Number(value);
  const opts = IVA_OPTIONS.map((r) => `<option value="${r}"${r === v ? " selected" : ""}>${r}%</option>`).join("");
  return `<select class="cell-input" ${attr} style="width:74px">${opts}</select>`;
}

function priceInputValue(price) {
  if (!price || price.state === "hidden") return "";
  if (price.state === "consult") return "consultar";
  if (price.state === "custom") return price.label || "";
  return String(price.amount ?? "");
}

// Vacío = oculto, "consultar" = Consultar, número = precio ARS,
// cualquier otro texto = etiqueta custom (se muestra tal cual).
function priceBodyFromInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { state: "hidden", amount: null };
  if (/^consultar$/i.test(text)) return { state: "consult", amount: null };
  const numeric = text.replace(/\./g, "").replace(",", ".");
  if (/^[\d.,]+$/.test(text) && !Number.isNaN(Number(numeric))) return { state: "value", amount: Number(numeric), currency: "ARS" };
  return { state: "custom", amount: null, label: text };
}

async function loadProducts() {
  const search = document.getElementById("productSearch").value.trim();
  const { products } = await fetchJson(`/api/admin/products${search ? `?search=${encodeURIComponent(search)}` : ""}`);
  const body = document.getElementById("productsBody");
  body.innerHTML =
    products
      .map(
        (p) => `<tr data-id="${p.id}">
          <td><input class="cell-input" data-field="order" type="number" value="${p.sort_order ?? ""}" style="width:56px"></td>
          <td style="font-family:var(--font-mono)">${esc(p.sku)}</td>
          <td>${esc(p.name)}</td>
          <td>${esc(p.brand)}</td>
          <td>${ivaSelect('data-field="iva"', p.iva_rate != null ? Number(p.iva_rate) : 10.5)}</td>
          <td><input class="cell-input" data-field="one" value="${esc(priceInputValue(p.prices.one))}" style="width:104px"></td>
          <td><input class="cell-input" data-field="four" value="${esc(priceInputValue(p.prices.four))}" style="width:104px"></td>
          <td><input class="cell-input" data-field="eight" value="${esc(priceInputValue(p.prices.eight))}" style="width:104px"></td>
          <td style="text-align:center">
            <button class="eye-btn ${p.visible ? "on" : "off"}" data-field="visible" data-visible="${p.visible}" title="${p.visible ? "Visible en el catálogo" : "Oculto"}">${p.visible ? "&#128065;" : "&#128584;"}</button>
          </td>
          <td style="display:flex;gap:6px">
            <button class="link-btn" data-action="save">Guardar</button>
            <button class="link-btn ghost" data-action="delete">Borrar</button>
          </td>
        </tr>`
      )
      .join("") || '<tr><td colspan="9" class="empty-row">Sin resultados.</td></tr>';
}

let productSearchTimer = null;
document.getElementById("productSearch").addEventListener("input", () => {
  clearTimeout(productSearchTimer);
  productSearchTimer = setTimeout(loadProducts, 350);
});

document.getElementById("productsBody").addEventListener("click", async (e) => {
  const eye = e.target.closest(".eye-btn");
  if (eye) {
    const on = eye.dataset.visible !== "true";
    eye.dataset.visible = String(on);
    eye.className = `eye-btn ${on ? "on" : "off"}`;
    eye.innerHTML = on ? "&#128065;" : "&#128584;";
    eye.title = on ? "Visible en el catálogo" : "Oculto";
    return;
  }
  const del = e.target.closest('button[data-action="delete"]');
  if (del) {
    const row = del.closest("tr");
    if (!confirm(`¿Borrar el producto ${row.children[1].textContent} del catálogo? (se puede recuperar re-creándolo con el mismo SKU)`)) return;
    del.disabled = true;
    try {
      await deleteJson(`/api/admin/products/${row.dataset.id}`);
      row.remove();
    } catch (error) {
      alert("No se pudo borrar: " + error.message);
      del.disabled = false;
    }
    return;
  }
  const save = e.target.closest('button[data-action="save"]');
  if (!save) return;
  const row = save.closest("tr");
  const id = row.dataset.id;
  const get = (field) => row.querySelector(`[data-field="${field}"]`);
  save.disabled = true;
  save.textContent = "Guardando...";
  try {
    await patchJson(`/api/admin/products/${id}`, {
      sortOrder: get("order").value === "" ? undefined : Number(get("order").value),
      visible: get("visible").dataset.visible === "true",
      ivaRate: Number(get("iva").value)
    });
    for (const tier of ["one", "four", "eight"]) {
      await putJson(`/api/admin/products/${id}/prices/${tier}`, priceBodyFromInput(get(tier).value));
    }
    save.textContent = "Guardado ✓";
    setTimeout(() => (save.textContent = "Guardar"), 1500);
  } catch (error) {
    alert("No se pudo guardar: " + error.message);
    save.textContent = "Guardar";
  } finally {
    save.disabled = false;
  }
});

document.getElementById("newProductBtn").addEventListener("click", () => {
  openModal(`
    <div class="modal-head"><h3>Nuevo producto</h3><button class="modal-x" data-close>&times;</button></div>
    <form id="newProductForm" class="form-grid">
      <label>SKU *<input name="sku" required></label>
      <label>Nombre *<input name="name" required></label>
      <label>Marca<input name="brand" placeholder="OTRAS MARCAS"></label>
      <label>Categoría<input name="category" placeholder="Sin categoría"></label>
      <label>IVA
        <select name="ivaRate">${IVA_OPTIONS.map((r) => `<option value="${r}"${r === 10.5 ? " selected" : ""}>${r}%</option>`).join("")}</select>
      </label>
      <label>Precio 1u<input name="one" placeholder="vacío = oculto"></label>
      <label>Precio 4u<input name="four"></label>
      <label>Precio 8u<input name="eight"></label>
      <label>Orden<input name="sortOrder" type="number" placeholder="9999"></label>
      <label class="full">URL de la foto<input name="imageUrl"></label>
      <label class="full">URL de publicación<input name="publicationUrl"></label>
      <div class="full" style="display:flex;gap:10px;justify-content:flex-end">
        <button type="button" class="link-btn ghost" data-close>Cancelar</button>
        <button type="submit" class="btn-primary">Crear producto</button>
      </div>
    </form>`);
  document.getElementById("newProductForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const prices = {};
    for (const tier of ["one", "four", "eight"]) {
      if (f[tier].value.trim()) prices[tier] = priceBodyFromInput(f[tier].value);
    }
    try {
      await postJson("/api/admin/products", {
        sku: f.sku.value.trim(),
        name: f.name.value.trim(),
        brand: f.brand.value.trim() || undefined,
        category: f.category.value.trim() || undefined,
        ivaRate: Number(f.ivaRate.value),
        imageUrl: f.imageUrl.value.trim() || undefined,
        publicationUrl: f.publicationUrl.value.trim() || undefined,
        sortOrder: f.sortOrder.value ? Number(f.sortOrder.value) : undefined,
        prices
      });
      closeModal();
      await loadProducts();
    } catch (error) {
      alert("No se pudo crear: " + (error.body?.detail || error.message));
    }
  });
});

// ==================== Catálogo (editor visual + drag-and-drop) ====================

let catalogMeta = { brands: [], categories: [] };
let catalogSearchTimer = null;
let catalogWired = false;
let catalogLoadSeq = 0;
const catSelected = new Set(); // ids de productos tildados para reasignación masiva

async function openCatalogEditor() {
  await loadCatalogMeta();
  await loadCatalogCards();
  if (!catalogWired) {
    catalogWired = true;
    document.getElementById("catBrandFilter").addEventListener("change", loadCatalogCards);
    document.getElementById("catCategoryFilter").addEventListener("change", loadCatalogCards);
    document.getElementById("catSearch").addEventListener("input", () => {
      clearTimeout(catalogSearchTimer);
      catalogSearchTimer = setTimeout(loadCatalogCards, 350);
    });
    document.getElementById("catNewBtn").addEventListener("click", () => openProductModal(null));
    document.getElementById("brandLogosBtn").addEventListener("click", openBrandLogosModal);
    document.getElementById("catManageBtn").addEventListener("click", openTaxonomyModal);
    document.getElementById("catalogEditorGrid").addEventListener("change", (e) => {
      const chk = e.target.closest(".cc-check");
      if (!chk) return;
      const id = chk.closest(".cat-card")?.dataset.id;
      if (!id) return;
      if (chk.checked) catSelected.add(id);
      else catSelected.delete(id);
      updateCatBulkBar();
    });
    document.getElementById("catBulkApply").addEventListener("click", applyCatBulk);
    document.getElementById("catBulkClear").addEventListener("click", () => {
      catSelected.clear();
      document.querySelectorAll("#catalogEditorGrid .cc-check").forEach((c) => (c.checked = false));
      updateCatBulkBar();
    });
    wireCatalogGridClicks();
    wireCatalogDnD();
  }
}

async function loadCatalogMeta() {
  const meta = await fetchJson("/api/admin/catalog/meta");
  catalogMeta = meta;
  const bf = document.getElementById("catBrandFilter");
  const bv = bf.value;
  bf.innerHTML = '<option value="">Todas las marcas</option>' + meta.brands.map((b) => `<option value="${esc(b.brand)}">${esc(b.brand)} (${b.n})</option>`).join("");
  if (bv) bf.value = bv;
  const cf = document.getElementById("catCategoryFilter");
  const cv = cf.value;
  cf.innerHTML = '<option value="">Todas las categorías</option>' + meta.categories.map((c) => `<option value="${esc(c.category)}">${esc(c.category)} (${c.n})</option>`).join("");
  if (cv) cf.value = cv;
  fillCatBulkSelects();
}

// Selectores de la barra de acción masiva (marca/categoría destino).
function fillCatBulkSelects() {
  const bs = document.getElementById("catBulkBrand");
  if (bs) {
    const v = bs.value;
    bs.innerHTML =
      '<option value="">Marca (sin cambios)</option>' +
      catalogMeta.brands.map((b) => `<option value="${esc(b.brand)}">${esc(b.brand)}</option>`).join("") +
      '<option value="__new__">+ Nueva marca…</option>';
    bs.value = v;
  }
  const cs = document.getElementById("catBulkCategory");
  if (cs) {
    const v = cs.value;
    cs.innerHTML =
      '<option value="">Categoría (sin cambios)</option>' +
      catalogMeta.categories.map((c) => `<option value="${esc(c.category)}">${esc(c.category)}</option>`).join("") +
      '<option value="__new__">+ Nueva categoría…</option>';
    cs.value = v;
  }
}

function updateCatBulkBar() {
  const bar = document.getElementById("catBulkBar");
  const n = catSelected.size;
  if (!n) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  document.getElementById("catBulkCount").textContent = `${n} seleccionado${n > 1 ? "s" : ""}`;
}

async function applyCatBulk() {
  if (!catSelected.size) return;
  let brand = document.getElementById("catBulkBrand").value;
  let category = document.getElementById("catBulkCategory").value;
  if (brand === "__new__") {
    brand = (prompt("Nombre de la nueva marca:") || "").trim();
    if (!brand) return;
  }
  if (category === "__new__") {
    category = (prompt("Nombre de la nueva categoría:") || "").trim();
    if (!category) return;
  }
  if (!brand && !category) return alert("Elegí una marca o categoría destino.");
  const n = catSelected.size;
  const parts = [];
  if (brand) parts.push(`marca "${brand}"`);
  if (category) parts.push(`categoría "${category}"`);
  if (!confirm(`Reasignar ${n} producto(s) a ${parts.join(" y ")}?`)) return;
  const payload = { ids: [...catSelected] };
  if (brand) payload.brand = brand;
  if (category) payload.category = category;
  try {
    await postJson("/api/admin/products/bulk-assign", payload);
    await loadCatalogMeta();
    await loadCatalogCards();
  } catch (error) {
    alert("No se pudo reasignar: " + (error.body?.detail || error.message));
  }
}

// Modal de gestión de marcas y categorías: renombrar en línea; si el nombre
// nuevo ya existe, se fusiona (todos los productos pasan a ese nombre).
async function openTaxonomyModal() {
  await loadCatalogMeta();
  const row = (kind, name, n) => `<div class="tax-row" data-kind="${kind}" data-name="${esc(name)}" draggable="true">
      <span class="tax-handle" aria-hidden="true" title="Arrastrar para reordenar">⠿</span>
      <input class="tax-input" value="${esc(name)}" aria-label="Nombre">
      <span class="tax-count">${n}</span>
      <button class="link-btn tax-save" type="button">Guardar</button>
    </div>`;
  openModal(`
    <div class="modal-head"><h3>Marcas y categorías</h3><button class="modal-x" data-close>&times;</button></div>
    <p style="font-size:12.5px;color:var(--muted);margin-bottom:12px">Arrastrá con ⠿ para cambiar el <b>orden</b> en que aparecen en el catálogo del cliente (se guarda solo al soltar). Editá el nombre y tocá Guardar para <b>renombrar</b>; si el nombre ya existe, se <b>fusionan</b>.</p>
    <div class="tax-cols">
      <div class="tax-col" data-kind="brand"><h4>Marcas</h4>${catalogMeta.brands.map((b) => row("brand", b.brand, b.n)).join("") || '<p class="muted-note">Sin marcas.</p>'}</div>
      <div class="tax-col" data-kind="category"><h4>Categorías</h4>${catalogMeta.categories.map((c) => row("category", c.category, c.n)).join("") || '<p class="muted-note">Sin categorías.</p>'}</div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;align-items:center;margin-top:14px">
      <span id="taxMsg" style="font-size:12.5px;margin-right:auto"></span>
      <button type="button" class="link-btn ghost" data-close>Cerrar</button>
    </div>`);
  // Renombrar / fusionar (click en "Guardar" de cada fila)
  document.querySelector("#modalBox .tax-cols").addEventListener("click", async (e) => {
    const btn = e.target.closest(".tax-save");
    if (!btn) return;
    const rowEl = btn.closest(".tax-row");
    const kind = rowEl.dataset.kind;
    const from = rowEl.dataset.name;
    const to = rowEl.querySelector(".tax-input").value.trim();
    if (!to || to === from) return;
    const label = kind === "brand" ? "marca" : "categoría";
    const existing = kind === "brand" ? catalogMeta.brands.map((b) => b.brand) : catalogMeta.categories.map((c) => c.category);
    if (existing.includes(to)) {
      if (!confirm(`Ya existe la ${label} "${to}". Se fusionarán: todos los productos de "${from}" pasarán a "${to}". ¿Continuar?`)) return;
    } else if (!confirm(`Renombrar la ${label} "${from}" → "${to}"?`)) return;
    const msg = document.getElementById("taxMsg");
    try {
      const url = kind === "brand" ? "/api/admin/catalog/rename-brand" : "/api/admin/catalog/rename-category";
      await postJson(url, { from, to });
      await loadCatalogMeta();
      await loadCatalogCards();
      closeModal();
      openTaxonomyModal();
    } catch (error) {
      msg.style.color = "var(--danger,#c8102e)";
      msg.textContent = "Error: " + (error.body?.detail || error.message);
    }
  });
  // Drag-and-drop para reordenar (dentro de cada columna; persiste al soltar)
  document.querySelectorAll("#modalBox .tax-col").forEach((col) => wireTaxDnD(col));
}

let taxDragEl = null;
function taxDragAfter(col, y) {
  const els = [...col.querySelectorAll(".tax-row:not(.dragging)")];
  let closest = { offset: -Infinity, el: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}
function wireTaxDnD(col) {
  col.addEventListener("dragstart", (e) => {
    const r = e.target.closest(".tax-row");
    if (!r) return;
    taxDragEl = r;
    r.classList.add("dragging");
  });
  col.addEventListener("dragover", (e) => {
    if (!taxDragEl || !col.contains(taxDragEl)) return; // solo dentro de la misma columna
    e.preventDefault();
    const after = taxDragAfter(col, e.clientY);
    if (after == null) col.appendChild(taxDragEl);
    else col.insertBefore(taxDragEl, after);
  });
  col.addEventListener("dragend", async (e) => {
    const r = e.target.closest(".tax-row");
    if (!r) return;
    r.classList.remove("dragging");
    taxDragEl = null;
    await persistTaxOrder(col);
  });
}
async function persistTaxOrder(col) {
  const kind = col.dataset.kind;
  const names = [...col.querySelectorAll(".tax-row")].map((r) => r.dataset.name);
  const body = kind === "brand" ? { brands: names } : { categories: names };
  const msg = document.getElementById("taxMsg");
  try {
    await putJson("/api/admin/catalog/order", body);
    if (msg) { msg.style.color = "var(--success,#137333)"; msg.textContent = `Orden de ${kind === "brand" ? "marcas" : "categorías"} guardado ✓`; }
    await loadCatalogMeta();
    await loadCatalogCards();
  } catch (error) {
    if (msg) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "No se pudo guardar el orden: " + (error.body?.detail || error.message); }
  }
}

function catPriceTxt(p, t) {
  const e = p.prices ? p.prices[t] : null;
  if (e && e.state === "value" && e.amount != null) return money(e.amount);
  if (e && e.state === "consult") return "Consultar";
  return "—";
}

function catalogCardHtml(p) {
  return `<div class="cat-card${p.visible ? "" : " hidden-prod"}" draggable="true" data-id="${p.id}">
    <input type="checkbox" class="cc-check" title="Seleccionar" aria-label="Seleccionar producto"${catSelected.has(p.id) ? " checked" : ""}>
    <span class="cc-handle" aria-hidden="true">⠿</span>
    <div class="cc-thumb">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : '<div class="cc-noimg"></div>'}</div>
    <div class="cc-info">
      <div class="cc-name">${esc(p.name)}</div>
      <div class="cc-meta"><span class="cc-sku">${esc(p.sku)}</span> · ${esc(p.brand)} · ${esc(p.category)}</div>
      <div class="cc-prices">1u ${catPriceTxt(p, "one")} · 4u ${catPriceTxt(p, "four")} · 8u ${catPriceTxt(p, "eight")} · IVA ${Number(p.iva_rate)}%</div>
    </div>
    <div class="cc-side">
      <span class="cc-order">#${p.sort_order ?? ""}</span>
      <button class="eye-btn ${p.visible ? "on" : "off"}" data-action="toggle-visible" title="${p.visible ? "Visible" : "Oculto"}">${p.visible ? "&#128065;" : "&#128584;"}</button>
      <button class="link-btn" data-action="edit">Editar</button>
      <button class="link-btn ghost" data-action="del">Borrar</button>
    </div>
  </div>`;
}

async function loadCatalogCards() {
  const qs = new URLSearchParams();
  const brand = document.getElementById("catBrandFilter").value;
  const category = document.getElementById("catCategoryFilter").value;
  const search = document.getElementById("catSearch").value.trim();
  if (brand) qs.set("brand", brand);
  if (category) qs.set("category", category);
  if (search) qs.set("search", search);
  const seq = ++catalogLoadSeq;
  const { products } = await fetchJson(`/api/admin/products${qs.toString() ? `?${qs}` : ""}`);
  if (seq !== catalogLoadSeq) return; // llegó una carga más nueva; descartar esta
  window.__catalogProducts = new Map(products.map((p) => [p.id, p]));
  catSelected.clear();
  const grid = document.getElementById("catalogEditorGrid");
  grid.innerHTML = products.map(catalogCardHtml).join("") || '<div class="empty-row">Sin productos con ese filtro.</div>';
  updateCatBulkBar();
}

// Drag-and-drop vertical (lista de tarjetas horizontales): fiable y simple.
let catDragEl = null;
function catDragAfter(container, y) {
  const els = [...container.querySelectorAll(".cat-card:not(.dragging)")];
  let closest = { offset: -Infinity, el: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}
function wireCatalogDnD() {
  const grid = document.getElementById("catalogEditorGrid");
  grid.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".cat-card");
    if (!card) return;
    catDragEl = card;
    card.classList.add("dragging");
  });
  grid.addEventListener("dragend", async (e) => {
    const card = e.target.closest(".cat-card");
    if (!card) return;
    card.classList.remove("dragging");
    catDragEl = null;
    await persistCatalogOrder();
  });
  grid.addEventListener("dragover", (e) => {
    if (!catDragEl) return;
    e.preventDefault();
    const after = catDragAfter(grid, e.clientY);
    if (after == null) grid.appendChild(catDragEl);
    else grid.insertBefore(catDragEl, after);
  });
}
async function persistCatalogOrder() {
  const orderedIds = [...document.querySelectorAll("#catalogEditorGrid .cat-card")].map((c) => c.dataset.id);
  if (!orderedIds.length) return;
  try {
    await putJson("/api/admin/products/order", { orderedIds });
    await loadCatalogCards();
  } catch (error) {
    alert("No se pudo guardar el orden: " + error.message);
    await loadCatalogCards();
  }
}

function wireCatalogGridClicks() {
  document.getElementById("catalogEditorGrid").addEventListener("click", async (e) => {
    const card = e.target.closest(".cat-card");
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('[data-action="edit"]')) {
      openProductModal(window.__catalogProducts?.get(id));
    } else if (e.target.closest('[data-action="del"]')) {
      if (!confirm(`¿Borrar "${card.querySelector(".cc-name").textContent}" del catálogo? (se puede recuperar re-creando el SKU)`)) return;
      try { await deleteJson(`/api/admin/products/${id}`); await loadCatalogCards(); }
      catch (error) { alert("No se pudo borrar: " + error.message); }
    } else if (e.target.closest('[data-action="toggle-visible"]')) {
      const p = window.__catalogProducts?.get(id);
      try { await patchJson(`/api/admin/products/${id}`, { visible: !(p && p.visible) }); await loadCatalogCards(); }
      catch (error) { alert("No se pudo cambiar la visibilidad: " + error.message); }
    }
  });
}

// Editor de logos de marca: una URL por marca; se muestran en las tarjetas del
// catálogo del cliente (con fallback a las letras si el logo no carga).
async function openBrandLogosModal() {
  let logos = {};
  try {
    ({ logos } = await fetchJson("/api/admin/brand-logos"));
  } catch (error) {
    alert("No se pudieron cargar los logos: " + error.message);
    return;
  }
  const brands = catalogMeta.brands.map((b) => b.brand);
  openModal(`
    <div class="modal-head"><h3>Logos de marca</h3><button class="modal-x" data-close>&times;</button></div>
    <p style="font-size:12.5px;color:var(--muted);margin-bottom:12px">Pegá la URL de la imagen del logo de cada marca (idealmente alojada en autodiagnostico.com.ar). Si se deja vacío, la tarjeta muestra las iniciales.</p>
    <form id="brandLogosForm" class="form-grid">
      ${brands.map((b) => `<label class="full">${esc(b)}<input name="logo::${esc(b)}" value="${esc(logos[b] || "")}" placeholder="https://autodiagnostico.com.ar/.../logo.png"></label>`).join("")}
      <div class="full" style="display:flex;gap:10px;justify-content:flex-end;align-items:center">
        <span id="blMsg" style="font-size:12.5px;margin-right:auto"></span>
        <button type="button" class="link-btn ghost" data-close>Cancelar</button>
        <button type="submit" class="btn-primary">Guardar logos</button>
      </div>
    </form>`);
  document.getElementById("brandLogosForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const out = {};
    for (const el of ev.target.querySelectorAll("input[name^='logo::']")) {
      out[el.name.slice("logo::".length)] = el.value.trim();
    }
    const msg = document.getElementById("blMsg");
    try {
      await putJson("/api/admin/brand-logos", { logos: out });
      msg.style.color = "var(--success,#137333)";
      msg.textContent = "Guardado ✓";
      setTimeout(closeModal, 800);
    } catch (error) {
      msg.style.color = "var(--danger,#c8102e)";
      msg.textContent = "No se pudo guardar: " + (error.body?.detail || error.message);
    }
  });
}

// Modal de alta/edición completa de producto (compartido entre "Nuevo" y "Editar").
function openProductModal(product) {
  const isNew = !product;
  const p = product || {};
  const pv = (t) => esc(priceInputValue(p.prices ? p.prices[t] : null));
  openModal(`
    <div class="modal-head"><h3>${isNew ? "Nuevo producto" : "Editar producto"}</h3><button class="modal-x" data-close>&times;</button></div>
    <form id="prodForm" class="form-grid">
      <label>SKU *<input name="sku" value="${esc(p.sku || "")}" required></label>
      <label>Nombre *<input name="name" value="${esc(p.name || "")}" required></label>
      <label>Marca<input name="brand" list="prodBrands" value="${esc(p.brand || "")}"></label>
      <label>Categoría<input name="category" list="prodCats" value="${esc(p.category || "")}"></label>
      <datalist id="prodBrands">${catalogMeta.brands.map((b) => `<option value="${esc(b.brand)}"></option>`).join("")}</datalist>
      <datalist id="prodCats">${catalogMeta.categories.map((c) => `<option value="${esc(c.category)}"></option>`).join("")}</datalist>
      <label>IVA<select name="ivaRate">${IVA_OPTIONS.map((r) => `<option value="${r}"${Number(p.iva_rate ?? 10.5) === r ? " selected" : ""}>${r}%</option>`).join("")}</select></label>
      <label>Visible<select name="visible"><option value="true"${p.visible !== false ? " selected" : ""}>Sí</option><option value="false"${p.visible === false ? " selected" : ""}>No</option></select></label>
      <label>Precio 1u<input name="one" value="${pv("one")}" placeholder="vacío = oculto"></label>
      <label>Precio 4u<input name="four" value="${pv("four")}"></label>
      <label>Precio 8u<input name="eight" value="${pv("eight")}"></label>
      <label class="full">URL de la foto<input name="imageUrl" value="${esc(p.image_url || "")}"></label>
      <label class="full">URL de publicación (autodiagnostico.com.ar)<input name="publicationUrl" value="${esc(p.publication_url || "")}"></label>
      <label class="full">Nota<input name="note" value="${esc(p.note || "")}"></label>
      <div class="full" style="display:flex;gap:10px;justify-content:flex-end;align-items:center">
        <span id="prodMsg" style="font-size:12.5px;margin-right:auto"></span>
        <button type="button" class="link-btn ghost" data-close>Cancelar</button>
        <button type="submit" class="btn-primary">${isNew ? "Crear producto" : "Guardar cambios"}</button>
      </div>
    </form>`);

  document.getElementById("prodForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const payload = {
      sku: f.sku.value.trim(),
      name: f.name.value.trim(),
      brand: f.brand.value.trim() || undefined,
      category: f.category.value.trim() || undefined,
      ivaRate: Number(f.ivaRate.value),
      visible: f.visible.value === "true",
      imageUrl: f.imageUrl.value.trim(),
      publicationUrl: f.publicationUrl.value.trim(),
      note: f.note.value.trim()
    };
    const msg = document.getElementById("prodMsg");
    try {
      if (isNew) {
        const prices = {};
        for (const t of ["one", "four", "eight"]) if (f[t].value.trim()) prices[t] = priceBodyFromInput(f[t].value);
        await postJson("/api/admin/products", { ...payload, prices });
      } else {
        await patchJson(`/api/admin/products/${p.id}`, payload);
        for (const t of ["one", "four", "eight"]) await putJson(`/api/admin/products/${p.id}/prices/${t}`, priceBodyFromInput(f[t].value));
      }
      closeModal();
      await loadCatalogMeta();
      await loadCatalogCards();
    } catch (error) {
      msg.style.color = "var(--danger,#c8102e)";
      msg.textContent = "No se pudo guardar: " + (error.body?.detail || error.message);
    }
  });
}

// ==================== Clientes ====================

const ROLE_LABEL = {
  superadmin: "Superadmin", sales_billing: "Ventas/Fact.", administration: "Administración",
  logistics: "Logística", client: "Cliente", admin: "Admin (legacy)", customer: "Cliente (legacy)"
};
const ASSIGNABLE_ROLES = ["superadmin", "sales_billing", "administration", "logistics", "client"];
function canonRole(r) { return ({ admin: "superadmin", customer: "client" })[r] || r; }
function roleSelectHtml(current) {
  const cur = canonRole(current);
  return `<select class="role-select">${ASSIGNABLE_ROLES.map((r) => `<option value="${r}"${r === cur ? " selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>`;
}
const STATUS_LABEL = { pending: "Pendiente", approved: "Aprobado", rejected: "Rechazado", blocked: "Bloqueado" };
const STATUS_PILL = { pending: "pending", approved: "approved", rejected: "rejected", blocked: "blocked" };

async function loadClients() {
  const status = document.getElementById("clientStatusFilter").value;
  const month = document.getElementById("clientMonthFilter")?.value || "";
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (month) qs.set("month", month);
  const { users } = await fetchJson(`/api/admin/users${qs.toString() ? `?${qs}` : ""}`);
  const body = document.getElementById("clientsBody");
  body.innerHTML =
    users
      .map(
        (u) => `<tr data-id="${u.id}" data-email="${esc(u.email)}">
          <td style="font-family:var(--font-mono);font-size:11.5px">${esc(u.client_code || "-")}</td>
          <td>${esc(u.email)}</td>
          <td>${esc(u.display_name || "-")}</td>
          <td>${esc(u.company_name || "-")}</td>
          <td>${roleSelectHtml(u.role)}</td>
          <td><span class="status-pill ${STATUS_PILL[u.status] || "pending"}">${STATUS_LABEL[u.status] || u.status}</span></td>
          <td>${timeAgo(u.created_at)}</td>
          <td>${timeAgo(u.last_login_at)}</td>
          <td style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="link-btn" data-action="edit-profile">Datos</button>
            <button class="link-btn" data-action="view-orders">Ver compras</button>
            ${u.status !== "approved" ? '<button class="link-btn" data-action="approve">Aprobar</button>' : ""}
            ${u.status !== "rejected" ? '<button class="link-btn ghost" data-action="reject">Rechazar</button>' : ""}
            <button class="link-btn ghost" data-action="delete-user" title="Eliminar cliente">🗑</button>
          </td>
        </tr>`
      )
      .join("") || '<tr><td colspan="9" class="empty-row">No hay usuarios con ese filtro.</td></tr>';
}

document.getElementById("clientStatusFilter").addEventListener("change", loadClients);
document.getElementById("clientMonthFilter").addEventListener("change", loadClients);

// "Ver compras" (guía §11.1): modal con los pedidos del cliente + pill de estado
// y el stepper Cotización→…→Despachado por cada uno (reusa quoteStepper/pills).
async function openClientOrders(userId, email) {
  openModal(`
    <div class="modal-head"><h3>Compras · ${esc(email)}</h3><button class="modal-x" data-close>&times;</button></div>
    <div id="clientOrdersBody"><div class="empty-row">Cargando...</div></div>`);
  const body = document.getElementById("clientOrdersBody");
  try {
    const { quotes } = await fetchJson(`/api/admin/quotes?userId=${encodeURIComponent(userId)}`);
    if (!quotes.length) { body.innerHTML = '<div class="empty-row">Este cliente todavía no tiene cotizaciones.</div>'; return; }
    body.innerHTML = quotes.map((q) => `
      <div style="border:1px solid var(--border,#e0e0e0);border-radius:10px;padding:12px 14px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <div><b>#${q.request_number}</b> <span style="color:var(--muted);font-size:12px">${new Date(q.submitted_at).toLocaleDateString("es-AR")}</span></div>
          <div style="display:flex;gap:10px;align-items:center">
            <span class="status-pill ${statusPillClass(q.status)}">${QUOTE_STATUS_LABEL[q.status] || q.status}</span>
            <b class="tabular">${money(q.quoted_total ?? q.displayed_subtotal ?? 0)}</b>
          </div>
        </div>
        ${quoteStepper(q.status)}
      </div>`).join("");
  } catch (error) {
    body.innerHTML = `<div class="empty-row" style="color:var(--danger,#c8102e)">No se pudieron cargar: ${esc(error.body?.detail || error.message)}</div>`;
  }
}

document.getElementById("clientsBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const row = btn.closest("tr");
  const id = row.dataset.id;

  if (btn.dataset.action === "edit-profile") {
    openClientProfileModal(id, row.dataset.email);
    return;
  }

  if (btn.dataset.action === "view-orders") {
    openClientOrders(id, row.dataset.email);
    return;
  }

  if (btn.dataset.action === "delete-user") {
    if (!confirm(`¿Eliminar al cliente ${row.dataset.email}? Se borran también TODAS sus cotizaciones. Esta acción no se puede deshacer.`)) return;
    btn.disabled = true;
    try {
      const r = await deleteJson(`/api/admin/users/${id}`);
      await loadClients();
      await populateMonths("clientMonthFilter", "/api/admin/users/months");
      if (r.deletedQuotes) await loadQuotes();
    } catch (error) {
      alert("No se pudo eliminar: " + (error.body?.detail || error.message));
      btn.disabled = false;
    }
    return;
  }

  const payload = {
    approve: { status: "approved" },
    reject: { status: "rejected" }
  }[btn.dataset.action];
  if (!payload) return;
  btn.disabled = true;
  try {
    await patchJson(`/api/admin/users/${id}`, payload);
    await loadClients();
  } catch (error) {
    alert("No se pudo actualizar el usuario: " + (error.body?.detail || error.message));
    btn.disabled = false;
  }
});

// Cambio de rol inline (selector en la columna Rol).
document.getElementById("clientsBody").addEventListener("change", async (e) => {
  const sel = e.target.closest(".role-select");
  if (!sel) return;
  const id = sel.closest("tr").dataset.id;
  try {
    await patchJson(`/api/admin/users/${id}`, { role: sel.value });
  } catch (error) {
    alert("No se pudo cambiar el rol: " + (error.body?.detail || error.message));
    await loadClients();
  }
});

// Completar/editar los datos fiscales + dirección de un cliente desde el panel.
const TAX_CONDITION_OPTS = [["responsable_inscripto", "Responsable Inscripto"], ["monotributo", "Monotributo"], ["exento", "Exento"], ["consumidor_final", "Consumidor Final"]];
function adminAllowedTypes(cond) { return cond === "consumidor_final" ? ["DNI", "CUIL", "CUIT"] : ["CUIT"]; }
function adminDefaultType(cond) { return cond === "consumidor_final" ? "DNI" : "CUIT"; }

async function openClientProfileModal(id, email) {
  let p = {};
  try {
    ({ profile: p } = await fetchJson(`/api/admin/users/${id}/profile`));
    p = p || {};
  } catch (error) {
    alert("No se pudieron cargar los datos: " + error.message);
    return;
  }
  const v = (k) => esc(p[k] || "");
  openModal(`
    <div class="modal-head"><h3>Datos del cliente</h3><button class="modal-x" data-close>&times;</button></div>
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:12px">${esc(email)}</div>
    <form id="clientProfileForm" class="form-grid">
      <label class="full">Razón social / Nombre<input name="company_name" value="${v("company_name")}"></label>
      <label>Condición de IVA
        <select name="tax_condition">
          <option value="">Sin especificar</option>
          ${TAX_CONDITION_OPTS.map(([val, lbl]) => `<option value="${val}"${p.tax_condition === val ? " selected" : ""}>${lbl}</option>`).join("")}
        </select>
      </label>
      <label><span id="cpTaxLabel">Documento</span>
        <div style="display:flex;gap:6px">
          <select name="tax_id_type" style="width:88px"></select>
          <input name="tax_cuit" value="${v("tax_cuit")}" style="flex:1;min-width:0">
        </div>
      </label>
      <label>Calle<input name="ship_street" value="${v("ship_street")}"></label>
      <label>Número<input name="ship_number" value="${v("ship_number")}"></label>
      <label>Piso<input name="ship_floor" value="${v("ship_floor")}"></label>
      <label>Depto<input name="ship_apartment" value="${v("ship_apartment")}"></label>
      <label>Código postal<input name="ship_postal_code" value="${v("ship_postal_code")}"></label>
      <label>Localidad<input name="ship_city" value="${v("ship_city")}"></label>
      <label>Provincia<input name="ship_province" value="${v("ship_province")}"></label>
      <label>Teléfono<input name="ship_phone" value="${v("ship_phone")}"></label>
      <label class="full">Notas de entrega<textarea name="ship_notes" rows="2">${v("ship_notes")}</textarea></label>
      <div class="full" style="display:flex;gap:10px;justify-content:flex-end;align-items:center">
        <span id="cpMsg" style="font-size:12.5px;margin-right:auto"></span>
        <button type="button" class="link-btn ghost" data-close>Cancelar</button>
        <button type="submit" class="btn-primary">Guardar</button>
      </div>
    </form>`);

  const form = document.getElementById("clientProfileForm");
  const syncType = (preferred) => {
    const cond = form.tax_condition.value;
    const types = adminAllowedTypes(cond);
    const keep = types.includes(preferred) ? preferred : (types.includes(form.tax_id_type.value) ? form.tax_id_type.value : adminDefaultType(cond));
    form.tax_id_type.innerHTML = types.map((t) => `<option value="${t}"${t === keep ? " selected" : ""}>${t}</option>`).join("");
    form.tax_id_type.disabled = types.length === 1;
    document.getElementById("cpTaxLabel").textContent = form.tax_id_type.value;
  };
  syncType(p.tax_id_type);
  form.tax_condition.addEventListener("change", () => syncType());
  form.tax_id_type.addEventListener("change", () => (document.getElementById("cpTaxLabel").textContent = form.tax_id_type.value));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const out = {};
    for (const f of ["company_name", "tax_cuit", "tax_id_type", "tax_condition", "ship_street", "ship_number", "ship_floor", "ship_apartment", "ship_postal_code", "ship_city", "ship_province", "ship_phone", "ship_notes"]) {
      out[f] = form[f] ? form[f].value.trim() : "";
    }
    const msg = document.getElementById("cpMsg");
    try {
      await putJson(`/api/admin/users/${id}/profile`, { profile: out });
      msg.style.color = "var(--success,#137333)";
      msg.textContent = "Guardado ✓";
      setTimeout(closeModal, 800);
    } catch (error) {
      msg.style.color = "var(--danger,#c8102e)";
      msg.textContent = "No se pudo guardar: " + (error.body?.detail || error.message);
    }
  });
}

document.getElementById("newClientBtn").addEventListener("click", () => {
  openModal(`
    <div class="modal-head"><h3>Nuevo cliente</h3><button class="modal-x" data-close>&times;</button></div>
    <form id="newClientForm" class="form-grid">
      <label class="full">Email *<input name="email" type="email" required></label>
      <label>Nombre<input name="displayName" placeholder="Se usa el email si se deja vacío"></label>
      <label>Empresa<input name="companyName"></label>
      <label>Rol
        <select name="role">
          <option value="client" selected>Cliente</option>
          <option value="sales_billing">Ventas/Facturación</option>
          <option value="administration">Administración</option>
          <option value="logistics">Logística</option>
          <option value="superadmin">Superadmin</option>
        </select>
      </label>
      <label>Estado
        <select name="status">
          <option value="approved" selected>Aprobado</option>
          <option value="pending">Pendiente</option>
          <option value="rejected">Rechazado</option>
          <option value="blocked">Bloqueado</option>
        </select>
      </label>
      <div class="full" style="font-size:11.5px;color:var(--muted)">Si este email inicia sesión con Google más adelante, se vincula automáticamente a esta misma ficha (mismo código de cliente, estado y datos).</div>
      <div class="full" style="display:flex;gap:10px;justify-content:flex-end">
        <span id="newClientMsg" style="font-size:12.5px;color:var(--danger,#c8102e);margin-right:auto"></span>
        <button type="button" class="link-btn ghost" data-close>Cancelar</button>
        <button type="submit" class="btn-primary">Crear cliente</button>
      </div>
    </form>`);
  document.getElementById("newClientForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const msg = document.getElementById("newClientMsg");
    try {
      await postJson("/api/admin/users", {
        email: f.email.value.trim(),
        displayName: f.displayName.value.trim() || undefined,
        companyName: f.companyName.value.trim() || undefined,
        role: f.role.value,
        status: f.status.value
      });
      closeModal();
      await loadClients();
      await populateMonths("clientMonthFilter", "/api/admin/users/months");
    } catch (error) {
      msg.textContent = error.body?.detail || error.message;
    }
  });
});

// ==================== Cotizaciones ====================

// Modelo simplificado de 5 estados (guía §11.2). El select de edición ofrece los
// 5 nuevos; el mapa de labels mantiene además las claves viejas por si la DB aún
// no migró (lectura robusta). 'despachado' lo dispara Logística.
const QUOTE_STATUS = ["cotizacion", "enviada", "orden", "despachado", "cancelado"];
const QUOTE_STATUS_LABEL = {
  cotizacion: "Cotización", enviada: "Cotización enviada", orden: "Orden de venta", despachado: "Despachado", cancelado: "Cancelado",
  submitted: "Cotización", reviewing: "Cotización", quoted: "Cotización enviada", accepted: "Orden de venta", rejected: "Cancelado", expired: "Cancelado", cancelled: "Cancelado"
};
// Normaliza estados viejos → nuevos (por si se lee data sin migrar todavía).
const STATUS_OLD_TO_NEW = { submitted: "cotizacion", reviewing: "cotizacion", quoted: "enviada", accepted: "orden", rejected: "cancelado", expired: "cancelado", cancelled: "cancelado" };
function normStatus(s) { return STATUS_OLD_TO_NEW[s] || s; }
// Estados que corresponden al documento "Compra" (vs "Pre-compra").
const STATUS_COMPRA = new Set(["orden", "despachado", "accepted"]);
// Ribbon progresivo de la venta; 'cancelado' se muestra aparte en rojo (estilo Odoo).
const STEPPER_STEPS = [
  { key: "cotizacion", label: "Cotización" },
  { key: "enviada", label: "Cotización enviada" },
  { key: "orden", label: "Orden de venta" },
  { key: "despachado", label: "Despachado" }
];
// Estados que el admin puede setear a mano en el editor. 'despachado' NO está:
// lo dispara Logística al despachar (evita desincronizar con logistics_status).
const QUOTE_STATUS_MANUAL = ["cotizacion", "enviada", "orden", "cancelado"];
function statusPillClass(status) {
  const s = normStatus(status);
  return s === "cotizacion" ? "pending" : (s === "cancelado" ? "rejected" : "approved");
}
function quoteStepper(status) {
  const st = normStatus(status);
  if (st === "cancelado") return `<div class="stepper"><span class="st cancel">Cancelado</span></div>`;
  const idx = STEPPER_STEPS.findIndex((x) => x.key === st);
  return `<div class="stepper">${STEPPER_STEPS
    .map((x, i) => `<span class="st ${i < idx ? "done" : (i === idx ? "cur" : "")}">${x.label}</span>`)
    .join("")}</div>`;
}

let currentQuoteId = null;

const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
function monthLabel(ym) {
  const [y, m] = ym.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

// Rellena un <select> de meses conservando la opción "Todos" y la selección.
async function populateMonths(selectId, url) {
  const sel = document.getElementById(selectId);
  const current = sel.value;
  const { months } = await fetchJson(url);
  sel.innerHTML = '<option value="">Todos los meses</option>' + months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join("");
  if (current && months.includes(current)) sel.value = current;
}

async function loadQuotes() {
  const month = document.getElementById("quoteMonthFilter")?.value || "";
  const status = document.getElementById("quoteStatusFilter")?.value || "";
  const qs = new URLSearchParams();
  if (month) qs.set("month", month);
  if (status) qs.set("status", status);
  const { quotes } = await fetchJson(`/api/admin/quotes${qs.toString() ? `?${qs}` : ""}`);
  const body = document.getElementById("quotesBody");
  body.innerHTML =
    quotes
      .map(
        (q) => `<tr data-id="${q.id}" class="quote-row${q.id === currentQuoteId ? " active" : ""}" style="cursor:pointer">
          <td><strong>#${q.request_number}</strong></td>
          <td>${esc(q.display_name || q.email)}${q.company_name ? `<br><span style="color:var(--muted);font-size:11.5px">${esc(q.company_name)}</span>` : ""}</td>
          <td><span class="status-pill ${statusPillClass(q.status)}">${QUOTE_STATUS_LABEL[q.status] || q.status}</span></td>
          <td class="num tabular">${money(q.quoted_total ?? q.displayed_subtotal)}</td>
          <td>${timeAgo(q.submitted_at)}</td>
          <td><button class="link-btn ghost" data-action="del-quote" title="Eliminar cotización">🗑</button></td>
        </tr>`
      )
      .join("") || '<tr><td colspan="6" class="empty-row">No hay cotizaciones con ese filtro.</td></tr>';
}

document.getElementById("quotesBody").addEventListener("click", async (e) => {
  const delBtn = e.target.closest('button[data-action="del-quote"]');
  if (delBtn) {
    e.stopPropagation();
    const row = delBtn.closest("tr[data-id]");
    const num = row.querySelector("strong")?.textContent || "";
    if (!confirm(`¿Eliminar la cotización ${num}? Esta acción no se puede deshacer.`)) return;
    delBtn.disabled = true;
    try {
      await deleteJson(`/api/admin/quotes/${row.dataset.id}`);
      if (currentQuoteId === row.dataset.id) {
        currentQuoteId = null;
        document.getElementById("quoteDetailBody").className = "empty-row";
        document.getElementById("quoteDetailBody").textContent = "Elegí una cotización de la lista para ver y editar el detalle.";
      }
      await loadQuotes();
      await populateMonths("quoteMonthFilter", "/api/admin/quotes/months");
    } catch (error) {
      alert("No se pudo eliminar: " + error.message);
      delBtn.disabled = false;
    }
    return;
  }
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  currentQuoteId = row.dataset.id;
  document.querySelectorAll(".quote-row").forEach((r) => r.classList.toggle("active", r === row));
  renderQuoteEditor(currentQuoteId);
});

document.getElementById("quoteMonthFilter").addEventListener("change", loadQuotes);
document.getElementById("quoteStatusFilter").addEventListener("change", loadQuotes);

function itemUnit(it) {
  if (it.quoted_unit_price != null) return Number(it.quoted_unit_price);
  const snap = it.displayed_price_snapshot || {};
  return snap.amount != null ? Number(snap.amount) : null;
}

function itemRate(it) {
  return it.iva_rate != null && it.iva_rate !== "" ? Number(it.iva_rate) : 10.5;
}

// Espeja src/quoteTotals.js (IVA por línea) para el preview en vivo del editor.
function previewTotals({ items, discount, discountType, shipping }) {
  let itemsGross = 0;
  const lines = [];
  for (const it of items) {
    if (it.unit == null) continue;
    const gross = it.unit * Number(it.quantity || 0);
    itemsGross += gross;
    lines.push({ gross, rate: Number(it.rate) || 0 });
  }
  const discountAmount = discountType === "percent" ? (itemsGross * (Number(discount) || 0)) / 100 : Number(discount) || 0;
  const factor = itemsGross > 0 ? Math.max(0, itemsGross - discountAmount) / itemsGross : 0;
  const groups = new Map();
  for (const l of lines) {
    const g = groups.get(l.rate) || { rate: l.rate, gross: 0 };
    g.gross += l.gross * factor;
    groups.set(l.rate, g);
  }
  const ivaGroups = [...groups.values()].sort((a, b) => a.rate - b.rate).map((g) => {
    const neto = g.gross / (1 + g.rate / 100);
    return { rate: g.rate, gross: g.gross, neto, iva: g.gross - neto };
  });
  const total = itemsGross - discountAmount + (Number(shipping) || 0);
  return { itemsGross, discountAmount, ivaGroups, total };
}

// Chatter (guía §11.1): timeline de actividad + notas internas, alimentado por
// portal.audit_log (endpoint /admin/quotes/:id/audit y POST .../note).
const CHATTER_ACTION_LABEL = {
  "quote.create": "creó la cotización",
  "order.dispatch": "marcó el pedido como despachado"
};
function chatterEventText(e) {
  if (e.action === "quote.update") {
    if (e.metadata && e.metadata.statusChanged && e.before_data && e.after_data) {
      const from = QUOTE_STATUS_LABEL[e.before_data.status] || e.before_data.status || "—";
      const to = QUOTE_STATUS_LABEL[e.after_data.status] || e.after_data.status || "—";
      return `Estado: <b>${esc(from)}</b> → <b>${esc(to)}</b>`;
    }
    return "Editó la cotización";
  }
  return esc(CHATTER_ACTION_LABEL[e.action] || e.action);
}
async function loadQuoteChatter(id, canEdit) {
  const tl = document.getElementById("quoteTimeline");
  if (!tl) return;
  try {
    const { entries } = await fetchJson(`/api/admin/quotes/${id}/audit`);
    if (!entries.length) {
      tl.innerHTML = '<div class="empty-row">Sin actividad todavía.</div>';
    } else {
      tl.innerHTML = entries.slice().reverse().map((e) => {
        const who = esc(e.actor_name || e.actor_email || "Sistema");
        const when = new Date(e.created_at).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        const initial = esc((e.actor_name || e.actor_email || "S").trim().charAt(0).toUpperCase() || "S");
        if (e.action === "quote.note") {
          return `<div class="ev"><div class="av">${initial}</div><div class="evb"><div class="evh">${who} <span>· ${when}</span></div><div class="msg">${esc(e.metadata?.text || "")}</div></div></div>`;
        }
        return `<div class="ev"><div class="av sys">${initial}</div><div class="evb"><div class="evh">${who} <span>· ${when}</span></div><div class="evc">${chatterEventText(e)}</div></div></div>`;
      }).join("");
    }
  } catch {
    tl.innerHTML = '<div class="empty-row" style="color:var(--danger,#c8102e)">No se pudo cargar la actividad.</div>';
  }
  if (canEdit) {
    const btn = document.getElementById("chatterSend");
    const input = document.getElementById("chatterInput");
    const msg = document.getElementById("chatterMsg");
    if (btn && input) btn.addEventListener("click", async () => {
      const text = input.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        await postJson(`/api/admin/quotes/${id}/note`, { text });
        input.value = "";
        await loadQuoteChatter(id, canEdit);
      } catch (err) {
        if (msg) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = err.body?.detail || err.message; }
      } finally { btn.disabled = false; }
    });
  }
}

// Agrega una línea de sección o nota a la cotización (pide el texto y re-render).
async function addQuoteLine(id, type) {
  const text = prompt(type === "section" ? "Título de la sección:" : "Texto de la nota:");
  if (!text || !text.trim()) return;
  try {
    await postJson(`/api/admin/quotes/${id}/lines`, { type, text: text.trim() });
    await renderQuoteEditor(id);
  } catch (e) {
    alert("No se pudo agregar: " + (e.body?.detail || e.message));
  }
}

// Fila de SECCIÓN o NOTA en el editor de cotización (guía §11.1). No es un
// producto: no tiene cantidad/precio y no cuenta en los totales. Lleva data-item
// para poder quitarla, pero el recálculo la ignora (no tiene input de cantidad).
function annotationRow(it, canEdit) {
  const inner = it.line_type === "section"
    ? `<b>${esc(it.product_name_snapshot)}</b>`
    : `<span style="color:var(--muted)">📝 ${esc(it.product_name_snapshot)}</span>`;
  return canEdit
    ? `<tr data-item="${it.id}" class="qline-${it.line_type}">
        <td class="q-handle-cell"><span class="q-handle" title="Arrastrar para reordenar" aria-hidden="true">⠿</span></td>
        <td colspan="5">${inner}</td>
        <td><button class="link-btn ghost" data-action="del-item">Quitar</button></td>
      </tr>`
    : `<tr class="qline-${it.line_type}"><td colspan="5">${inner}</td></tr>`;
}

async function renderQuoteEditor(id, targetId = "quoteDetailBody") {
  const canEditQuote = CAN_MANAGE_QUOTES; // ventas/superadmin editan; administración: solo finanzas (lectura)
  // Sólo un editor a la vez: limpio el otro contenedor para no dejar IDs duplicados.
  ["quoteDetailBody", "billingDetailBody"].forEach((tid) => {
    if (tid !== targetId) { const el = document.getElementById(tid); if (el) { el.className = "empty-row"; el.textContent = "Elegí un pedido de la lista."; } }
  });
  const panel = document.getElementById(targetId);
  panel.className = "";
  panel.innerHTML = "Cargando...";
  const { quote, items } = await fetchJson(`/api/admin/quotes/${id}`);
  const cur = quote.currency || "ARS";
  const dtype = quote.discount_type || "nominal";
  // Mientras es cotización/enviada = "Pre-compra"; orden o despachado = "Compra".
  const docTerm = STATUS_COMPRA.has(quote.status) ? "Compra" : "Pre-compra";

  const itemRows = items
    .map(
      (it) => (it.line_type === "section" || it.line_type === "note")
        ? annotationRow(it, canEditQuote)
        : canEditQuote
        ? `<tr data-item="${it.id}">
        <td class="q-handle-cell"><span class="q-handle" title="Arrastrar para reordenar" aria-hidden="true">⠿</span></td>
        <td><span style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted)">${esc(it.sku_snapshot)}</span><br>${esc(it.product_name_snapshot)}</td>
        <td><input class="cell-input" data-f="quantity" type="number" min="1" value="${Number(it.quantity)}" style="width:56px"></td>
        <td>${ivaSelect('data-f="ivaRate"', itemRate(it))}</td>
        <td><input class="cell-input" data-f="unitPrice" value="${itemUnit(it) ?? ""}" placeholder="${(it.displayed_price_snapshot || {}).state === "consult" ? "consultar" : ""}" style="width:110px"></td>
        <td class="num tabular line-total">${itemUnit(it) != null ? money(itemUnit(it) * Number(it.quantity), cur) : ((it.displayed_price_snapshot || {}).state === "consult" ? "Consultar" : "-")}</td>
        <td style="display:flex;gap:6px">
          <button class="link-btn" data-action="save-item">Guardar</button>
          <button class="link-btn ghost" data-action="del-item">Quitar</button>
        </td>
      </tr>`
        : `<tr>
        <td><span style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted)">${esc(it.sku_snapshot)}</span><br>${esc(it.product_name_snapshot)}</td>
        <td class="num tabular">${Number(it.quantity)}</td>
        <td class="num">${itemRate(it)}%</td>
        <td class="num tabular">${itemUnit(it) != null ? money(itemUnit(it), cur) : "-"}</td>
        <td class="num tabular">${itemUnit(it) != null ? money(itemUnit(it) * Number(it.quantity), cur) : "-"}</td>
      </tr>`
    )
    .join("");

  const staticTotals = previewTotals({
    items: items.filter((it) => (it.line_type || "product") === "product").map((it) => ({ quantity: it.quantity, unit: itemUnit(it), rate: itemRate(it) })),
    discount: quote.discount, discountType: dtype, shipping: quote.shipping
  });
  const gmailConnected = currentUser?.gmail_connected;

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div>
        <h3 style="margin:0">${canEditQuote ? "Cotización" : "Pedido"} #${quote.request_number}</h3>
        <div style="font-size:12.5px;color:var(--muted);margin-top:2px">${esc(quote.company_name || quote.display_name || quote.email)} · ${esc(quote.email)}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${canEditQuote
          ? `<select id="quoteStatus" class="admin-search" style="min-width:140px">${(normStatus(quote.status) === "despachado" ? [...QUOTE_STATUS_MANUAL, "despachado"] : QUOTE_STATUS_MANUAL).map((s) => `<option value="${s}"${normStatus(quote.status) === s ? " selected" : ""}>${QUOTE_STATUS_LABEL[s]}</option>`).join("")}</select>`
          : `<span class="status-pill approved">${QUOTE_STATUS_LABEL[quote.status] || quote.status}</span>`}
        <button class="btn-primary" id="proformaBtn">Ver ${docTerm.toLowerCase()}</button>
      </div>
    </div>

    ${quoteStepper(quote.status)}

    ${quote.customer_notes ? `<p style="font-size:12.5px;color:var(--muted);margin-top:10px"><b>Notas del cliente:</b> ${esc(quote.customer_notes)}</p>` : ""}

    <div style="overflow-x:auto;margin-top:14px">
      <table>
        <thead><tr>${canEditQuote ? '<th style="width:22px"></th>' : ""}<th>Producto</th><th${canEditQuote ? "" : ' class="num"'}>Cant.</th><th${canEditQuote ? "" : ' class="num"'}>IVA</th><th${canEditQuote ? "" : ' class="num"'}>Precio unit.</th><th class="num">Importe</th>${canEditQuote ? "<th></th>" : ""}</tr></thead>
        <tbody id="quoteItemsBody">${itemRows || `<tr><td colspan="${canEditQuote ? 7 : 5}" class="empty-row">Sin items.</td></tr>`}</tbody>
      </table>
    </div>

    ${canEditQuote ? `<div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <input type="search" id="addProductSearch" class="admin-search" placeholder="Buscar producto para agregar..." style="flex:1;min-width:200px">
      <button class="link-btn" id="addSectionBtn" type="button">+ Sección</button>
      <button class="link-btn" id="addNoteBtn" type="button">+ Nota</button>
      <div id="addProductResults" class="add-results" style="flex-basis:100%"></div>
    </div>` : ""}

    <div class="quote-totals">
      ${canEditQuote ? `<div class="qt-adjustments">
        <label>Descuento
          <div style="display:flex;gap:4px">
            <input id="qDiscount" type="number" step="0.01" value="${Number(quote.discount || 0)}" style="width:88px">
            <select id="qDiscountType" style="border:1px solid var(--border,#e0e0e0);border-radius:7px;font-size:12px">
              <option value="nominal"${dtype === "nominal" ? " selected" : ""}>$</option>
              <option value="percent"${dtype === "percent" ? " selected" : ""}>%</option>
            </select>
          </div>
        </label>
        <label>Envío<input id="qShipping" type="number" step="0.01" value="${Number(quote.shipping || 0)}"></label>
      </div>` : "<div></div>"}
      <div class="qt-summary">
        <div><span>Subtotal (IVA incl.)</span><b id="qSubtotal">${money(Math.round((staticTotals.itemsGross + Number.EPSILON) * 100) / 100, cur)}</b></div>
        <div><span>Descuento</span><b id="qDiscountShown">-${money(Math.round((staticTotals.discountAmount + Number.EPSILON) * 100) / 100, cur)}</b></div>
        <div id="qIvaBreakdown"></div>
        <div class="grand"><span>Total</span><b id="qTotal">${money(Math.round((staticTotals.total + Number.EPSILON) * 100) / 100, cur)}</b></div>
      </div>
    </div>

    ${canEditQuote ? `<div class="form-grid" style="margin-top:14px">
      <label>Términos de pago<input id="qPaymentTerms" value="${esc(quote.payment_terms || "")}" placeholder="Ej: 30 días" class="admin-search"></label>
      <label>Vencimiento<input id="qDueDate" type="date" value="${quote.due_date ? String(quote.due_date).slice(0, 10) : ""}" class="admin-search"></label>
    </div>
    <label style="display:block;margin-top:14px;font-size:12.5px">Notas para el cliente (aparecen en la pre-compra)
      <textarea id="qPublicNotes" rows="2" class="admin-search" style="width:100%;margin-top:4px">${esc(quote.public_notes || "")}</textarea>
    </label>

    <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <button class="btn-primary" id="saveQuoteBtn">Guardar cotización</button>
      <button class="btn-primary" id="sendProformaBtn" style="background:#137333">✉ Enviar ${docTerm.toLowerCase()} al cliente</button>
      <span id="quoteSaveMsg" style="font-size:12.5px;color:var(--success,#137333)"></span>
    </div>

    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#eee)">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn-primary" id="sendWarehouseBtn" style="background:#2c2c2c">📦 Enviar al depósito</button>
        <input id="warehouseExtra" class="admin-search" placeholder="Copiar a otro correo (opcional)" style="flex:1;min-width:200px">
        <span id="warehouseMsg" style="font-size:12.5px;color:var(--success,#137333)"></span>
      </div>
      <div style="font-size:11.5px;color:var(--muted);margin-top:6px">Envía la hoja de armado (productos + dirección de entrega) al depósito desde tu casilla.</div>
    </div>` : ""}

    ${canEditQuote ? `<div style="font-size:11.5px;color:var(--muted);margin-top:10px">
      ${gmailConnected
        ? `Los envíos salen desde tu casilla (${esc(currentUser.gmail_address || currentUser.email)}).`
        : `Para enviar desde tu casilla necesitás <a href="/auth/google/gmail">conectar tu Gmail</a> una vez.`}
    </div>` : ""}

    <div id="financeSection" hidden style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#eee)">
      <h4 style="margin:0 0 8px">Facturación</h4>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <label style="font-size:12px;display:flex;align-items:center;gap:5px">Condición de pago
          <select id="finPayCond" class="admin-search" style="min-width:180px"></select>
        </label>
        <label style="font-size:12px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="finSaveDefault"> Guardar como habitual del cliente</label>
        <button class="link-btn" id="finPayCondSave" type="button">Guardar condición</button>
        <span id="finCondMsg" style="font-size:12px"></span>
      </div>
      <div id="finInvoicesList" style="font-size:12.5px;color:var(--muted);margin-bottom:10px">Cargando facturas...</div>
      <details>
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--brand-red,#c8102e)">+ Cargar factura</summary>
        <div class="form-grid" style="margin-top:10px">
          <label>Tipo<select id="finType"></select></label>
          <label>Punto de venta<input id="finPos" placeholder="0001"></label>
          <label>Número<input id="finNumber" placeholder="00000123"></label>
          <label>Fecha de emisión<input id="finIssueDate" type="date"></label>
          <label>Total<input id="finTotal" type="number" step="0.01" placeholder="0.00"></label>
          <label>PDF (opcional)<input id="finFile" type="file" accept=".pdf,application/pdf,.jpg,.jpeg,.png,.webp,image/*"></label>
          <div class="full">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Vencimientos (si dejás uno solo = pago único por el total). La suma debe dar el total.</div>
            <div id="finInstallments"></div>
            <button class="link-btn ghost" id="finAddInst" type="button">+ Agregar vencimiento</button>
          </div>
          <label class="full" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="finVisible"> Visible para el cliente</label>
          <div class="full" style="display:flex;gap:10px;align-items:center">
            <button class="btn-primary" id="finCreateBtn" type="button">Cargar factura</button>
            <span id="finMsg" style="font-size:12px"></span>
          </div>
        </div>
      </details>
    </div>

    <div id="accountSection" hidden style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#eee)">
      <h4 style="margin:0 0 8px">Cuenta corriente del cliente <button class="link-btn" id="stmtBtn" type="button" style="font-weight:400;margin-left:8px">Ver estado de cuenta</button></h4>
      <div id="accountBalance" style="display:flex;gap:10px;flex-wrap:wrap;font-size:12.5px;margin-bottom:10px"></div>
      <div id="accountMovements" style="font-size:12px;color:var(--muted);margin-bottom:10px"></div>
      <details>
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--brand-red,#c8102e)">+ Ajuste manual</summary>
        <div class="form-grid" style="margin-top:10px">
          <label>Tipo<select id="adjType"><option value="debit_adjustment">Débito (aumenta deuda)</option><option value="credit_adjustment">Crédito (baja deuda / a favor)</option></select></label>
          <label>Monto<input id="adjAmount" type="number" step="0.01"></label>
          <label class="full">Descripción<input id="adjDesc" placeholder="Motivo del ajuste"></label>
          <div class="full" style="display:flex;gap:10px;align-items:center"><button class="btn-primary" id="adjBtn" type="button">Registrar ajuste</button><span id="adjMsg" style="font-size:12px"></span></div>
        </div>
      </details>
    </div>

    <div id="paymentsSection" hidden style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#eee)">
      <h4 style="margin:0 0 8px">Pagos</h4>
      <div id="paymentsList" style="font-size:12.5px;color:var(--muted);margin-bottom:10px">Cargando pagos...</div>
      <details>
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--brand-red,#c8102e)">+ Registrar pago</summary>
        <div class="form-grid" style="margin-top:10px">
          <label>Método<select id="payMethod"><option value="cash">Efectivo</option><option value="bank_transfer">Transferencia</option><option value="other">Otro</option></select></label>
          <label>Monto<input id="payAmount" type="number" step="0.01"></label>
          <label>Referencia<input id="payRef" placeholder="N° operación"></label>
          <label>Fecha<input id="payDate" type="date"></label>
          <label class="full" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="payInformed"> Solo informar (no confirmar todavía)</label>
          <div class="full" style="display:flex;gap:10px;align-items:center"><button class="btn-primary" id="payCreateBtn" type="button">Registrar pago</button><span id="payMsg" style="font-size:12px"></span></div>
        </div>
      </details>
    </div>

    <div id="echeqSection" hidden style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#eee)">
      <h4 style="margin:0 0 8px">eCheqs</h4>
      <div id="echeqList" style="font-size:12.5px;color:var(--muted);margin-bottom:10px">Cargando eCheqs...</div>
      <details>
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--brand-red,#c8102e)">+ Registrar eCheq</summary>
        <div class="form-grid" style="margin-top:10px">
          <label>Monto<input id="echAmount" type="number" step="0.01"></label>
          <label>N° eCheq<input id="echNumber"></label>
          <label>Banco<input id="echBank"></label>
          <label>Librador<input id="echIssuer"></label>
          <label>CUIT librador<input id="echIssuerTax"></label>
          <label>Fecha de pago<input id="echPayDate" type="date"></label>
          <label>Acreditación esperada<input id="echExpDate" type="date"></label>
          <div class="full" style="display:flex;gap:10px;align-items:center"><button class="btn-primary" id="echCreateBtn" type="button">Registrar eCheq</button><span id="echMsg" style="font-size:12px"></span></div>
        </div>
      </details>
    </div>

    <div id="logisticsSection" hidden style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#eee)">
      <h4 style="margin:0 0 8px">Resumen y autorización a Logística</h4>
      <div id="finSummary" style="display:flex;gap:10px;flex-wrap:wrap;font-size:12.5px;margin-bottom:8px"></div>
      <div id="authState" style="font-size:12.5px;margin-bottom:8px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="authReason" class="admin-search" style="min-width:190px"><option value="">Motivo de autorización...</option></select>
        <input id="authNotes" class="admin-search" placeholder="Notas (opcional)" style="flex:1;min-width:160px">
        <button class="btn-primary" id="authBtn" type="button">Autorizar para logística</button>
        <span id="authMsg" style="font-size:12px"></span>
      </div>
    </div>

    <div id="serialSection" hidden style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#eee)">
      <h4 style="margin:0 0 8px">Números de serie <span style="font-weight:400;color:var(--muted);font-size:12px">(trazabilidad, solo lectura)</span></h4>
      <div id="serialList" style="font-size:12.5px;color:var(--muted)">Cargando...</div>
    </div>

    <div id="docsSection" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,#eee)">
      <h4 style="margin:0 0 8px">Documentos del pedido</h4>
      <div id="docsStatusNote" style="font-size:11.5px;color:var(--muted);margin-bottom:8px"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <select id="docType" class="admin-search" style="min-width:180px">
          <option value="proforma">Pre-compra</option>
          <option value="factura">Factura</option>
          <option value="nota_credito">Nota de crédito</option>
          <option value="comprobante_transferencia">Comprobante de transferencia</option>
          <option value="comprobante_echeq">Comprobante de eCheq</option>
          <option value="remito">Remito</option>
          <option value="etiqueta_envio">Etiqueta de envío</option>
          <option value="constancia_entrega">Constancia de entrega</option>
          <option value="otro">Otro</option>
        </select>
        <input type="file" id="docFile" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp">
        <label style="font-size:12px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="docVisible"> Visible al cliente</label>
        <button class="btn-primary" id="docUploadBtn">Subir</button>
        <span id="docMsg" style="font-size:12px"></span>
      </div>
      <div id="docsList" style="font-size:12.5px;color:var(--muted)">Cargando documentos...</div>
    </div>

    <div id="quoteChatter" class="chatter" style="margin-top:14px">
      <div class="cbar">Actividad</div>
      <div class="tl" id="quoteTimeline"><div class="empty-row">Cargando actividad…</div></div>
      ${canEditQuote ? `<div class="composer">
        <textarea id="chatterInput" rows="2" placeholder="Escribí una nota interna (no la ve el cliente)…"></textarea>
        <div class="ctools"><button class="btn-primary sm" id="chatterSend" type="button">Agregar nota</button><span id="chatterMsg" style="font-size:12px"></span></div>
      </div>` : ""}
    </div>
  `;

  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  // IVA discriminado del total (se muestra en ambos modos; en solo-lectura es estático).
  document.getElementById("qIvaBreakdown").innerHTML = staticTotals.ivaGroups
    .map((g) => `<div><span>Neto ${g.rate}%</span><b>${money(r2(g.neto), cur)}</b></div><div><span>IVA ${g.rate}%</span><b>${money(r2(g.iva), cur)}</b></div>`)
    .join("");
  loadQuoteChatter(id, canEditQuote);

  document.getElementById("proformaBtn").addEventListener("click", () => window.open(`/api/admin/quotes/${id}/proforma`, "_blank"));

  if (canEditQuote) {
    const recalc = () => {
      const rows = [...document.querySelectorAll("#quoteItemsBody tr[data-item]")].filter((r) => r.querySelector('[data-f="quantity"]')).map((r) => ({
        quantity: Number(r.querySelector('[data-f="quantity"]').value) || 0,
        unit: r.querySelector('[data-f="unitPrice"]').value === "" ? null : Number(r.querySelector('[data-f="unitPrice"]').value),
        rate: Number(r.querySelector('[data-f="ivaRate"]').value)
      }));
      const t = previewTotals({
        items: rows,
        discount: document.getElementById("qDiscount").value,
        discountType: document.getElementById("qDiscountType").value,
        shipping: document.getElementById("qShipping").value
      });
      document.getElementById("qSubtotal").textContent = money(r2(t.itemsGross), cur);
      document.getElementById("qDiscountShown").textContent = "-" + money(r2(t.discountAmount), cur);
      document.getElementById("qIvaBreakdown").innerHTML = t.ivaGroups
        .map((g) => `<div><span>Neto ${g.rate}%</span><b>${money(r2(g.neto), cur)}</b></div><div><span>IVA ${g.rate}%</span><b>${money(r2(g.iva), cur)}</b></div>`)
        .join("");
      document.getElementById("qTotal").textContent = money(r2(t.total), cur);
    };
    ["qDiscount", "qDiscountType", "qShipping"].forEach((elId) => document.getElementById(elId).addEventListener("input", recalc));
    document.getElementById("quoteItemsBody").addEventListener("input", (e) => { if (e.target.dataset.f) recalc(); });
    document.getElementById("quoteItemsBody").addEventListener("change", (e) => { if (e.target.dataset.f === "ivaRate") recalc(); });
    recalc();
    document.getElementById("saveQuoteBtn").addEventListener("click", () => saveQuoteHeader(id));
    document.getElementById("sendProformaBtn").addEventListener("click", () => sendProforma(id, quote.email));
    document.getElementById("sendWarehouseBtn").addEventListener("click", () => sendWarehouse(id));
    document.getElementById("addSectionBtn").addEventListener("click", () => addQuoteLine(id, "section"));
    document.getElementById("addNoteBtn").addEventListener("click", () => addQuoteLine(id, "note"));
    wireQuoteItemActions(id);
    wireQuoteItemsDnD(id);
    wireAddProduct(id);
  }
  wireDocuments(id);
  wireFinance(id, quote);
}

// ==================== Facturación (Tanda 1, detrás de feature flag) ====================
const PAY_COND_LABEL = {
  contado: "Contado", transferencia_anticipada: "Transferencia anticipada", efectivo: "Efectivo",
  cuenta_corriente: "Cuenta corriente", echeq: "eCheq", mixto: "Pago mixto", personalizado: "Personalizada"
};
const INST_STATUS_LABEL = { pending: "Pendiente", partially_paid: "Parcial", paid: "Pagada", overdue: "Vencida", cancelled: "Cancelada" };

function finInstallmentRow(date, amount) {
  return `<div class="fin-inst-row" style="display:flex;gap:6px;align-items:center;margin-bottom:5px">
    <input type="date" class="fin-inst-date" value="${date || ""}" style="font-size:12.5px">
    <input type="number" step="0.01" class="fin-inst-amount" value="${amount ?? ""}" placeholder="monto" style="width:120px;font-size:12.5px">
    <button class="link-btn ghost fin-inst-del" type="button">✕</button>
  </div>`;
}

async function loadInvoices(id) {
  const box = document.getElementById("finInvoicesList");
  if (!box) return;
  try {
    const { invoices } = await fetchJson(`/api/admin/orders/${id}/invoices`);
    if (!invoices.length) { box.textContent = "Sin facturas cargadas."; return; }
    box.innerHTML = invoices.map((inv) => {
      const insts = (inv.installments || []).map((it) =>
        `<div style="margin-left:12px">· Cuota ${it.installment_number}: vence ${it.due_date} · ${money(it.amount)} · <b>${INST_STATUS_LABEL[it.display_status] || it.display_status}</b></div>`
      ).join("");
      return `<div style="padding:6px 0;border-bottom:1px solid #f0f0f0${inv.voided_at ? ";opacity:.5" : ""}">
        <div style="display:flex;gap:8px;align-items:center">
          <span style="flex:1"><b>${esc(inv.invoice_type)}</b> ${esc(inv.point_of_sale || "")}-${esc(inv.invoice_number || "s/n")} · ${money(inv.total_amount)} · emitida ${inv.issue_date}${inv.voided_at ? " · <span style='color:#c8102e'>ANULADA</span>" : ""}${inv.visible_to_customer ? " · 👁 cliente" : ""}</span>
          ${inv.document_id ? `<button class="link-btn" data-doc="${inv.document_id}">Ver PDF</button>` : ""}
          ${inv.voided_at ? "" : `<button class="link-btn ghost" data-void="${inv.id}">Anular</button>`}
        </div>${insts}</div>`;
    }).join("");
    box.querySelectorAll("[data-void]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("¿Anular esta factura?")) return;
      try { await postJson(`/api/admin/invoices/${b.dataset.void}/void`, {}); loadInvoices(id); }
      catch (e) { alert("No se pudo anular: " + (e.body?.detail || e.message)); }
    }));
    box.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => window.open(`/api/documents/${b.dataset.doc}/download`, "_blank")));
  } catch (error) {
    box.textContent = "No se pudieron cargar las facturas: " + error.message;
  }
}

const SERIAL_STATUS_LABEL = { assigned: "Asignado", delivered: "Entregado", removed: "Quitado", returned: "Devuelto", replaced: "Reemplazado" };

async function loadSerials(id) {
  const box = document.getElementById("serialList");
  if (!box) return;
  try {
    const { serials } = await fetchJson(`/api/admin/orders/${id}/serials`);
    const active = serials.filter((s) => s.status === "assigned");
    if (!serials.length) { box.textContent = "Aún no se registraron números de serie para este pedido."; return; }
    box.innerHTML = `<div style="margin-bottom:6px">${active.length} serial(es) activo(s)${serials.length > active.length ? ` · ${serials.length - active.length} en historial` : ""}.</div>` +
      serials.map((s) => `<div style="padding:3px 0;border-bottom:1px solid #f5f5f5;${s.status !== "assigned" ? "opacity:.55;" : ""}">
        <span style="font-family:var(--font-mono)">${esc(s.serial_number)}</span>
        · <b>${SERIAL_STATUS_LABEL[s.status] || s.status}</b>
        ${s.registered_by_name ? `· ${esc(s.registered_by_name)}` : ""}
        ${s.removal_reason ? `· <span style="color:#9a3412">${esc(s.removal_reason)}</span>` : ""}
      </div>`).join("");
  } catch (error) {
    // Roles sin capability de trazabilidad (ej. administración) reciben 403: ocultamos el panel.
    if (error.status === 403 || error.body?.error === "forbidden") {
      const sec = document.getElementById("serialSection"); if (sec) sec.hidden = true; return;
    }
    box.textContent = "No se pudieron cargar los números de serie: " + (error.body?.detail || error.message);
  }
}

async function wireFinance(id, quote) {
  const section = document.getElementById("financeSection");
  if (!section) return;
  let status;
  try { status = await fetchJson("/api/admin/finance/status"); } catch { return; }
  if (!status.financial) return; // módulo apagado: el panel queda oculto
  section.hidden = false;

  // Condición de pago
  const cond = document.getElementById("finPayCond");
  cond.innerHTML = '<option value="">(sin definir)</option>' + status.paymentConditions.map((c) => `<option value="${c}"${quote?.payment_condition === c ? " selected" : ""}>${PAY_COND_LABEL[c] || c}</option>`).join("");
  document.getElementById("finPayCondSave").addEventListener("click", async () => {
    const msg = document.getElementById("finCondMsg");
    try {
      await patchJson(`/api/admin/orders/${id}/payment-condition`, { condition: cond.value || null, saveAsClientDefault: document.getElementById("finSaveDefault").checked });
      msg.style.color = "var(--success,#137333)"; msg.textContent = "Guardada ✓";
    } catch (e) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Error: " + (e.body?.detail || e.message); }
  });

  // Form de carga
  document.getElementById("finType").innerHTML = status.invoiceTypes.map((t) => `<option value="${t}"${t === "B" ? " selected" : ""}>${t}</option>`).join("");
  document.getElementById("finIssueDate").value = new Date().toISOString().slice(0, 10);
  const instBox = document.getElementById("finInstallments");
  instBox.innerHTML = finInstallmentRow(new Date().toISOString().slice(0, 10), "");
  document.getElementById("finAddInst").addEventListener("click", () => instBox.insertAdjacentHTML("beforeend", finInstallmentRow("", "")));
  instBox.addEventListener("click", (e) => { if (e.target.closest(".fin-inst-del") && instBox.querySelectorAll(".fin-inst-row").length > 1) e.target.closest(".fin-inst-row").remove(); });

  document.getElementById("finCreateBtn").addEventListener("click", async () => {
    const msg = document.getElementById("finMsg");
    const total = Number(document.getElementById("finTotal").value);
    if (!Number.isFinite(total) || total <= 0) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Total inválido."; return; }
    const installments = [...instBox.querySelectorAll(".fin-inst-row")].map((r) => ({
      dueDate: r.querySelector(".fin-inst-date").value,
      amount: Number(r.querySelector(".fin-inst-amount").value)
    })).filter((i) => i.dueDate || i.amount);
    // si hay una sola cuota sin monto, se asume el total
    if (installments.length === 1 && (!installments[0].amount || Number.isNaN(installments[0].amount))) installments[0].amount = total;
    msg.style.color = "var(--muted)"; msg.textContent = "Cargando...";
    try {
      // subir PDF si hay
      let documentId = null;
      const file = document.getElementById("finFile").files[0];
      if (file) {
        const qs = new URLSearchParams({ documentType: "factura", orderId: id, filename: file.name, visibleToCustomer: String(document.getElementById("finVisible").checked) });
        const r = await fetch(`/api/admin/documents?${qs}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.detail || b.error || "no se pudo subir el PDF");
        documentId = b.document?.id || null;
      }
      await postJson(`/api/admin/orders/${id}/invoices`, {
        invoiceType: document.getElementById("finType").value,
        pointOfSale: document.getElementById("finPos").value.trim() || null,
        invoiceNumber: document.getElementById("finNumber").value.trim() || null,
        issueDate: document.getElementById("finIssueDate").value || null,
        totalAmount: total,
        installments,
        visibleToCustomer: document.getElementById("finVisible").checked,
        documentId
      });
      msg.style.color = "var(--success,#137333)"; msg.textContent = "Factura cargada ✓";
      document.getElementById("finTotal").value = ""; document.getElementById("finNumber").value = "";
      document.getElementById("finFile").value = "";
      instBox.innerHTML = finInstallmentRow(new Date().toISOString().slice(0, 10), "");
      loadInvoices(id);
    } catch (error) {
      msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "No se pudo cargar: " + (error.body?.detail || error.message);
    }
  });

  loadInvoices(id);

  // Pagos (Tanda 3) — parte del módulo financiero.
  document.getElementById("paymentsSection").hidden = false;
  wirePayments(id);

  // Resumen + autorización a logística (Tanda 5).
  document.getElementById("logisticsSection").hidden = false;
  wireLogistics(id, status);

  // eCheqs (Tanda 4), si el módulo está prendido.
  if (status.echeq) {
    document.getElementById("echeqSection").hidden = false;
    wireEcheqs(id);
  }

  // Trazabilidad de números de serie (Tanda 8), solo lectura para Ventas/Superadmin.
  if (status.serialNumbers) {
    document.getElementById("serialSection").hidden = false;
    loadSerials(id);
  }

  // Cuenta corriente (Tanda 2), si el módulo está prendido.
  if (status.currentAccount) {
    document.getElementById("accountSection").hidden = false;
    document.getElementById("stmtBtn").addEventListener("click", () => {
      if (window.__accountClientId) window.open(`/api/admin/clients/${window.__accountClientId}/account-statement`, "_blank");
    });
    await loadAccount(id);
    document.getElementById("adjBtn").addEventListener("click", async () => {
      const msg = document.getElementById("adjMsg");
      const amount = Number(document.getElementById("adjAmount").value);
      if (!Number.isFinite(amount) || amount <= 0) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Monto inválido."; return; }
      if (!window.__accountClientId) { msg.textContent = "Sin cliente."; return; }
      try {
        await postJson(`/api/admin/clients/${window.__accountClientId}/adjustments`, {
          type: document.getElementById("adjType").value, amount, description: document.getElementById("adjDesc").value.trim() || null, orderId: id
        });
        msg.style.color = "var(--success,#137333)"; msg.textContent = "Ajuste registrado ✓";
        document.getElementById("adjAmount").value = ""; document.getElementById("adjDesc").value = "";
        loadAccount(id);
      } catch (e) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Error: " + (e.body?.detail || e.message); }
    });
  }
}

const AUTH_REASON_LABEL = {
  pago_confirmado: "Pago confirmado", cuenta_corriente: "Cuenta corriente autorizada", echeq_aceptado: "eCheq aceptado",
  acuerdo_comercial: "Acuerdo comercial", excepcion_manual: "Excepción manual"
};
async function loadFinSummary(id) {
  const box = document.getElementById("finSummary");
  const st = document.getElementById("authState");
  if (!box) return;
  try {
    const { summary } = await fetchJson(`/api/admin/orders/${id}/financial-summary`);
    box.innerHTML =
      balChip("Total operación", summary.operationTotal) +
      balChip("Facturado", summary.invoiced) +
      balChip("Acreditado", summary.accredited, summary.accredited > 0 ? "var(--success,#137333)" : undefined) +
      balChip("Pend. acreditación", summary.pendingAccreditation) +
      balChip("Saldo del pedido", summary.orderBalance, summary.orderBalance > 0 ? "var(--brand-red,#c8102e)" : undefined) +
      balChip("Saldo cliente (vencido)", summary.clientBalance.overdue, summary.clientBalance.overdue > 0 ? "var(--brand-red,#c8102e)" : undefined);
    st.innerHTML = summary.authorized
      ? `✅ <b>Autorizado para logística</b> por ${esc(summary.authorizedByName || "")} · ${AUTH_REASON_LABEL[summary.authorizationReason] || summary.authorizationReason || ""}${summary.authorizationNotes ? " · " + esc(summary.authorizationNotes) : ""} <span style="color:var(--muted)">(estado: ${esc(summary.logisticsStatus)})</span>`
      : `<span style="color:var(--muted)">Pedido NO autorizado a logística todavía. Estado de pago: <b>${esc(summary.paymentState)}</b>.</span>`;
  } catch (error) { box.textContent = "No se pudo cargar el resumen: " + error.message; }
}
function wireLogistics(id, status) {
  const sel = document.getElementById("authReason");
  sel.innerHTML = '<option value="">Motivo de autorización...</option>' + (status.authorizationReasons || []).map((r) => `<option value="${r}">${AUTH_REASON_LABEL[r] || r}</option>`).join("");
  document.getElementById("authBtn").addEventListener("click", async () => {
    const msg = document.getElementById("authMsg");
    if (!sel.value) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Elegí un motivo."; return; }
    if (!confirm("¿Autorizar este pedido para preparación en Logística? Logística no verá información financiera.")) return;
    try {
      await postJson(`/api/admin/orders/${id}/authorize`, { reason: sel.value, notes: document.getElementById("authNotes").value.trim() || null });
      msg.style.color = "var(--success,#137333)"; msg.textContent = "Autorizado ✓";
      loadFinSummary(id);
    } catch (e) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Error: " + (e.body?.detail || e.message); }
  });
  loadFinSummary(id);
}

const ECHEQ_STATUS_LABEL = {
  received: "Recibido", pending_bank_acceptance: "Pend. aceptación banco", accepted: "Aceptado",
  pending_accreditation: "Pend. acreditación", accredited: "Acreditado", rejected: "Rechazado", cancelled: "Cancelado", expired: "Vencido"
};
async function loadEcheqs(id) {
  const box = document.getElementById("echeqList");
  if (!box) return;
  try {
    const { echeqs } = await fetchJson(`/api/admin/orders/${id}/echeqs`);
    if (!echeqs.length) { box.textContent = "Sin eCheqs registrados."; return; }
    box.innerHTML = echeqs.map((e) => {
      const canAccept = ["received", "pending_bank_acceptance"].includes(e.status);
      const canAccredit = ["accepted", "pending_accreditation"].includes(e.status);
      const canReject = e.status !== "accredited" && e.status !== "rejected";
      return `<div style="padding:6px 0;border-bottom:1px solid #f0f0f0${["rejected", "cancelled", "expired"].includes(e.status) ? ";opacity:.55" : ""}">
        <div style="display:flex;gap:8px;align-items:center">
          <span style="flex:1">${e.echeq_number ? "N° " + esc(e.echeq_number) : "eCheq"} · ${esc(e.bank_name || "")} · ${money(e.amount)} · <b>${ECHEQ_STATUS_LABEL[e.status] || e.status}</b>${e.actual_credit_date ? " · acreditado " + e.actual_credit_date : e.expected_credit_date ? " · esperado " + e.expected_credit_date : ""}</span>
          ${canAccept ? `<button class="link-btn" data-echacc="${e.id}">Aceptar</button>` : ""}
          ${canAccredit ? `<button class="link-btn" data-echcred="${e.id}">Acreditar</button>` : ""}
          ${canReject ? `<button class="link-btn ghost" data-echrej="${e.id}">Rechazar</button>` : ""}
        </div></div>`;
    }).join("");
    const reload = () => { loadEcheqs(id); loadPayments(id); loadAccount(id); };
    box.querySelectorAll("[data-echacc]").forEach((b) => b.addEventListener("click", async () => {
      try { await postJson(`/api/admin/echeqs/${b.dataset.echacc}/accept`, {}); reload(); } catch (e) { alert("No se pudo aceptar: " + (e.body?.detail || e.message)); }
    }));
    box.querySelectorAll("[data-echcred]").forEach((b) => b.addEventListener("click", async () => {
      const d = prompt("Fecha de acreditación real (YYYY-MM-DD, vacío = hoy):", new Date().toISOString().slice(0, 10));
      if (d === null) return;
      try { await postJson(`/api/admin/echeqs/${b.dataset.echcred}/accredit`, { actualCreditDate: d || null }); reload(); } catch (e) { alert("No se pudo acreditar: " + (e.body?.detail || e.message)); }
    }));
    box.querySelectorAll("[data-echrej]").forEach((b) => b.addEventListener("click", async () => {
      const reason = prompt("Motivo del rechazo:"); if (reason === null) return;
      try { await postJson(`/api/admin/echeqs/${b.dataset.echrej}/reject`, { reason }); reload(); } catch (e) { alert("No se pudo rechazar: " + (e.body?.detail || e.message)); }
    }));
  } catch (error) { box.textContent = "No se pudieron cargar los eCheqs: " + error.message; }
}
function wireEcheqs(id) {
  document.getElementById("echCreateBtn").addEventListener("click", async () => {
    const msg = document.getElementById("echMsg");
    const amount = Number(document.getElementById("echAmount").value);
    if (!Number.isFinite(amount) || amount <= 0) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Monto inválido."; return; }
    msg.style.color = "var(--muted)"; msg.textContent = "Registrando...";
    try {
      await postJson(`/api/admin/orders/${id}/echeqs`, {
        amount, echeqNumber: document.getElementById("echNumber").value.trim() || null,
        bankName: document.getElementById("echBank").value.trim() || null,
        issuerName: document.getElementById("echIssuer").value.trim() || null,
        issuerTaxId: document.getElementById("echIssuerTax").value.trim() || null,
        paymentDate: document.getElementById("echPayDate").value || null,
        expectedCreditDate: document.getElementById("echExpDate").value || null
      });
      msg.style.color = "var(--success,#137333)"; msg.textContent = "eCheq registrado ✓";
      document.getElementById("echAmount").value = ""; document.getElementById("echNumber").value = "";
      loadEcheqs(id); loadPayments(id);
    } catch (e) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Error: " + (e.body?.detail || e.message); }
  });
  loadEcheqs(id);
}

const PAY_METHOD_LABEL = { cash: "Efectivo", bank_transfer: "Transferencia", echeq: "eCheq", current_account: "Cta. corriente", customer_credit: "Saldo a favor", other: "Otro" };
const PAY_STATUS_LABEL = { draft: "Borrador", informed: "Informado", confirmed: "Confirmado", pending_accreditation: "Pend. acreditación", rejected: "Rechazado", reversed: "Reversado" };

async function loadPayments(id) {
  const box = document.getElementById("paymentsList");
  if (!box) return;
  try {
    const { payments } = await fetchJson(`/api/admin/orders/${id}/payments`);
    if (!payments.length) { box.textContent = "Sin pagos registrados."; return; }
    box.innerHTML = payments.map((p) => {
      const applied = Number(p.applied_amount || 0);
      const remaining = Math.max(0, Number(p.amount) - applied);
      const canConfirm = ["draft", "informed"].includes(p.status) && p.payment_method !== "echeq";
      const canApply = p.status === "confirmed" && remaining > 0.005;
      const canReverse = p.status === "confirmed";
      return `<div style="padding:6px 0;border-bottom:1px solid #f0f0f0${p.status === "reversed" ? ";opacity:.55" : ""}">
        <div style="display:flex;gap:8px;align-items:center">
          <span style="flex:1">${PAY_METHOD_LABEL[p.payment_method] || p.payment_method} · ${money(p.amount)} · <b>${PAY_STATUS_LABEL[p.status] || p.status}</b> · aplicado ${money(applied)}/${money(p.amount)}${p.reference_number ? " · ref " + esc(p.reference_number) : ""}</span>
          ${canConfirm ? `<button class="link-btn" data-payconfirm="${p.id}">Confirmar</button>` : ""}
          ${canApply ? `<button class="link-btn" data-payapply="${p.id}" data-rem="${remaining}">Aplicar</button>` : ""}
          ${canReverse ? `<button class="link-btn ghost" data-payreverse="${p.id}">Reversar</button>` : ""}
        </div></div>`;
    }).join("");
    box.querySelectorAll("[data-payconfirm]").forEach((b) => b.addEventListener("click", async () => {
      try { await postJson(`/api/admin/payments/${b.dataset.payconfirm}/confirm`, {}); loadPayments(id); loadAccount(id); loadInvoices(id); }
      catch (e) { alert("No se pudo confirmar: " + (e.body?.detail || e.message)); }
    }));
    box.querySelectorAll("[data-payreverse]").forEach((b) => b.addEventListener("click", async () => {
      const reason = prompt("Motivo de la reversa del pago:"); if (reason === null) return;
      try { await postJson(`/api/admin/payments/${b.dataset.payreverse}/reverse`, { reason }); loadPayments(id); loadAccount(id); loadInvoices(id); }
      catch (e) { alert("No se pudo reversar: " + (e.body?.detail || e.message)); }
    }));
    box.querySelectorAll("[data-payapply]").forEach((b) => b.addEventListener("click", () => openApplyModal(id, b.dataset.payapply, Number(b.dataset.rem))));
  } catch (error) { box.textContent = "No se pudieron cargar los pagos: " + error.message; }
}

// Modal para aplicar un pago a las cuotas impagas (prefill FIFO hasta el disponible).
async function openApplyModal(orderId, paymentId, remaining) {
  const { invoices } = await fetchJson(`/api/admin/orders/${orderId}/invoices`);
  const pend = [];
  for (const inv of invoices) {
    if (inv.voided_at) continue;
    for (const it of inv.installments) {
      const debt = Number(it.amount) - Number(it.paid_amount);
      if (debt > 0.005) pend.push({ id: it.id, label: `${inv.invoice_type} ${inv.point_of_sale || ""}-${inv.invoice_number || "s/n"} · cuota ${it.installment_number} (vence ${it.due_date})`, debt });
    }
  }
  if (!pend.length) { alert("No hay cuotas impagas para aplicar."); return; }
  let left = remaining;
  const rows = pend.map((c) => {
    const pre = Math.min(left, c.debt); left = Math.round((left - pre) * 100) / 100;
    return `<label class="full" style="display:grid;grid-template-columns:1fr 120px;gap:8px;align-items:center">
      <span style="font-size:12.5px">${esc(c.label)} · debe ${money(c.debt)}</span>
      <input type="number" step="0.01" class="apply-amt" data-inst="${c.id}" data-debt="${c.debt}" value="${pre || ""}">
    </label>`;
  }).join("");
  openModal(`
    <div class="modal-head"><h3>Aplicar pago</h3><button class="modal-x" data-close>&times;</button></div>
    <p style="font-size:12.5px;color:var(--muted)">Disponible del pago: <b>${money(remaining)}</b>. Ajustá los montos por cuota.</p>
    <form id="applyForm" class="form-grid">${rows}
      <div class="full" style="display:flex;gap:10px;justify-content:flex-end;align-items:center">
        <span id="applyMsg" style="font-size:12px;margin-right:auto"></span>
        <button type="button" class="link-btn ghost" data-close>Cancelar</button>
        <button type="submit" class="btn-primary">Aplicar</button>
      </div>
    </form>`);
  document.getElementById("applyForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const allocations = [...ev.target.querySelectorAll(".apply-amt")].map((i) => ({ installmentId: i.dataset.inst, amount: Number(i.value) })).filter((a) => a.amount > 0);
    const msg = document.getElementById("applyMsg");
    if (!allocations.length) { msg.textContent = "Ingresá al menos un monto."; return; }
    try {
      await postJson(`/api/admin/payments/${paymentId}/apply`, { allocations });
      closeModal(); loadPayments(orderId); loadAccount(orderId); loadInvoices(orderId);
    } catch (e) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Error: " + (e.body?.detail || e.message); }
  });
}

function wirePayments(id) {
  document.getElementById("payDate").value = new Date().toISOString().slice(0, 10);
  document.getElementById("payCreateBtn").addEventListener("click", async () => {
    const msg = document.getElementById("payMsg");
    const amount = Number(document.getElementById("payAmount").value);
    if (!Number.isFinite(amount) || amount <= 0) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Monto inválido."; return; }
    msg.style.color = "var(--muted)"; msg.textContent = "Registrando...";
    try {
      await postJson(`/api/admin/orders/${id}/payments`, {
        method: document.getElementById("payMethod").value, amount,
        reference: document.getElementById("payRef").value.trim() || null,
        paymentDate: document.getElementById("payDate").value || null,
        status: document.getElementById("payInformed").checked ? "informed" : "confirmed"
      });
      msg.style.color = "var(--success,#137333)"; msg.textContent = "Pago registrado ✓";
      document.getElementById("payAmount").value = ""; document.getElementById("payRef").value = "";
      loadPayments(id); loadAccount(id); loadInvoices(id);
    } catch (e) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Error: " + (e.body?.detail || e.message); }
  });
  loadPayments(id);
}

const MOVEMENT_LABEL = {
  invoice_debit: "Factura (débito)", payment_credit: "Pago (crédito)", credit_note: "Nota de crédito",
  debit_adjustment: "Ajuste débito", credit_adjustment: "Ajuste crédito", balance_applied: "Saldo aplicado",
  refund: "Reintegro", payment_reversal: "Reversa"
};
function balChip(label, value, color) {
  return `<span style="background:#f6f6f6;border:1px solid var(--border,#e0e0e0);border-radius:8px;padding:6px 10px"><span style="color:var(--muted,#888)">${label}</span> <b style="color:${color || "var(--catalog-dark,#111)"}">${money(value)}</b></span>`;
}
async function loadAccount(id) {
  const section = document.getElementById("accountSection");
  if (!section || section.hidden) return; // módulo de cuenta corriente apagado
  const balBox = document.getElementById("accountBalance");
  const movBox = document.getElementById("accountMovements");
  if (!balBox) return;
  try {
    const { clientId, balance, movements } = await fetchJson(`/api/admin/orders/${id}/account`);
    window.__accountClientId = clientId;
    balBox.innerHTML =
      balChip("Deuda total", balance.debt, balance.debt > 0 ? "var(--brand-red,#c8102e)" : undefined) +
      balChip("Vencido", balance.overdue, balance.overdue > 0 ? "var(--brand-red,#c8102e)" : undefined) +
      balChip("A vencer", balance.toDue) +
      balChip("A favor", balance.inFavor, balance.inFavor > 0 ? "var(--success,#137333)" : undefined) +
      balChip("Pend. acreditación", balance.pendingAccreditation);
    if (!movements.length) { movBox.textContent = "Sin movimientos."; return; }
    movBox.innerHTML = movements.map((m) => {
      const amt = Number(m.debit_amount) > 0 ? `<span style="color:var(--brand-red,#c8102e)">+${money(m.debit_amount)} deuda</span>` : `<span style="color:var(--success,#137333)">-${money(m.credit_amount)}</span>`;
      const rev = m.is_reversed ? " · <span style='color:#999'>REVERSADO</span>" : "";
      const canRev = !m.is_reversed && !m.reversed_movement_id;
      return `<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #f0f0f0${m.is_reversed ? ";opacity:.55" : ""}">
        <span style="flex:1">${m.effective_date} · ${MOVEMENT_LABEL[m.movement_type] || m.movement_type} · ${esc(m.description || "")} ${amt}${rev}</span>
        ${canRev ? `<button class="link-btn ghost" data-revmov="${m.id}">Reversar</button>` : ""}
      </div>`;
    }).join("");
    movBox.querySelectorAll("[data-revmov]").forEach((b) => b.addEventListener("click", async () => {
      const reason = prompt("Motivo de la reversa:");
      if (reason === null) return;
      try { await postJson(`/api/admin/movements/${b.dataset.revmov}/reverse`, { reason }); loadAccount(id); }
      catch (e) { alert("No se pudo reversar: " + (e.body?.detail || e.message)); }
    }));
  } catch (error) {
    movBox.textContent = "No se pudo cargar la cuenta corriente: " + error.message;
  }
}

// ==================== Documentos del pedido (Google Drive) ====================
const DOC_TYPE_LABEL = {
  proforma: "Pre-compra", factura: "Factura", nota_credito: "Nota de crédito",
  comprobante_transferencia: "Transferencia", comprobante_echeq: "eCheq",
  remito: "Remito", etiqueta_envio: "Etiqueta de envío", constancia_entrega: "Constancia de entrega", otro: "Otro"
};
async function loadDocs(id) {
  const list = document.getElementById("docsList");
  if (!list) return;
  try {
    const { documents } = await fetchJson(`/api/admin/documents?orderId=${id}`);
    if (!documents.length) { list.textContent = "Sin documentos todavía."; return; }
    list.innerHTML = documents.map((d) => `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #f0f0f0">
      <span style="flex:1;min-width:0">${esc(d.original_filename)} <span style="color:#999">· ${DOC_TYPE_LABEL[d.document_type] || d.document_type} · ${(Number(d.file_size) / 1024).toFixed(0)} KB${d.visible_to_customer ? " · 👁 cliente" : ""}</span></span>
      <button class="link-btn" data-dl="${d.id}">Ver</button>
      <button class="link-btn ghost" data-del="${d.id}">Borrar</button>
    </div>`).join("");
  } catch (error) {
    list.textContent = "No se pudieron cargar los documentos: " + error.message;
  }
}
function wireDocuments(id) {
  fetchJson("/api/admin/documents/status").then((s) => {
    const note = document.getElementById("docsStatusNote");
    if (!note) return;
    if (s.provider !== "google" || !s.configured) {
      note.innerHTML = `⚠ Almacenamiento actual: <b>${esc(s.provider)}</b>${s.configured ? "" : " (sin configurar)"}. Para guardar en Google Drive hay que conectar Drive y setear las variables de entorno. Máx ${s.maxMb} MB.`;
      note.style.color = "var(--danger,#c8102e)";
    } else {
      note.textContent = `Almacenamiento: Google Drive · máx ${s.maxMb} MB por archivo.`;
      note.style.color = "var(--muted)";
    }
  }).catch(() => {});
  loadDocs(id);
  document.getElementById("docUploadBtn").addEventListener("click", async () => {
    const f = document.getElementById("docFile").files[0];
    const msg = document.getElementById("docMsg");
    if (!f) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Elegí un archivo."; return; }
    const qs = new URLSearchParams({
      documentType: document.getElementById("docType").value,
      orderId: id,
      filename: f.name,
      visibleToCustomer: String(document.getElementById("docVisible").checked)
    });
    msg.style.color = "var(--muted)"; msg.textContent = "Subiendo...";
    try {
      const r = await fetch(`/api/admin/documents?${qs}`, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.detail || body.error || "error");
      msg.style.color = "var(--success,#137333)"; msg.textContent = "Subido ✓";
      document.getElementById("docFile").value = "";
      document.getElementById("docVisible").checked = false;
      loadDocs(id);
    } catch (error) {
      msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "No se pudo subir: " + error.message;
    }
  });
  document.getElementById("docsList").addEventListener("click", async (e) => {
    const dl = e.target.closest("[data-dl]");
    const del = e.target.closest("[data-del]");
    if (dl) { window.open(`/api/documents/${dl.dataset.dl}/download`, "_blank"); return; }
    if (del) {
      if (!confirm("¿Borrar este documento? Se marca como eliminado (el archivo en Drive no se borra por ahora).")) return;
      try { await deleteJson(`/api/admin/documents/${del.dataset.del}`); loadDocs(id); }
      catch (error) { alert("No se pudo borrar: " + error.message); }
    }
  });
}

// Drag-and-drop para reordenar las líneas de la cotización. El arrastre sólo
// arranca desde el handle (⠿) para no interferir con los inputs de la fila.
// Persiste al soltar SIN re-renderizar, así no se pierden ediciones sin guardar.
let qItemDragEl = null;
function rowDragAfter(tbody, y) {
  const els = [...tbody.querySelectorAll("tr[data-item]:not(.dragging)")];
  let closest = { offset: -Infinity, el: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}
function wireQuoteItemsDnD(id) {
  const body = document.getElementById("quoteItemsBody");
  if (!body) return;
  body.addEventListener("mousedown", (e) => {
    const row = e.target.closest("tr[data-item]");
    if (row && e.target.closest(".q-handle")) row.setAttribute("draggable", "true");
  });
  body.addEventListener("dragstart", (e) => {
    const row = e.target.closest("tr[data-item]");
    if (!row || row.getAttribute("draggable") !== "true") return;
    qItemDragEl = row;
    row.classList.add("dragging");
  });
  body.addEventListener("dragover", (e) => {
    if (!qItemDragEl) return;
    e.preventDefault();
    const after = rowDragAfter(body, e.clientY);
    if (after == null) body.appendChild(qItemDragEl);
    else body.insertBefore(qItemDragEl, after);
  });
  body.addEventListener("dragend", async () => {
    if (!qItemDragEl) return;
    qItemDragEl.classList.remove("dragging");
    qItemDragEl.removeAttribute("draggable");
    qItemDragEl = null;
    const orderedIds = [...body.querySelectorAll("tr[data-item]")].map((r) => r.dataset.item);
    const msg = document.getElementById("quoteSaveMsg");
    try {
      await putJson(`/api/admin/quotes/${id}/items/order`, { orderedIds });
      if (msg) { msg.style.color = "var(--success,#137333)"; msg.textContent = "Orden de líneas guardado ✓"; }
    } catch (error) {
      if (msg) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "No se pudo guardar el orden: " + (error.body?.detail || error.message); }
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
  const orders = billingOrders.filter((o) => {
    if (billingFilter === "por_cobrar") return o.payState !== "pagada";
    if (billingFilter === "pagados") return o.payState === "pagada";
    return true;
  });
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
  const billingSel = document.getElementById("billingFilter");
  if (billingSel) billingSel.addEventListener("change", (e) => { billingFilter = e.target.value; renderBillingTable(); });
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
