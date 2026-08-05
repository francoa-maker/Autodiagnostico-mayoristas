import {
  esc, getFinanceStatus, getDocumentsStatus, openFinanceDrawer, closeFinanceDrawer,
  drawerFooter, mountDropzone, uploadDocument, mountMirroredHistory,
  postJson, patchJson, money, friendly, notify, localIsoDate
} from "./finance-common.js";
import {
  CLIENT_PAYMENT_TERMS, paymentTermLabelClient, buildInstallments,
  validateInstallments, absorbRemainder, maxInstallments,
  canonicalInvoiceLabel, padPointOfSale, padInvoiceNumber
} from "./finance-math.js";
import { updatePaymentCondition, refreshFinanceOrder } from "./finance-context.js";

const CONDITION_LABELS = {
  contado: "Contado", transferencia_anticipada: "Transferencia anticipada",
  efectivo: "Efectivo", cuenta_corriente: "Cuenta corriente", echeq: "eCheq",
  mixto: "Pago mixto", personalizado: "Personalizada"
};

export async function openInvoiceDrawer(ctx) {
  const status = await getFinanceStatus();
  if (!status?.financial) return;
  const docs = await getDocumentsStatus();
  const maxBytes = Number(docs?.maxMb || 25) * 1024 * 1024;
  const drawer = openFinanceDrawer({ title: "Cargar factura", subtitle: "Primero el comprobante; después los datos y los vencimientos.", orderId: ctx.orderId });
  const knownTerm = CLIENT_PAYMENT_TERMS.includes(ctx.paymentTerms) ? ctx.paymentTerms : "contado";
  const state = {
    step: 1, file: null, documentId: null,
    type: status.invoiceTypes?.includes("B") ? "B" : (status.invoiceTypes?.[0] || "B"),
    pointOfSale: "", number: "", issueDate: localIsoDate(), total: "",
    term: knownTerm, condition: ctx.paymentCondition || "", saveDefault: false,
    count: 1, rows: [], visible: false
  };
  const typeOptions = (status.invoiceTypes || ["A", "B", "C"]).map((value) => `<option value="${esc(value)}"${value === state.type ? " selected" : ""}>${esc(value)}</option>`).join("");
  const termOptions = CLIENT_PAYMENT_TERMS.map((value) => `<option value="${esc(value)}"${value === state.term ? " selected" : ""}>${esc(paymentTermLabelClient(value))}</option>`).join("");
  const conditionOptions = ['<option value="">(sin definir)</option>'].concat((status.paymentConditions || []).map((value) => `<option value="${esc(value)}"${value === state.condition ? " selected" : ""}>${esc(CONDITION_LABELS[value] || value)}</option>`)).join("");

  drawer.body.innerHTML = `
    <section class="fin-step" data-step="1">
      <div id="invoiceDropzone"></div><p class="fin-hint">PDF o imagen. Podés arrastrarlo, pegarlo o elegirlo.</p>
      ${docs?.configured === false ? '<div class="fin-callout">El almacenamiento no está configurado. Podés continuar sin comprobante.</div>' : ""}
      <div class="fin-actions-row"><button type="button" class="btn-primary" data-next>Continuar</button><button type="button" class="link-btn ghost" data-skip>Cargar sin comprobante</button></div>
    </section>
    <section class="fin-step" data-step="2" hidden>
      <div class="fin-group"><span class="fin-group-label">Comprobante</span><div class="fin-comprobante">
        <label>Tipo<select id="invoiceType">${typeOptions}</select></label>
        <label>Punto de venta<input id="invoicePos" inputmode="numeric" placeholder="0001"></label>
        <label>Número<input id="invoiceNumber" inputmode="numeric" placeholder="00000123"></label>
        <output class="fin-canonical" id="invoiceCanonical">${esc(state.type)}</output>
      </div></div>
      <div class="fin-group"><div class="fin-grid"><label>Fecha de emisión<input id="invoiceIssue" type="date" value="${esc(state.issueDate)}"></label><label>Total<input id="invoiceTotal" type="number" step="0.01" min="0" placeholder="0.00"></label></div></div>
      <div class="fin-group"><span class="fin-group-label">Condición comercial</span><div class="fin-grid"><label>Condición de pago<select id="invoiceCondition">${conditionOptions}</select></label><label class="fin-checkline"><input type="checkbox" id="invoiceSaveDefault"> Guardar como habitual del cliente</label></div></div>
      <div class="fin-group"><span class="fin-group-label">Vencimientos</span>
        ${ctx.paymentTerms && !CLIENT_PAYMENT_TERMS.includes(ctx.paymentTerms) ? `<div class="fin-callout">El pedido tiene “${esc(ctx.paymentTerms)}” como plazo libre. Elegí un plazo compatible.</div>` : ""}
        <div class="fin-grid fin-top-gap"><label>Plazo<select id="invoiceTerm">${termOptions}</select></label><label>Cuotas<input id="invoiceCount" type="number" min="1" step="1" value="1"></label></div>
        <div id="invoiceRows" class="fin-top-gap"></div><button type="button" class="link-btn ghost" data-add-row>+ Agregar vencimiento</button><div class="fin-inst-sum" id="invoiceSum"></div>
      </div>
      <div class="fin-group"><label class="fin-switch"><input type="checkbox" id="invoiceVisible"><span class="track" aria-hidden="true"></span><span class="switch-copy">Visible para el cliente<small>La factura y el comprobante aparecerán en su portal.</small></span></label></div>
      <div class="fin-callout bad" id="invoiceError" hidden></div><button type="button" class="link-btn ghost" data-back>&larr; Volver al comprobante</button><div id="invoiceHistory"></div>
    </section>`;

  const drop = mountDropzone(drawer.body.querySelector("#invoiceDropzone"), {
    maxBytes, label: "Soltá acá la factura", hint: "o hacé click para elegir el archivo",
    onChange: (file) => { state.file = file; state.documentId = null; refresh(); }
  });
  const disposeHistory = mountMirroredHistory(drawer.body.querySelector("#invoiceHistory"), {
    summary: "Ver facturas cargadas", groups: [{ sourceId: "finInvoicesList", label: "Facturas" }], orderId: ctx.orderId
  });
  const oldCleanup = drawer.cleanup;
  drawer.cleanup = () => { oldCleanup(); drop.dispose(); disposeHistory(); };
  const stepOne = drawer.body.querySelector('[data-step="1"]');
  const stepTwo = drawer.body.querySelector('[data-step="2"]');
  const rowsHost = drawer.body.querySelector("#invoiceRows");
  const sumHost = drawer.body.querySelector("#invoiceSum");
  const errorHost = drawer.body.querySelector("#invoiceError");
  const submit = drawerFooter(drawer, { primaryLabel: "Cargar factura", onPrimary: submitInvoice });

  function setStep(value) {
    state.step = value; stepOne.hidden = value !== 1; stepTwo.hidden = value !== 2; submit.hidden = value !== 2; refresh();
    if (value === 2) drawer.body.querySelector("#invoiceTotal")?.focus();
  }
  function readRows() {
    return [...rowsHost.querySelectorAll(".fin-inst-row")].map((row) => ({ dueDate: row.querySelector(".row-date").value, amount: row.querySelector(".row-amount").value }));
  }
  function renderRows() {
    rowsHost.innerHTML = state.rows.length ? state.rows.map((row, index) => `<div class="fin-inst-row" data-row="${index}"><input type="date" class="row-date" value="${esc(row.dueDate || "")}" aria-label="Vencimiento ${index + 1}"><input type="number" step="0.01" min="0" class="row-amount" value="${row.amount ?? ""}" aria-label="Monto ${index + 1}"><button type="button" class="fin-inst-del" data-delete-row="${index}" aria-label="Quitar vencimiento ${index + 1}">&times;</button></div>`).join("") : '<p class="fin-hint">Ingresá el total para armar los vencimientos.</p>';
    refresh();
  }
  function regenerate() {
    const total = Number(state.total);
    if (!Number.isFinite(total) || total <= 0) { state.rows = []; renderRows(); return; }
    state.count = Math.min(Math.max(1, state.count), maxInstallments(total));
    drawer.body.querySelector("#invoiceCount").value = String(state.count);
    state.rows = buildInstallments(state.term, state.issueDate, total, state.count);
    renderRows();
  }
  function evaluate() {
    const total = Number(state.total);
    if (state.step !== 2) return { ok: false, why: "" };
    if (!Number.isFinite(total) || total <= 0) return { ok: false, why: "Falta el total." };
    if (!state.issueDate) return { ok: false, why: "Falta la fecha de emisión." };
    if (!state.number.trim()) return { ok: false, why: "Falta el número de comprobante." };
    const check = validateInstallments(state.rows, total, state.issueDate);
    if (!check.ok) {
      if (check.code === "suma_cuotas_distinta_al_total") {
        const difference = check.diff > 0 ? `faltan ${money(check.diff, ctx.currency)}` : `sobran ${money(Math.abs(check.diff), ctx.currency)}`;
        return { ok: false, why: `Los vencimientos suman ${money(check.sum, ctx.currency)}: ${difference}.`, check };
      }
      return { ok: false, why: "Revisá las fechas y montos de los vencimientos.", check };
    }
    return { ok: true, why: "", check };
  }
  function refresh() {
    drawer.body.querySelector("#invoiceCanonical").textContent = canonicalInvoiceLabel(state.type, state.pointOfSale, state.number);
    const total = Number(state.total);
    const validation = evaluate();
    if (state.rows.length && Number.isFinite(total) && total > 0) {
      const check = validation.check || validateInstallments(state.rows, total, state.issueDate);
      sumHost.innerHTML = `<span>Suma: <b>${esc(money(check.sum || 0, ctx.currency))}</b></span><span class="${check.ok ? "is-ok" : "is-bad"}">${check.ok ? "coincide con el total" : esc(validation.why)}</span>${check.ok ? "" : '<button type="button" class="link-btn ghost" data-absorb>Repartir el resto</button>'}`;
      sumHost.querySelector("[data-absorb]")?.addEventListener("click", () => { state.rows = absorbRemainder(state.rows, total); renderRows(); });
    } else sumHost.innerHTML = "";
    const parts = [canonicalInvoiceLabel(state.type, state.pointOfSale, state.number)];
    if (Number.isFinite(total) && total > 0) parts.push(money(total, ctx.currency));
    if (state.rows.length) parts.push(`${state.rows.length} vencimiento${state.rows.length === 1 ? "" : "s"}`);
    parts.push(state.file ? `con ${state.file.name}` : "sin comprobante");
    drawer.footSum.innerHTML = `<b>${esc(parts.filter(Boolean).join(" · "))}</b>${validation.why ? `<span class="why">${esc(validation.why)}</span>` : ""}`;
    submit.disabled = !validation.ok;
  }

  drawer.body.querySelector("[data-next]").addEventListener("click", () => setStep(2));
  drawer.body.querySelector("[data-skip]").addEventListener("click", () => { state.file = null; setStep(2); });
  drawer.body.querySelector("[data-back]").addEventListener("click", () => setStep(1));
  drawer.body.querySelector("#invoiceType").addEventListener("change", (event) => { state.type = event.target.value; refresh(); });
  drawer.body.querySelector("#invoicePos").addEventListener("input", (event) => { state.pointOfSale = event.target.value; refresh(); });
  drawer.body.querySelector("#invoicePos").addEventListener("blur", (event) => { event.target.value = padPointOfSale(event.target.value); state.pointOfSale = event.target.value; refresh(); });
  drawer.body.querySelector("#invoiceNumber").addEventListener("input", (event) => { state.number = event.target.value; refresh(); });
  drawer.body.querySelector("#invoiceNumber").addEventListener("blur", (event) => { event.target.value = padInvoiceNumber(event.target.value); state.number = event.target.value; refresh(); });
  drawer.body.querySelector("#invoiceIssue").addEventListener("change", (event) => { state.issueDate = event.target.value; regenerate(); });
  drawer.body.querySelector("#invoiceTotal").addEventListener("input", (event) => { state.total = event.target.value; regenerate(); });
  drawer.body.querySelector("#invoiceTerm").addEventListener("change", (event) => { state.term = event.target.value; regenerate(); });
  drawer.body.querySelector("#invoiceCondition").addEventListener("change", (event) => { state.condition = event.target.value; refresh(); });
  drawer.body.querySelector("#invoiceSaveDefault").addEventListener("change", (event) => { state.saveDefault = event.target.checked; });
  drawer.body.querySelector("#invoiceCount").addEventListener("change", (event) => { state.count = Math.max(1, Math.floor(Number(event.target.value) || 1)); regenerate(); });
  drawer.body.querySelector("#invoiceVisible").addEventListener("change", (event) => { state.visible = event.target.checked; refresh(); });
  drawer.body.querySelector("[data-add-row]").addEventListener("click", () => { state.rows = [...readRows(), { dueDate: "", amount: "" }]; state.count = state.rows.length; renderRows(); });
  rowsHost.addEventListener("input", () => { state.rows = readRows(); refresh(); });
  rowsHost.addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-row]");
    if (!button || state.rows.length <= 1) return;
    state.rows = readRows(); state.rows.splice(Number(button.dataset.deleteRow), 1); state.count = state.rows.length; renderRows();
  });

  async function submitInvoice(button) {
    const validation = evaluate();
    if (!validation.ok) return;
    button.disabled = true; errorHost.hidden = true; button.textContent = "Cargando...";
    try {
      if (state.file && !state.documentId) state.documentId = await uploadDocument(state.file, { documentType: "factura", orderId: ctx.orderId, visibleToCustomer: state.visible });
      if (state.condition !== (ctx.paymentCondition || "") || state.saveDefault) {
        await patchJson(`/api/admin/orders/${ctx.orderId}/payment-condition`, { condition: state.condition || null, saveAsClientDefault: state.saveDefault });
        updatePaymentCondition(state.condition); ctx.paymentCondition = state.condition;
      }
      await postJson(`/api/admin/orders/${ctx.orderId}/invoices`, {
        invoiceType: state.type, pointOfSale: state.pointOfSale.trim() || null,
        invoiceNumber: state.number.trim() || null, issueDate: state.issueDate,
        totalAmount: Number(state.total), currency: ctx.currency,
        installments: validation.check.installments, visibleToCustomer: state.visible, documentId: state.documentId
      });
      closeFinanceDrawer(); refreshFinanceOrder(ctx.orderId);
      notify(`Factura ${canonicalInvoiceLabel(state.type, state.pointOfSale, state.number)} cargada.`);
    } catch (error) {
      errorHost.hidden = false;
      errorHost.textContent = state.documentId ? `No se pudo completar: ${friendly(error)} El archivo ya quedó subido y no se volverá a enviar.` : `No se pudo completar: ${friendly(error)}`;
      button.disabled = false; button.textContent = "Cargar factura";
    }
  }
  renderRows(); setStep(1);
}
