import { fetchJson, patchJson, putJson, money, STOCK_LABEL } from "/assets/api.js";

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

async function loadMe() {
  const { user } = await fetchJson("/api/me");
  if (!user) return (location.href = "/login");
  if (user.role !== "admin") return (location.href = "/");
  document.getElementById("adminName").textContent = user.display_name || user.email;
  document.getElementById("adminEmail").textContent = user.email;
}

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
          <td>${p.name}</td>
          <td>${p.brand}</td>
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
          <td>${u.email}</td>
          <td>${u.company_name || "-"}</td>
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
        (q) => `<div class="activity-item" style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f1f3;font-size:12.5px">
          <span><strong>#${q.request_number}</strong> · ${q.display_name || q.email}</span>
          <span class="tabular" style="color:var(--muted)">${money(q.displayed_subtotal)}</span>
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
          <span>${entry.action} · ${entry.entity_type}</span>
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

// ==================== Navegación entre secciones ====================

const sectionLoaders = { products: loadProducts, clients: loadClients, quotes: loadQuotes };
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
  const amount = Number(text.replace(/\./g, "").replace(",", "."));
  if (!Number.isNaN(amount) && text.match(/^[\d.,]+$/)) return { state: "value", amount, currency: "ARS" };
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
          <td><input class="cell-input" data-field="order" type="number" value="${p.sort_order ?? ""}" style="width:64px"></td>
          <td style="font-family:var(--font-mono)">${p.sku}</td>
          <td>${p.name}</td>
          <td>${p.brand}</td>
          <td><input class="cell-input" data-field="one" value="${priceInputValue(p.prices.one)}" style="width:110px"></td>
          <td><input class="cell-input" data-field="four" value="${priceInputValue(p.prices.four)}" style="width:110px"></td>
          <td><input class="cell-input" data-field="eight" value="${priceInputValue(p.prices.eight)}" style="width:110px"></td>
          <td style="text-align:center"><input data-field="visible" type="checkbox" ${p.visible ? "checked" : ""}></td>
          <td><button class="link-btn" data-action="save">Guardar</button></td>
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
  const btn = e.target.closest('button[data-action="save"]');
  if (!btn) return;
  const row = btn.closest("tr");
  const id = row.dataset.id;
  const get = (field) => row.querySelector(`[data-field="${field}"]`);
  btn.disabled = true;
  btn.textContent = "Guardando...";
  try {
    await patchJson(`/api/admin/products/${id}`, {
      sortOrder: get("order").value === "" ? undefined : Number(get("order").value),
      visible: get("visible").checked
    });
    for (const tier of ["one", "four", "eight"]) {
      await putJson(`/api/admin/products/${id}/prices/${tier}`, priceBodyFromInput(get(tier).value));
    }
    btn.textContent = "Guardado ✓";
    setTimeout(() => (btn.textContent = "Guardar"), 1500);
  } catch (error) {
    alert("No se pudo guardar: " + error.message);
    btn.textContent = "Guardar";
  } finally {
    btn.disabled = false;
  }
});

// ==================== Clientes ====================

const ROLE_LABEL = { admin: "Admin", customer: "Cliente" };
const STATUS_LABEL = { pending: "Pendiente", approved: "Aprobado", rejected: "Rechazado" };
const STATUS_PILL = { pending: "pending", approved: "approved", rejected: "rejected" };

async function loadClients() {
  const status = document.getElementById("clientStatusFilter").value;
  const { users } = await fetchJson(`/api/admin/users${status ? `?status=${status}` : ""}`);
  const body = document.getElementById("clientsBody");
  body.innerHTML =
    users
      .map(
        (u) => `<tr data-id="${u.id}">
          <td>${u.email}</td>
          <td>${u.display_name || "-"}</td>
          <td>${u.company_name || "-"}</td>
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

const QUOTE_STATUS_LABEL = { submitted: "Enviada", quoted: "Cotizada", accepted: "Aceptada", rejected: "Rechazada", expired: "Vencida" };

async function loadQuotes() {
  const { quotes } = await fetchJson("/api/admin/quotes");
  const body = document.getElementById("quotesBody");
  body.innerHTML =
    quotes
      .map(
        (q) => `<tr data-id="${q.id}" style="cursor:pointer">
          <td><strong>#${q.request_number}</strong></td>
          <td>${q.display_name || q.email}${q.company_name ? `<br><span style="color:var(--muted);font-size:11.5px">${q.company_name}</span>` : ""}</td>
          <td><span class="status-pill ${q.status === "submitted" ? "pending" : "approved"}">${QUOTE_STATUS_LABEL[q.status] || q.status}</span></td>
          <td class="tabular">${money(q.displayed_subtotal)}</td>
          <td>${timeAgo(q.submitted_at)}</td>
        </tr>`
      )
      .join("") || '<tr><td colspan="5" class="empty-row">Todavía no hay cotizaciones.</td></tr>';
}

document.getElementById("quotesBody").addEventListener("click", async (e) => {
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  const { quote, items } = await fetchJson(`/api/quotes/${row.dataset.id}`);
  document.getElementById("quoteDetailTitle").textContent = `Detalle #${quote.request_number}`;
  document.getElementById("quoteDetailBody").className = "";
  document.getElementById("quoteDetailBody").innerHTML = `
    ${quote.customer_notes ? `<p style="font-size:12.5px;color:var(--muted);margin-bottom:10px"><b>Notas del cliente:</b> ${quote.customer_notes}</p>` : ""}
    <div style="overflow-x:auto">
      <table>
        <thead><tr><th>SKU</th><th>Producto</th><th>Cant.</th><th>Tier</th><th>Precio unit.</th><th>Stock al enviar</th></tr></thead>
        <tbody>
          ${items
            .map(
              (i) => `<tr>
                <td style="font-family:var(--font-mono)">${i.sku_snapshot}</td>
                <td>${i.product_name_snapshot}</td>
                <td class="tabular">${i.quantity}</td>
                <td>${{ one: "1 u", four: "4 u", eight: "8 u" }[i.pricing_tier] || i.pricing_tier}</td>
                <td class="tabular">${money(i.quoted_unit_price)}</td>
                <td>${STOCK_LABEL[i.stock_status_at_submit] || i.stock_status_at_submit}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <p style="text-align:right;margin-top:10px;font-size:14px"><b>Subtotal exhibido: ${money(quote.displayed_subtotal)}</b></p>`;
});

(async function init() {
  await loadMe();
  await loadStockHealth();
  await refreshKpis();
  await loadAudit();
})();
