import { fetchJson, patchJson, money } from "/assets/api.js";

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

(async function init() {
  await loadMe();
  await loadStockHealth();
  await refreshKpis();
  await loadAudit();
})();
