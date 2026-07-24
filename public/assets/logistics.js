import { fetchJson, postJson } from "/assets/api.js";

function esc(v) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

async function loadMe() {
  const { user } = await fetchJson("/api/me");
  if (!user) return (location.href = "/login");
  document.getElementById("logiUser").textContent = user.display_name || user.email;
}

async function loadOrders() {
  const box = document.getElementById("logiOrders");
  try {
    const { orders } = await fetchJson("/api/logistics/orders");
    if (!orders.length) { box.innerHTML = '<p style="color:var(--muted)">No hay pedidos autorizados para preparación.</p>'; return; }
    box.innerHTML = `<div style="overflow-x:auto"><table class="req-table">
      <thead><tr><th>#</th><th>Cliente</th><th>Destino</th><th>Estado</th><th></th></tr></thead>
      <tbody>${orders.map((o) => `<tr>
        <td><b>#${o.request_number}</b></td>
        <td>${esc(o.company_name || o.display_name || "")} ${o.client_code ? `<span style="color:var(--muted)">(${esc(o.client_code)})</span>` : ""}</td>
        <td>${esc([o.ship_street, o.ship_number, o.ship_city, o.ship_province].filter(Boolean).join(" ")) || "-"}</td>
        <td>${esc(o.logistics_status)}</td>
        <td><button class="btn-primary sm" data-open="${o.id}" data-num="${o.request_number}">Preparar</button></td>
      </tr>`).join("")}</tbody></table></div>`;
    box.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openOrder(b.dataset.open, b.dataset.num)));
  } catch (error) { box.innerHTML = `<p style="color:var(--danger,#c8102e)">No se pudo cargar: ${esc(error.message)}</p>`; }
}

async function openOrder(id, num) {
  const d = document.getElementById("logiDetail");
  d.innerHTML = "Cargando...";
  const { order, items, serials } = await fetchJson(`/api/logistics/orders/${id}`);
  const byItem = {};
  serials.forEach((s) => { (byItem[s.order_item_id] = byItem[s.order_item_id] || []).push(s); });
  d.innerHTML = `<div class="panel">
    <h2 style="margin:0 0 4px">Pedido #${esc(num)} — ${esc(order.company_name || order.display_name || "")}</h2>
    <p style="color:var(--muted);font-size:12.5px">Envío: ${esc([order.ship_street, order.ship_number, order.ship_floor, order.ship_apartment, order.ship_postal_code, order.ship_city, order.ship_province].filter(Boolean).join(" ")) || "sin dirección"} · Tel ${esc(order.ship_phone || "-")}</p>
    </div>
    ${items.map((it) => itemHtml(it, byItem[it.id] || [])).join("")}`;
  wireItems(id, num);
}

function itemHtml(it, serials) {
  const warn = Number(it.serial_count) < Number(it.prepared_quantity);
  const assigned = serials.filter((s) => s.status === "assigned");
  return `<div class="panel" style="margin-top:12px" data-item="${it.id}">
    <div><b>${esc(it.product_name_snapshot)}</b> <span style="color:var(--muted)">${esc(it.sku_snapshot)}</span></div>
    <div style="font-size:12.5px;margin:8px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span>Confirmada: <b>${it.quantity}</b></span>
      <span>Preparada: <input type="number" class="prepQty" value="${it.prepared_quantity}" min="0" max="${it.quantity}" style="width:64px"></span>
      <button class="link-btn savePrep" type="button">Guardar cant.</button>
      <span>Seriales: <b>${it.serial_count}</b> de ${it.prepared_quantity}</span>
    </div>
    ${warn ? '<div style="font-size:12px;color:#9a3412;margin-bottom:6px">Hay unidades preparadas sin número de serie registrado. Esto no impide continuar.</div>' : ""}
    <div style="margin-bottom:6px">${assigned.map((s) => `<span style="display:inline-flex;gap:4px;align-items:center;background:#f0f0f0;border-radius:6px;padding:3px 8px;margin:2px;font-size:12px;font-family:var(--font-mono)">${esc(s.serial_number)} <button class="link-btn ghost delSerial" data-sid="${s.id}" style="padding:0 4px">✕</button></span>`).join("") || '<span style="color:var(--muted);font-size:12px">Sin seriales registrados</span>'}</div>
    <details><summary style="cursor:pointer;font-size:12.5px;color:var(--brand-red,#c8102e);font-weight:600">+ Agregar números de serie</summary>
      <textarea class="serialInput" rows="3" placeholder="Un número por línea (podés pegar una lista o escanear)" style="width:100%;margin-top:6px;padding:8px;border:1px solid var(--border);border-radius:7px;font-family:var(--font-mono);font-size:12.5px"></textarea>
      <div style="display:flex;gap:8px;align-items:center"><button class="btn-primary sm addSerials" type="button">Agregar</button><span class="serialMsg" style="font-size:12px"></span></div>
    </details>
  </div>`;
}

function wireItems(orderId, num) {
  const d = document.getElementById("logiDetail");
  d.querySelectorAll("[data-item]").forEach((panel) => {
    const itemId = panel.dataset.item;
    panel.querySelector(".savePrep").addEventListener("click", async () => {
      try { await fetchJson(`/api/logistics/order-items/${itemId}/prepared`, { method: "PATCH", body: JSON.stringify({ quantity: Number(panel.querySelector(".prepQty").value) }) }); openOrder(orderId, num); }
      catch (e) { alert("No se pudo: " + (e.body?.detail || e.message)); }
    });
    panel.querySelector(".addSerials").addEventListener("click", async () => {
      const msg = panel.querySelector(".serialMsg");
      const serials = panel.querySelector(".serialInput").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (!serials.length) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = "Ingresá al menos uno."; return; }
      try { await postJson(`/api/logistics/order-items/${itemId}/serials`, { serials }); openOrder(orderId, num); }
      catch (e) { msg.style.color = "var(--danger,#c8102e)"; msg.textContent = e.body?.detail || e.message; }
    });
    panel.querySelectorAll(".delSerial").forEach((b) => b.addEventListener("click", async () => {
      const reason = prompt("Motivo para quitar el serial:"); if (reason === null) return;
      try { await fetchJson(`/api/logistics/serials/${b.dataset.sid}`, { method: "DELETE", body: JSON.stringify({ reason }) }); openOrder(orderId, num); }
      catch (e) { alert("No se pudo: " + (e.body?.detail || e.message)); }
    }));
  });
}

(async function init() { await loadMe(); await loadOrders(); })();
