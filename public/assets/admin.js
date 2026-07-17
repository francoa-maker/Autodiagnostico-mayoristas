import { fetchJson, postJson, patchJson, putJson, money, STOCK_LABEL } from "/assets/api.js";

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

async function deleteJson(url) {
  return fetchJson(url, { method: "DELETE" });
}

async function loadMe() {
  const { user } = await fetchJson("/api/me");
  if (!user) return (location.href = "/login");
  if (user.role !== "admin") return (location.href = "/");
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
  return quotes.filter((q) => q.status === "submitted").length;
}

async function loadAudit() {
  const { entries } = await fetchJson("/api/admin/audit");
  const el = document.getElementById("auditFeed");
  el.innerHTML =
    entries
      .slice(0, 8)
      .map(
        (entry) => `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f1f3;font-size:12.5px">
          <span>${esc(entry.action)} · ${esc(entry.entity_type)}</span>
          <span style="color:var(--muted)">${timeAgo(entry.created_at)}</span>
        </div>`
      )
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

const sectionLoaders = { products: loadProducts, clients: loadClients, quotes: loadQuotes, settings: loadCompanyProfile };
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
      visible: get("visible").dataset.visible === "true"
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

// ==================== Clientes ====================

const ROLE_LABEL = { admin: "Admin", customer: "Cliente" };
const STATUS_LABEL = { pending: "Pendiente", approved: "Aprobado", rejected: "Rechazado", blocked: "Bloqueado" };
const STATUS_PILL = { pending: "pending", approved: "approved", rejected: "rejected", blocked: "blocked" };

async function loadClients() {
  const status = document.getElementById("clientStatusFilter").value;
  const { users } = await fetchJson(`/api/admin/users${status ? `?status=${status}` : ""}`);
  const body = document.getElementById("clientsBody");
  body.innerHTML =
    users
      .map(
        (u) => `<tr data-id="${u.id}">
          <td>${esc(u.email)}</td>
          <td>${esc(u.display_name || "-")}</td>
          <td>${esc(u.company_name || "-")}</td>
          <td>${ROLE_LABEL[u.role] || u.role}</td>
          <td><span class="status-pill ${STATUS_PILL[u.status] || "pending"}">${STATUS_LABEL[u.status] || u.status}</span></td>
          <td>${timeAgo(u.created_at)}</td>
          <td>${timeAgo(u.last_login_at)}</td>
          <td style="display:flex;gap:6px;flex-wrap:wrap">
            ${u.status !== "approved" ? '<button class="link-btn" data-action="approve">Aprobar</button>' : ""}
            ${u.status !== "rejected" ? '<button class="link-btn ghost" data-action="reject">Rechazar</button>' : ""}
            ${u.role === "customer" ? '<button class="link-btn ghost" data-action="make-admin">Hacer admin</button>' : '<button class="link-btn ghost" data-action="make-customer">Quitar admin</button>'}
          </td>
        </tr>`
      )
      .join("") || '<tr><td colspan="8" class="empty-row">No hay usuarios con ese filtro.</td></tr>';
}

document.getElementById("clientStatusFilter").addEventListener("change", loadClients);

document.getElementById("clientsBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest("tr").dataset.id;
  const payload = {
    approve: { status: "approved" },
    reject: { status: "rejected" },
    "make-admin": { role: "admin" },
    "make-customer": { role: "customer" }
  }[btn.dataset.action];
  btn.disabled = true;
  try {
    await patchJson(`/api/admin/users/${id}`, payload);
    await loadClients();
  } catch (error) {
    alert("No se pudo actualizar el usuario: " + error.message);
    btn.disabled = false;
  }
});

// ==================== Cotizaciones ====================

const QUOTE_STATUS = ["submitted", "reviewing", "quoted", "accepted", "rejected", "expired", "cancelled"];
const QUOTE_STATUS_LABEL = { submitted: "Enviada", reviewing: "En revisión", quoted: "Cotizada", accepted: "Aceptada", rejected: "Rechazada", expired: "Vencida", cancelled: "Cancelada" };

let currentQuoteId = null;

async function loadQuotes() {
  const { quotes } = await fetchJson("/api/admin/quotes");
  const body = document.getElementById("quotesBody");
  body.innerHTML =
    quotes
      .map(
        (q) => `<tr data-id="${q.id}" class="quote-row${q.id === currentQuoteId ? " active" : ""}" style="cursor:pointer">
          <td><strong>#${q.request_number}</strong></td>
          <td>${esc(q.display_name || q.email)}${q.company_name ? `<br><span style="color:var(--muted);font-size:11.5px">${esc(q.company_name)}</span>` : ""}</td>
          <td><span class="status-pill ${q.status === "submitted" ? "pending" : "approved"}">${QUOTE_STATUS_LABEL[q.status] || q.status}</span></td>
          <td class="num tabular">${money(q.quoted_total ?? q.displayed_subtotal)}</td>
          <td>${timeAgo(q.submitted_at)}</td>
        </tr>`
      )
      .join("") || '<tr><td colspan="5" class="empty-row">Todavía no hay cotizaciones.</td></tr>';
}

document.getElementById("quotesBody").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  currentQuoteId = row.dataset.id;
  document.querySelectorAll(".quote-row").forEach((r) => r.classList.toggle("active", r === row));
  renderQuoteEditor(currentQuoteId);
});

function itemUnit(it) {
  if (it.quoted_unit_price != null) return Number(it.quoted_unit_price);
  const snap = it.displayed_price_snapshot || {};
  return snap.amount != null ? Number(snap.amount) : null;
}

async function renderQuoteEditor(id) {
  const panel = document.getElementById("quoteDetailBody");
  panel.className = "";
  panel.innerHTML = "Cargando...";
  const { quote, items } = await fetchJson(`/api/admin/quotes/${id}`);
  const cur = quote.currency || "ARS";

  const itemRows = items
    .map(
      (it) => `<tr data-item="${it.id}">
        <td><span style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted)">${esc(it.sku_snapshot)}</span><br>${esc(it.product_name_snapshot)}</td>
        <td><input class="cell-input" data-f="quantity" type="number" min="1" value="${Number(it.quantity)}" style="width:60px"></td>
        <td><input class="cell-input" data-f="unitPrice" value="${itemUnit(it) ?? ""}" style="width:120px"></td>
        <td class="num tabular line-total">${itemUnit(it) != null ? money(itemUnit(it) * Number(it.quantity), cur) : "-"}</td>
        <td style="display:flex;gap:6px">
          <button class="link-btn" data-action="save-item">Guardar</button>
          <button class="link-btn ghost" data-action="del-item">Quitar</button>
        </td>
      </tr>`
    )
    .join("");

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div>
        <h3 style="margin:0">Cotización #${quote.request_number}</h3>
        <div style="font-size:12.5px;color:var(--muted);margin-top:2px">${esc(quote.company_name || quote.display_name || quote.email)} · ${esc(quote.email)}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="quoteStatus" class="admin-search" style="min-width:150px">
          ${QUOTE_STATUS.map((s) => `<option value="${s}"${quote.status === s ? " selected" : ""}>${QUOTE_STATUS_LABEL[s]}</option>`).join("")}
        </select>
        <button class="btn-primary" id="proformaBtn">Ver proforma</button>
      </div>
    </div>

    ${quote.customer_notes ? `<p style="font-size:12.5px;color:var(--muted);margin-top:10px"><b>Notas del cliente:</b> ${esc(quote.customer_notes)}</p>` : ""}

    <div style="overflow-x:auto;margin-top:14px">
      <table>
        <thead><tr><th>Producto</th><th>Cant.</th><th>Precio unit. (editable)</th><th class="num">Importe</th><th></th></tr></thead>
        <tbody id="quoteItemsBody">${itemRows || '<tr><td colspan="5" class="empty-row">Sin items. Agregá productos abajo.</td></tr>'}</tbody>
      </table>
    </div>

    <div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <input type="search" id="addProductSearch" class="admin-search" placeholder="Buscar producto para agregar..." style="flex:1;min-width:200px">
      <div id="addProductResults" class="add-results"></div>
    </div>

    <div class="quote-totals">
      <div class="qt-adjustments">
        <label>Descuento<input id="qDiscount" type="number" value="${Number(quote.discount || 0)}"></label>
        <label>Envío<input id="qShipping" type="number" value="${Number(quote.shipping || 0)}"></label>
        <label>Impuestos<input id="qTax" type="number" value="${Number(quote.tax || 0)}"></label>
      </div>
      <div class="qt-summary">
        <div><span>Subtotal</span><b id="qSubtotal">${money(quote.quoted_subtotal ?? quote.displayed_subtotal, cur)}</b></div>
        <div class="grand"><span>Total</span><b id="qTotal">${money(quote.quoted_total ?? quote.displayed_subtotal, cur)}</b></div>
      </div>
    </div>

    <label style="display:block;margin-top:14px;font-size:12.5px">Notas para el cliente (aparecen en la proforma)
      <textarea id="qPublicNotes" rows="2" class="admin-search" style="width:100%;margin-top:4px">${esc(quote.public_notes || "")}</textarea>
    </label>
    <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
      <button class="btn-primary" id="saveQuoteBtn">Guardar cotización</button>
      <span id="quoteSaveMsg" style="font-size:12.5px;color:var(--success,#137333)"></span>
    </div>
  `;

  document.getElementById("proformaBtn").addEventListener("click", () => window.open(`/api/admin/quotes/${id}/proforma`, "_blank"));
  document.getElementById("saveQuoteBtn").addEventListener("click", () => saveQuoteHeader(id));
  wireQuoteItemActions(id);
  wireAddProduct(id);
}

async function saveQuoteHeader(id) {
  const msg = document.getElementById("quoteSaveMsg");
  try {
    await patchJson(`/api/admin/quotes/${id}`, {
      status: document.getElementById("quoteStatus").value,
      discount: Number(document.getElementById("qDiscount").value || 0),
      shipping: Number(document.getElementById("qShipping").value || 0),
      tax: Number(document.getElementById("qTax").value || 0),
      publicNotes: document.getElementById("qPublicNotes").value
    });
    msg.textContent = "Guardado ✓";
    setTimeout(() => (msg.textContent = ""), 1800);
    await renderQuoteEditor(id);
    await loadQuotes();
  } catch (error) {
    alert("No se pudo guardar la cotización: " + error.message);
  }
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
          unitPrice: row.querySelector('[data-f="unitPrice"]').value
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

// ==================== Configuración (perfil de empresa) ====================

async function loadCompanyProfile() {
  const { profile } = await fetchJson("/api/admin/company-profile");
  const f = document.getElementById("companyForm");
  f.name.value = profile.name || "";
  f.legalName.value = profile.legalName || "";
  f.addressLines.value = (profile.addressLines || []).join("\n");
  f.phone.value = profile.phone || "";
  f.email.value = profile.email || "";
  f.website.value = profile.website || "";
  f.taxId.value = profile.taxId || "";
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

(async function init() {
  await loadMe();
  await loadStockHealth();
  await refreshKpis();
  await loadAudit();
})();
