import { linkFinanceStyles, closeFinanceDrawer, currentDrawerOrderId } from "./finance-common.js";
import { readFinanceContext } from "./finance-context.js";
import { openInvoiceDrawer } from "./finance-invoice-drawer.js";
import { openPaymentDrawer } from "./finance-payment-drawer.js";

const HUB_ID = "financeActionHub";
let scheduled = false;

function makeAction({ action, icon, title, description }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "finance-action-choice";
  button.dataset.financeAction = action;
  button.innerHTML = `<span class="finance-action-icon" aria-hidden="true">${icon}</span><span class="finance-action-copy"><strong>${title}</strong><small>${description}</small></span>`;
  return button;
}

function removeStaleHub() {
  const hub = document.getElementById(HUB_ID);
  if (hub) hub.remove();
  closeFinanceDrawer();
}

function mountFinanceHub() {
  const context = readFinanceContext();
  const invoiceSection = document.getElementById("financeSection");
  const paymentSection = document.getElementById("paymentsSection");
  if (!context?.orderId || !invoiceSection?.isConnected || !paymentSection?.isConnected) return;
  if (!invoiceSection.closest("#billingDetailBody") || invoiceSection.hidden || paymentSection.hidden) return;

  const current = document.getElementById(HUB_ID);
  if (current?.dataset.orderId === context.orderId) return;
  current?.remove();
  if (currentDrawerOrderId() && currentDrawerOrderId() !== context.orderId) closeFinanceDrawer();

  const parent = invoiceSection.parentElement;
  if (!parent || paymentSection.parentElement !== parent) return;

  const hub = document.createElement("div");
  hub.id = HUB_ID;
  hub.className = "finance-action-hub";
  hub.dataset.orderId = context.orderId;
  const invoiceButton = makeAction({
    action: "invoice",
    icon: "🧾",
    title: "Cargar factura",
    description: "Comprobante, datos fiscales y vencimientos"
  });
  const paymentButton = makeAction({
    action: "payment",
    icon: "$",
    title: "Cargar pago",
    description: "Transferencia, efectivo, eCheq u otro medio"
  });
  invoiceButton.addEventListener("click", () => openInvoiceDrawer({ ...context }));
  paymentButton.addEventListener("click", () => openPaymentDrawer({ ...context }));
  hub.append(invoiceButton, paymentButton);
  parent.insertBefore(hub, invoiceSection);
}

function scheduleMount() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    mountFinanceHub();
  });
}

linkFinanceStyles();
document.addEventListener("finance:context", scheduleMount);
document.addEventListener("finance:context-cleared", removeStaleHub);
new MutationObserver(scheduleMount).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
scheduleMount();
