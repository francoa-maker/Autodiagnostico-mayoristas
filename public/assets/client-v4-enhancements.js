const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (value) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(Number(value || 0));
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);

async function fetchJson(url) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function installWideLayoutAndLogo() {
  if (!qs('link[data-client-v4-wide]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/client-v4-wide.css?v=20260731-r2";
    link.dataset.clientV4Wide = "true";
    document.head.appendChild(link);
  }

  const mark = qs(".cat-logo-mark");
  if (mark && !mark.querySelector("img")) {
    mark.replaceChildren();
    const image = document.createElement("img");
    image.src = "/assets/autodiagnostico-mark.svg?v=20260731-r2";
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    mark.appendChild(image);
  }
}

function syncCartBadge() {
  const source = qs("#cartCount");
  const target = qs("#headerCartBadge");
  if (!source || !target) return;
  const update = () => { target.textContent = source.textContent || "0"; };
  update();
  new MutationObserver(update).observe(source, { childList: true, characterData: true, subtree: true });
}

function setupShellNavigation() {
  qs("#requestNavBtn")?.addEventListener("click", () => qs("#cartBtn")?.click());
  qs("#featuredBtn")?.addEventListener("click", () => qs('[data-quick="novedades"]')?.click());
  qs("#consultProfileBtn")?.addEventListener("click", () => {
    qs("#consultMenu").hidden = true;
    qs("#myDataBtn")?.click();
  });

  const menuButton = qs("#consultMenuBtn");
  const menu = qs("#consultMenu");
  menuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".consult-menu-wrap") && menu) {
      menu.hidden = true;
      menuButton?.setAttribute("aria-expanded", "false");
    }
  });
}

function setupCutoff() {
  const output = qs("#cutoffTimer");
  if (!output) return;
  const tick = () => {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setHours(18, 0, 0, 0);
    let seconds = Math.max(0, Math.floor((cutoff - now) / 1000));
    if (seconds === 0) {
      output.textContent = "cerrado";
      return;
    }
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    seconds %= 3600;
    const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    output.textContent = `${hours}:${minutes}:${secs}`;
  };
  tick();
  setInterval(tick, 1000);
}

function movementValue(movement, keys) {
  for (const key of keys) {
    if (movement?.[key] !== undefined && movement?.[key] !== null) return movement[key];
  }
  return null;
}

function renderAccount({ balance = {}, movements = [] }) {
  const body = qs("#accountBody");
  if (!body) return;
  const debt = Number(balance.debt || 0);
  const overdue = Number(balance.overdue || 0);
  const toDue = Number(balance.toDue || balance.to_due || 0);
  const inFavor = Number(balance.inFavor || balance.in_favor || 0);
  const pending = Number(balance.pendingAccreditation || balance.pending_accreditation || 0);
  qs("#miniDebt").textContent = money(debt);
  qs("#miniCredit").textContent = money(inFavor);

  const rows = movements.map((movement) => {
    const date = movementValue(movement, ["movement_date", "date", "created_at", "issued_at"]);
    const reference = movementValue(movement, ["reference", "document_number", "movement_type", "source_type"]) || "—";
    const description = movementValue(movement, ["description", "concept", "notes"]) || "Movimiento de cuenta";
    const debit = Number(movementValue(movement, ["debit_amount", "debit", "debe"]) || 0);
    const credit = Number(movementValue(movement, ["credit_amount", "credit", "haber"]) || 0);
    const running = movementValue(movement, ["running_balance", "balance_after", "saldo"]);
    return `<tr>
      <td>${date ? new Date(date).toLocaleDateString("es-AR") : "—"}</td>
      <td>${escapeHtml(reference)}</td>
      <td>${escapeHtml(description)}</td>
      <td style="text-align:right">${debit ? money(debit) : "—"}</td>
      <td style="text-align:right;color:#16a34a">${credit ? money(credit) : "—"}</td>
      <td style="text-align:right"><b>${running !== null ? money(running) : "—"}</b></td>
    </tr>`;
  }).join("");

  body.innerHTML = `
    <div class="account-kpis">
      <div class="account-kpi debt"><span>Deuda</span><b>${money(debt)}</b></div>
      <div class="account-kpi debt"><span>Vencido</span><b>${money(overdue)}</b></div>
      <div class="account-kpi"><span>A vencer</span><b>${money(toDue)}</b></div>
      <div class="account-kpi credit"><span>A favor</span><b>${money(inFavor)}</b></div>
      <div class="account-kpi"><span>eCheqs pend.</span><b>${money(pending)}</b></div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px"><button class="btn-primary" id="accountStatementBtn" type="button">Estado de cuenta</button></div>
    <div style="overflow:auto"><table class="account-table"><thead><tr><th>Fecha</th><th>Comprobante</th><th>Concepto</th><th style="text-align:right">Debe</th><th style="text-align:right">Haber</th><th style="text-align:right">Saldo</th></tr></thead><tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#8a8a90;padding:28px">Sin movimientos disponibles.</td></tr>'}</tbody></table></div>`;
  qs("#accountStatementBtn")?.addEventListener("click", () => window.open("/api/account/statement", "_blank"));
}

async function loadAccountMini() {
  try {
    const status = await fetchJson("/api/finance/status");
    if (!status.currentAccount) return;
    const account = await fetchJson("/api/account");
    qs("#miniDebt").textContent = money(account.balance?.debt || 0);
    qs("#miniCredit").textContent = money(account.balance?.inFavor || account.balance?.in_favor || 0);
  } catch {
    // La cuenta corriente puede estar deshabilitada sin afectar el catálogo.
  }
}

function setupAccountModal() {
  const overlay = qs("#accountOverlay");
  const close = () => { overlay.hidden = true; };
  qs("#accountClose")?.addEventListener("click", close);
  overlay?.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  qs("#accountBtn")?.addEventListener("click", async () => {
    qs("#consultMenu").hidden = true;
    overlay.hidden = false;
    qs("#accountBody").innerHTML = '<div class="loading-row">Cargando…</div>';
    try {
      const status = await fetchJson("/api/finance/status");
      if (!status.currentAccount) {
        qs("#accountBody").innerHTML = '<div class="loading-row">La cuenta corriente todavía no está habilitada para este portal.</div>';
        return;
      }
      renderAccount(await fetchJson("/api/account"));
    } catch (error) {
      qs("#accountBody").innerHTML = `<div class="loading-row" style="color:#c8102e">No se pudo cargar la cuenta: ${escapeHtml(error.message)}</div>`;
    }
  });
}

async function loadIdentity() {
  try {
    const { user } = await fetchJson("/api/me");
    if (!user) return;
    const name = user.company_name || user.display_name || user.email || "Cliente";
    qs("#topCompany").textContent = name;
    qs("#accountSubtitle").textContent = [name, user.tax_cuit].filter(Boolean).join(" · ") || "Estado de cuenta";
  } catch {
    // catalog.js maneja la redirección de sesión.
  }
}

function boot() {
  installWideLayoutAndLogo();
  syncCartBadge();
  setupShellNavigation();
  setupCutoff();
  setupAccountModal();
  loadIdentity();
  loadAccountMini();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
