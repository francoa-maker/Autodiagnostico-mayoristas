const STYLE_ID = "progressive-finance-styles";
const HUB_ID = "financeActionHub";
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
    .finance-action-hub {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin: 2px 0 4px;
    }
    .finance-action-choice {
      min-height: 108px;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 20px;
      border: 1px solid var(--border,#e3e3e3);
      border-radius: 15px;
      background: #fff;
      color: inherit;
      cursor: pointer;
      text-align: left;
      box-shadow: 0 4px 16px rgba(0,0,0,.045);
      transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease, background .15s ease;
    }
    .finance-action-choice:hover {
      transform: translateY(-1px);
      border-color: var(--brand-red,#c8102e);
      box-shadow: 0 8px 24px rgba(0,0,0,.08);
    }
    .finance-action-choice.is-active {
      border-color: var(--brand-red,#c8102e);
      background: var(--brand-red-soft,#fff2f4);
      box-shadow: 0 0 0 2px rgba(200,16,46,.09);
    }
    .finance-action-icon {
      width: 48px;
      height: 48px;
      flex: 0 0 48px;
      display: grid;
      place-items: center;
      border-radius: 13px;
      background: var(--surface-muted,#f5f5f6);
      font-size: 24px;
    }
    .finance-action-choice.is-active .finance-action-icon { background: #fff; }
    .finance-action-copy { display:flex; flex-direction:column; gap:3px; }
    .finance-action-copy strong { font-size: 16px; }
    .finance-action-copy small { color: var(--muted,#6b7280); font-size: 12px; line-height:1.35; }

    .finance-flow-panel {
      grid-column: 1 / -1;
      display: none !important;
      margin-top: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
    }
    .finance-flow-panel.is-open { display: block !important; }
    .finance-flow-panel > h4 { display: none !important; }
    .finance-flow-card {
      margin-top: 12px;
      padding: 18px;
      border: 1px solid var(--border,#e3e3e3);
      border-radius: 15px;
      background: #fff;
      box-shadow: 0 6px 20px rgba(0,0,0,.045);
    }
    .finance-flow-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border,#ececec);
    }
    .finance-flow-header-copy { flex:1; min-width:0; }
    .finance-flow-header-copy strong { display:block; font-size:15px; }
    .finance-flow-header-copy small { display:block; margin-top:2px; color:var(--muted,#6b7280); font-size:11.5px; }
    .finance-flow-close { margin-left:auto; white-space:nowrap; }

    .finance-flow-form {
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
    }
    .finance-flow-form > summary { display:none; }
    .finance-form-heading {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:10px;
      margin-bottom:10px;
      font-size:13px;
    }
    .finance-form-heading .link-btn { margin-left:auto; }

    .finance-method-menu {
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:9px;
      margin-bottom:12px;
    }
    .finance-method-menu[hidden] { display:none; }
    .finance-method-choice {
      display:flex;
      flex-direction:column;
      align-items:flex-start;
      gap:3px;
      padding:13px;
      border:1px solid var(--border,#e3e3e3);
      border-radius:10px;
      background:#fff;
      color:inherit;
      cursor:pointer;
      text-align:left;
    }
    .finance-method-choice:hover {
      border-color:var(--brand-red,#c8102e);
      background:var(--brand-red-soft,#fff2f4);
    }
    .finance-method-choice strong { font-size:13px; }
    .finance-method-choice small { color:var(--muted,#6b7280); font-size:11px; }

    .finance-history {
      margin-top:13px;
      border-top:1px solid var(--border,#ececec);
      padding-top:11px;
    }
    .finance-history > summary,
    .finance-secondary-details > summary {
      cursor:pointer;
      color:var(--muted,#6b7280);
      font-size:12px;
      font-weight:600;
      list-style:none;
    }
    .finance-history > summary::-webkit-details-marker,
    .finance-secondary-details > summary::-webkit-details-marker { display:none; }
    .finance-history > summary::before,
    .finance-secondary-details > summary::before {
      content:"›";
      display:inline-block;
      margin-right:6px;
      transition:transform .15s ease;
    }
    .finance-history[open] > summary::before,
    .finance-secondary-details[open] > summary::before { transform:rotate(90deg); }
    .finance-history-body,
    .finance-secondary-body {
      margin-top:9px;
      padding:10px;
      border-radius:10px;
      background:var(--surface-muted,#f7f7f8);
    }
    .finance-history-group + .finance-history-group {
      margin-top:10px;
      padding-top:10px;
      border-top:1px solid var(--border,#e5e5e5);
    }
    .finance-history-label {
      margin-bottom:5px;
      font-size:11px;
      font-weight:700;
      color:var(--muted,#6b7280);
      text-transform:uppercase;
      letter-spacing:.04em;
    }
    .finance-inline-settings {
      margin:0 0 12px !important;
      padding:10px;
      border-radius:10px;
      background:var(--surface-muted,#f7f7f8);
    }
    .finance-secondary-details { margin-top:12px; }
    #accountSection.finance-embedded-section {
      margin:0 !important;
      padding:0 !important;
      border:0 !important;
      background:transparent !important;
      box-shadow:none !important;
    }
    #accountSection.finance-embedded-section > h4 { display:none; }
    #echeqSection.finance-legacy-shell { display:none !important; }

    @media (max-width:680px) {
      .finance-action-hub,
      .finance-method-menu { grid-template-columns:1fr; }
      .finance-action-choice { min-height:88px; padding:15px; }
      .finance-flow-card { padding:14px; }
    }
  `;
  document.head.appendChild(style);
}

function directChildDetails(section) {
  return [...section.children].find((node) => node.tagName === "DETAILS") || null;
}

function makeHistory(summaryText, groups) {
  const details = document.createElement("details");
  details.className = "finance-history";
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  const body = document.createElement("div");
  body.className = "finance-history-body";

  groups.forEach(({ label, node }) => {
    if (!node) return;
    const group = document.createElement("div");
    group.className = "finance-history-group";
    if (label) {
      const heading = document.createElement("div");
      heading.className = "finance-history-label";
      heading.textContent = label;
      group.appendChild(heading);
    }
    group.appendChild(node);
    body.appendChild(group);
  });

  details.append(summary, body);
  return details;
}

function makePanelHeader(title, subtitle) {
  const header = document.createElement("div");
  header.className = "finance-flow-header";
  const copy = document.createElement("div");
  copy.className = "finance-flow-header-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("small");
  small.textContent = subtitle;
  copy.append(strong, small);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "link-btn ghost finance-flow-close";
  close.textContent = "Cerrar";
  header.append(copy, close);
  return { header, close };
}

function addPaymentFormHeading(details, title, onBack) {
  details.classList.add("finance-flow-form");
  const heading = document.createElement("div");
  heading.className = "finance-form-heading";
  const label = document.createElement("strong");
  label.textContent = title;
  const back = document.createElement("button");
  back.type = "button";
  back.className = "link-btn ghost";
  back.textContent = "Cambiar medio";
  back.addEventListener("click", onBack);
  heading.append(label, back);

  const summary = [...details.children].find((node) => node.tagName === "SUMMARY");
  if (summary?.nextSibling) details.insertBefore(heading, summary.nextSibling);
  else details.appendChild(heading);
  return label;
}

function buildInvoiceFlow(section) {
  const title = [...section.children].find((node) => node.tagName === "H4");
  const form = directChildDetails(section);
  const invoicesList = document.getElementById("finInvoicesList");
  if (!title || !form || !invoicesList) return null;

  section.classList.add("finance-flow-panel");
  const card = document.createElement("div");
  card.className = "finance-flow-card";
  const { header, close } = makePanelHeader("Cargar factura", "Completá los datos del comprobante y adjuntá el archivo cuando corresponda.");
  const history = makeHistory("Ver facturas cargadas", [{ label: "Facturas", node: invoicesList }]);

  const conditionRow = document.getElementById("finPayCond")?.closest("div");
  if (conditionRow && conditionRow !== section) {
    conditionRow.classList.add("finance-inline-settings");
    const grid = form.querySelector(".form-grid");
    if (grid) form.insertBefore(conditionRow, grid);
  }

  form.classList.add("finance-flow-form");
  form.open = true;
  card.append(header, form, history);
  section.appendChild(card);

  return {
    section,
    form,
    history,
    close,
    open() {
      section.classList.add("is-open");
      form.open = true;
      history.open = false;
      setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
    },
    hide() {
      section.classList.remove("is-open");
      form.open = false;
      history.open = false;
    }
  };
}

function makePaymentMethodMenu(genericForm, echeqForm) {
  const menu = document.createElement("div");
  menu.className = "finance-method-menu";
  menu.hidden = true;
  let genericTitle = null;

  const showMenu = () => {
    genericForm.open = false;
    echeqForm.open = false;
    menu.hidden = false;
  };

  genericTitle = addPaymentFormHeading(genericForm, "Datos del pago", showMenu);
  addPaymentFormHeading(echeqForm, "Datos del eCheq", showMenu);

  PAYMENT_METHODS.forEach(([value, label, description]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "finance-method-choice";
    button.dataset.paymentMethod = value;
    button.innerHTML = `<strong>${label}</strong><small>${description}</small>`;
    if (value === "echeq") button.hidden = true;

    button.addEventListener("click", () => {
      menu.hidden = true;
      if (value === "echeq") {
        genericForm.open = false;
        echeqForm.open = true;
        echeqForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      echeqForm.open = false;
      const select = document.getElementById("payMethod");
      if (select) select.value = value;
      if (genericTitle) genericTitle.textContent = `Datos del pago · ${label}`;
      genericForm.open = true;
      genericForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    menu.appendChild(button);
  });

  return { menu, showMenu };
}

function makeAccountDetails(accountSection) {
  const details = document.createElement("details");
  details.className = "finance-secondary-details";
  const summary = document.createElement("summary");
  summary.textContent = "Ver cuenta corriente del cliente";
  const body = document.createElement("div");
  body.className = "finance-secondary-body";
  accountSection.classList.add("finance-embedded-section");
  body.appendChild(accountSection);
  details.append(summary, body);

  const sync = () => {
    details.hidden = Boolean(accountSection.hidden);
    if (details.hidden) details.open = false;
  };
  sync();
  new MutationObserver(sync).observe(accountSection, { attributes: true, attributeFilter: ["hidden"] });
  return details;
}

function buildPaymentFlow(section, echeqSection, accountSection) {
  const title = [...section.children].find((node) => node.tagName === "H4");
  const genericForm = directChildDetails(section);
  const echeqForm = directChildDetails(echeqSection);
  const paymentsList = document.getElementById("paymentsList");
  const echeqList = document.getElementById("echeqList");
  if (!title || !genericForm || !echeqForm || !paymentsList || !echeqList) return null;

  section.classList.add("finance-flow-panel");
  echeqSection.classList.add("finance-legacy-shell");
  genericForm.classList.add("finance-flow-form");
  echeqForm.classList.add("finance-flow-form");
  genericForm.open = false;
  echeqForm.open = false;

  const card = document.createElement("div");
  card.className = "finance-flow-card";
  const { header, close } = makePanelHeader("Cargar pago", "Elegí el medio y completá únicamente los datos correspondientes.");
  const { menu, showMenu } = makePaymentMethodMenu(genericForm, echeqForm);
  const history = makeHistory("Ver pagos registrados", [
    { label: "Pagos", node: paymentsList },
    { label: "eCheqs", node: echeqList }
  ]);
  const accountDetails = accountSection ? makeAccountDetails(accountSection) : null;

  card.append(header, menu, genericForm, echeqForm, history);
  if (accountDetails) card.appendChild(accountDetails);
  section.appendChild(card);

  const echeqButton = menu.querySelector('[data-payment-method="echeq"]');
  const echeqHistoryGroup = echeqList.closest(".finance-history-group");
  const syncEcheq = () => {
    const disabled = Boolean(echeqSection.hidden);
    if (echeqButton) echeqButton.hidden = disabled;
    if (echeqHistoryGroup) echeqHistoryGroup.hidden = disabled;
    if (disabled) echeqForm.open = false;
  };
  syncEcheq();
  new MutationObserver(syncEcheq).observe(echeqSection, { attributes: true, attributeFilter: ["hidden"] });

  return {
    section,
    genericForm,
    echeqForm,
    menu,
    history,
    accountDetails,
    close,
    open() {
      section.classList.add("is-open");
      history.open = false;
      if (accountDetails) accountDetails.open = false;
      showMenu();
      setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
    },
    hide() {
      section.classList.remove("is-open");
      genericForm.open = false;
      echeqForm.open = false;
      menu.hidden = true;
      history.open = false;
      if (accountDetails) accountDetails.open = false;
    }
  };
}

function makeHub() {
  const hub = document.createElement("div");
  hub.id = HUB_ID;
  hub.className = "finance-action-hub";

  const invoiceButton = document.createElement("button");
  invoiceButton.type = "button";
  invoiceButton.className = "finance-action-choice";
  invoiceButton.dataset.financeAction = "invoice";
  invoiceButton.setAttribute("aria-pressed", "false");
  invoiceButton.innerHTML = '<span class="finance-action-icon" aria-hidden="true">🧾</span><span class="finance-action-copy"><strong>Cargar factura</strong><small>Registrar el comprobante y sus vencimientos</small></span>';

  const paymentButton = document.createElement("button");
  paymentButton.type = "button";
  paymentButton.className = "finance-action-choice";
  paymentButton.dataset.financeAction = "payment";
  paymentButton.setAttribute("aria-pressed", "false");
  paymentButton.innerHTML = '<span class="finance-action-icon" aria-hidden="true">$</span><span class="finance-action-copy"><strong>Cargar pago</strong><small>Transferencia, efectivo, eCheq u otro medio</small></span>';

  hub.append(invoiceButton, paymentButton);
  return { hub, invoiceButton, paymentButton };
}

function setupFinancialActions() {
  if (document.getElementById(HUB_ID)) return;
  const invoiceSection = document.getElementById("financeSection");
  const paymentSection = document.getElementById("paymentsSection");
  const echeqSection = document.getElementById("echeqSection");
  const accountSection = document.getElementById("accountSection");
  if (!invoiceSection || !paymentSection || !echeqSection) return;

  const parent = invoiceSection.parentElement;
  if (!parent || paymentSection.parentElement !== parent) return;

  const invoiceFlow = buildInvoiceFlow(invoiceSection);
  const paymentFlow = buildPaymentFlow(paymentSection, echeqSection, accountSection);
  if (!invoiceFlow || !paymentFlow) return;

  const { hub, invoiceButton, paymentButton } = makeHub();
  parent.insertBefore(hub, invoiceSection);

  const setFlow = (flow) => {
    invoiceFlow.hide();
    paymentFlow.hide();
    invoiceButton.classList.toggle("is-active", flow === "invoice");
    paymentButton.classList.toggle("is-active", flow === "payment");
    invoiceButton.setAttribute("aria-pressed", String(flow === "invoice"));
    paymentButton.setAttribute("aria-pressed", String(flow === "payment"));
    if (flow === "invoice") invoiceFlow.open();
    if (flow === "payment") paymentFlow.open();
  };

  invoiceButton.addEventListener("click", () => setFlow("invoice"));
  paymentButton.addEventListener("click", () => setFlow("payment"));
  invoiceFlow.close.addEventListener("click", () => setFlow(null));
  paymentFlow.close.addEventListener("click", () => setFlow(null));
  setFlow(null);
}

let scheduled = false;
function scheduleEnhancement() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    setupFinancialActions();
  });
}

injectStyles();
scheduleEnhancement();
new MutationObserver(scheduleEnhancement).observe(document.body, { childList: true, subtree: true });
