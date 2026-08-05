const STYLE_ID = "progressive-finance-styles";
const PAYMENT_METHODS = [
  ["bank_transfer", "Transferencia", "Comprobante bancario o transferencia"],
  ["cash", "Efectivo", "Cobro recibido en efectivo"],
  ["echeq", "eCheq", "Cheque electrónico recibido"],
  ["other", "Otro", "Otro medio de pago"]
];

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .simple-finance-card { position: relative; }
    .simple-finance-card > h4 { margin-bottom: 4px !important; }
    .simple-finance-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:8px 0 10px; }
    .simple-finance-primary { min-height:40px; padding:0 16px; border-radius:9px; font-weight:700; }
    .simple-finance-menu { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; padding:10px; margin:0 0 10px; border:1px solid var(--border,#e5e5e5); border-radius:12px; background:var(--surface,#fff); box-shadow:0 8px 24px rgba(0,0,0,.07); }
    .simple-finance-menu[hidden] { display:none; }
    .simple-finance-method { display:flex; flex-direction:column; align-items:flex-start; gap:2px; padding:11px 12px; border:1px solid var(--border,#e3e3e3); border-radius:9px; background:#fff; cursor:pointer; text-align:left; color:inherit; }
    .simple-finance-method:hover { border-color:var(--brand-red,#c8102e); background:var(--brand-red-soft,#fff2f4); }
    .simple-finance-method strong { font-size:13px; }
    .simple-finance-method small { color:var(--muted,#6b7280); font-size:11px; }
    .simple-finance-form { margin:10px 0 0; padding:12px; border:1px solid var(--border,#e5e5e5); border-radius:12px; background:#fff; }
    .simple-finance-form > summary { display:none; }
    .simple-finance-form-title { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; font-size:13px; }
    .simple-finance-history { margin:0 0 10px; border:0; }
    .simple-finance-history > summary { cursor:pointer; color:var(--muted,#6b7280); font-size:12px; font-weight:600; list-style:none; }
    .simple-finance-history > summary::-webkit-details-marker { display:none; }
    .simple-finance-history > summary::before { content:"›"; display:inline-block; margin-right:6px; transition:transform .15s ease; }
    .simple-finance-history[open] > summary::before { transform:rotate(90deg); }
    .simple-finance-history-body { margin-top:8px; padding:9px 10px; border-radius:9px; background:var(--surface-muted,#f7f7f8); }
    .simple-finance-history-group + .simple-finance-history-group { margin-top:10px; padding-top:10px; border-top:1px solid var(--border,#e5e5e5); }
    .simple-finance-history-label { margin-bottom:5px; font-size:11px; font-weight:700; color:var(--muted,#6b7280); text-transform:uppercase; letter-spacing:.04em; }
    .simple-finance-inline-settings { margin:0 0 10px !important; padding:9px; border-radius:9px; background:var(--surface-muted,#f7f7f8); }
    .simple-finance-close { margin-left:auto; }
    #echeqSection.simple-finance-absorbed { display:none !important; }
    @media (max-width:680px) {
      .simple-finance-menu { grid-template-columns:1fr; }
      .simple-finance-toolbar .btn-primary { width:100%; }
    }
  `;
  document.head.appendChild(style);
}

function directChildDetails(section) {
  return [...section.children].find((node) => node.tagName === "DETAILS") || null;
}

function makeHistory(summaryText, groups) {
  const details = document.createElement("details");
  details.className = "simple-finance-history";
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  const body = document.createElement("div");
  body.className = "simple-finance-history-body";
  groups.forEach(({ label, node }) => {
    if (!node) return;
    const group = document.createElement("div");
    group.className = "simple-finance-history-group";
    if (label) {
      const heading = document.createElement("div");
      heading.className = "simple-finance-history-label";
      heading.textContent = label;
      group.appendChild(heading);
    }
    group.appendChild(node);
    body.appendChild(group);
  });
  details.append(summary, body);
  return details;
}

function addFormHeading(details, title, actionButton) {
  if (!details || details.querySelector(":scope > .simple-finance-form-title")) return;
  details.classList.add("simple-finance-form");
  const heading = document.createElement("div");
  heading.className = "simple-finance-form-title";
  const label = document.createElement("strong");
  label.textContent = title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "link-btn ghost simple-finance-close";
  close.textContent = "Cerrar";
  close.addEventListener("click", () => {
    details.open = false;
    actionButton?.setAttribute("aria-expanded", "false");
  });
  heading.append(label, close);
  const summary = [...details.children].find((node) => node.tagName === "SUMMARY");
  if (summary?.nextSibling) details.insertBefore(heading, summary.nextSibling);
  else details.appendChild(heading);
}

function simplifyInvoices() {
  const section = document.getElementById("financeSection");
  if (!section || section.dataset.progressiveFinance === "1") return;
  section.dataset.progressiveFinance = "1";
  section.classList.add("simple-finance-card");

  const title = [...section.children].find((node) => node.tagName === "H4");
  const formDetails = directChildDetails(section);
  const list = document.getElementById("finInvoicesList");
  if (!title || !formDetails || !list) return;

  const toolbar = document.createElement("div");
  toolbar.className = "simple-finance-toolbar";
  const action = document.createElement("button");
  action.type = "button";
  action.id = "simpleInvoiceAction";
  action.className = "btn-primary simple-finance-primary";
  action.textContent = "Cargar factura";
  action.setAttribute("aria-expanded", "false");
  toolbar.appendChild(action);

  const history = makeHistory("Ver facturas cargadas", [{ label: "Facturas", node: list }]);
  title.after(toolbar);
  toolbar.after(history);
  history.after(formDetails);

  const conditionRow = document.getElementById("finPayCond")?.closest("div");
  if (conditionRow && conditionRow !== section) {
    conditionRow.classList.add("simple-finance-inline-settings");
    const grid = formDetails.querySelector(".form-grid");
    if (grid) formDetails.insertBefore(conditionRow, grid);
  }

  addFormHeading(formDetails, "Datos de la factura", action);
  action.addEventListener("click", () => {
    formDetails.open = !formDetails.open;
    action.setAttribute("aria-expanded", String(formDetails.open));
    if (formDetails.open) formDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function paymentMethodMenu(action, genericDetails, echeqDetails) {
  const menu = document.createElement("div");
  menu.className = "simple-finance-menu";
  menu.hidden = true;

  PAYMENT_METHODS.forEach(([value, label, description]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "simple-finance-method";
    button.dataset.paymentMethod = value;
    button.innerHTML = `<strong>${label}</strong><small>${description}</small>`;
    if (value === "echeq") button.hidden = true;
    button.addEventListener("click", () => {
      menu.hidden = true;
      action.setAttribute("aria-expanded", "false");
      if (value === "echeq") {
        genericDetails.open = false;
        echeqDetails.open = true;
        echeqDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      echeqDetails.open = false;
      const select = document.getElementById("payMethod");
      if (select) select.value = value;
      const title = genericDetails.querySelector(".simple-finance-form-title strong");
      if (title) title.textContent = `Datos del pago · ${label}`;
      genericDetails.open = true;
      genericDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    menu.appendChild(button);
  });
  return menu;
}

function simplifyPayments() {
  const section = document.getElementById("paymentsSection");
  const echeqSection = document.getElementById("echeqSection");
  if (!section || !echeqSection || section.dataset.progressiveFinance === "1") return;
  section.dataset.progressiveFinance = "1";
  section.classList.add("simple-finance-card");
  echeqSection.classList.add("simple-finance-absorbed");

  const title = [...section.children].find((node) => node.tagName === "H4");
  const genericDetails = directChildDetails(section);
  const echeqDetails = directChildDetails(echeqSection);
  const paymentsList = document.getElementById("paymentsList");
  const echeqList = document.getElementById("echeqList");
  if (!title || !genericDetails || !echeqDetails || !paymentsList || !echeqList) return;

  const toolbar = document.createElement("div");
  toolbar.className = "simple-finance-toolbar";
  const action = document.createElement("button");
  action.type = "button";
  action.id = "simplePaymentAction";
  action.className = "btn-primary simple-finance-primary";
  action.textContent = "Informar pago";
  action.setAttribute("aria-expanded", "false");
  toolbar.appendChild(action);

  const menu = paymentMethodMenu(action, genericDetails, echeqDetails);
  const history = makeHistory("Ver pagos registrados", [
    { label: "Pagos", node: paymentsList },
    { label: "eCheqs", node: echeqList }
  ]);

  title.after(toolbar);
  toolbar.after(menu);
  menu.after(history);
  history.after(genericDetails);
  genericDetails.after(echeqDetails);

  addFormHeading(genericDetails, "Datos del pago", action);
  addFormHeading(echeqDetails, "Datos del eCheq", action);

  action.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    action.setAttribute("aria-expanded", String(!menu.hidden));
  });

  const echeqButton = menu.querySelector('[data-payment-method="echeq"]');
  const echeqHistoryGroup = echeqList.closest(".simple-finance-history-group");
  const syncEcheqAvailability = () => {
    const disabled = Boolean(echeqSection.hidden);
    if (echeqButton) echeqButton.hidden = disabled;
    if (echeqHistoryGroup) echeqHistoryGroup.hidden = disabled;
    if (disabled) echeqDetails.open = false;
  };
  setTimeout(syncEcheqAvailability, 350);
  new MutationObserver(syncEcheqAvailability).observe(echeqSection, { attributes: true, attributeFilter: ["hidden"] });
}

let scheduled = false;
function scheduleEnhancement() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    simplifyInvoices();
    simplifyPayments();
  });
}

injectStyles();
scheduleEnhancement();
new MutationObserver(scheduleEnhancement).observe(document.body, { childList: true, subtree: true });
