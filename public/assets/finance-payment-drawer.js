import {
  esc, getFinanceStatus, getDocumentsStatus, openFinanceDrawer, closeFinanceDrawer,
  drawerFooter, mountDropzone, uploadDocument, mountMirroredHistory,
  fetchJson, postJson, money, friendly, notify, localIsoDate
} from "./finance-common.js";
import { buildPendingInstallments, fifoPrefill, round2, PAY_TILES } from "./finance-math.js";
import { refreshFinanceOrder } from "./finance-context.js";

export async function openPaymentDrawer(ctx) {
  const status = await getFinanceStatus();
  if (!status?.financial) return;
  const docs = await getDocumentsStatus();
  const maxBytes = Number(docs?.maxMb || 25) * 1024 * 1024;
  const drawer = openFinanceDrawer({ title: "Cargar pago", subtitle: "Elegí el medio y completá sólo los datos que correspondan.", orderId: ctx.orderId });
  const state = {
    method: "bank_transfer", amount: "", date: localIsoDate(), reference: "",
    payerName: "", payerTaxId: "", payerBankRef: "", status: "confirmed",
    file: null, documentId: null, allocate: true, pending: [], allocationRows: [],
    echeqNumber: "", bankName: "", issuerName: "", issuerTaxId: "", paymentDate: "", expectedCreditDate: ""
  };
  const echeqEnabled = Boolean(status.echeq);
  const tiles = PAY_TILES.map(([value, label, description]) => `<button type="button" class="pay-tile" role="radio" data-method="${esc(value)}" aria-checked="${value === state.method}"${value === "echeq" && !echeqEnabled ? " hidden" : ""}><strong>${esc(label)}</strong><small>${esc(description)}</small></button>`).join("");

  drawer.body.innerHTML = `
    <div class="fin-group"><span class="fin-group-label">Medio de pago</span><div class="pay-tiles" role="radiogroup">${tiles}</div></div>
    <div class="fin-group"><div class="fin-grid">
      <label>Monto<input id="paymentAmount" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label data-money-only>Fecha<input id="paymentDate" type="date" value="${esc(state.date)}"></label>
      <label class="full" data-money-only>Referencia<input id="paymentReference" placeholder="N° de operación, CBU, comprobante"></label>
      <label data-echeq-only hidden>N° de eCheq<input id="echeqNumber"></label><label data-echeq-only hidden>Banco<input id="echeqBank"></label>
      <label data-echeq-only hidden>Librador<input id="echeqIssuer"></label><label data-echeq-only hidden>CUIT del librador<input id="echeqIssuerTax" inputmode="numeric"></label>
      <label data-echeq-only hidden>Fecha de pago<input id="echeqPaymentDate" type="date"></label><label data-echeq-only hidden>Acreditación esperada<input id="echeqCreditDate" type="date"></label>
    </div></div>
    <div class="fin-group" data-money-only><span class="fin-group-label">Estado</span><div class="opt-row">
      <label class="opt is-sel" data-status="confirmed"><input type="radio" name="paymentStatus" value="confirmed" checked><span class="opt-copy"><strong>Confirmado</strong><small>Ya fue verificado. Genera crédito y se puede imputar.</small></span></label>
      <label class="opt" data-status="informed"><input type="radio" name="paymentStatus" value="informed"><span class="opt-copy"><strong>Informado</strong><small>Todavía no fue verificado. No genera crédito ni se imputa.</small></span></label>
    </div></div>
    <div class="fin-group"><span class="fin-group-label">Comprobante</span><div id="paymentDropzone"></div><p class="fin-hint">Opcional. PDF o imagen.</p></div>
    <details class="fin-group" data-money-only><summary class="fin-details-summary">Quién pagó (opcional)</summary><div class="fin-grid fin-top-gap"><label>Nombre<input id="payerName"></label><label>CUIT / CUIL<input id="payerTaxId" inputmode="numeric"></label><label class="full">Referencia bancaria<input id="payerBankRef"></label></div></details>
    <div class="fin-group fin-alloc" id="paymentAllocation" data-money-only><span class="fin-group-label">Imputación</span><label class="fin-switch"><input type="checkbox" id="paymentAllocate" checked><span class="track" aria-hidden="true"></span><span class="switch-copy">Imputar a las cuotas<small>Al desactivarlo queda como crédito sin aplicar.</small></span></label><div id="paymentAllocationRows" class="fin-top-gap"><p class="fin-hint">Cargando cuotas...</p></div></div>
    <div class="fin-callout" id="echeqInfo" hidden>El eCheq queda pendiente de aceptación bancaria. Recién al acreditarlo genera crédito.</div>
    <div class="fin-callout bad" id="paymentError" hidden></div><div id="paymentHistory"></div>`;

  const drop = mountDropzone(drawer.body.querySelector("#paymentDropzone"), {
    maxBytes, label: "Soltá el comprobante", hint: "o hacé click para elegirlo",
    onChange: (file) => { state.file = file; state.documentId = null; refresh(); }
  });
  const disposeHistory = mountMirroredHistory(drawer.body.querySelector("#paymentHistory"), {
    summary: "Ver pagos, eCheqs y cuenta corriente",
    groups: [
      { sourceId: "paymentsList", label: "Pagos" }, { sourceId: "echeqList", label: "eCheqs" },
      { sourceId: "accountBalance", label: "Cuenta corriente" }, { sourceId: "accountMovements", label: "Movimientos" }
    ], orderId: ctx.orderId
  });
  const oldCleanup = drawer.cleanup;
  drawer.cleanup = () => { oldCleanup(); drop.dispose(); disposeHistory(); };
  const allocation = drawer.body.querySelector("#paymentAllocation");
  const allocationRows = drawer.body.querySelector("#paymentAllocationRows");
  const errorHost = drawer.body.querySelector("#paymentError");
  const echeqInfo = drawer.body.querySelector("#echeqInfo");
  const submit = drawerFooter(drawer, { primaryLabel: "Registrar pago", onPrimary: submitPayment });
  const isEcheq = () => state.method === "echeq";

  fetchJson(`/api/admin/orders/${ctx.orderId}/invoices`).then(({ invoices }) => {
    state.pending = buildPendingInstallments(invoices); renderAllocations();
  }).catch(() => { state.pending = []; renderAllocations(); });

  function readAllocations() {
    return [...allocationRows.querySelectorAll(".alloc-amount")].map((input) => ({ installmentId: input.dataset.installment, amount: Number(input.value) })).filter((item) => Number.isFinite(item.amount) && item.amount > 0);
  }
  function renderAllocations() {
    if (!state.pending.length) {
      state.allocationRows = [];
      allocationRows.innerHTML = '<p class="fin-alloc-empty">No hay cuotas impagas. El pago queda como crédito a favor.</p>';
      refresh(); return;
    }
    state.allocationRows = fifoPrefill(state.pending, Number(state.amount) || 0);
    allocationRows.innerHTML = state.allocationRows.map((row) => `<div class="fin-alloc-row"><span>${esc(row.label)}<br><span class="debt">debe ${esc(money(row.debt, ctx.currency))}</span></span><input type="number" step="0.01" min="0" class="alloc-amount" data-installment="${esc(row.id)}" value="${row.prefill || ""}"></div>`).join("");
    refresh();
  }
  function updateMethodVisibility() {
    const echeq = isEcheq();
    drawer.body.querySelectorAll("[data-money-only]").forEach((element) => { element.hidden = echeq; });
    drawer.body.querySelectorAll("[data-echeq-only]").forEach((element) => { element.hidden = !echeq; });
    echeqInfo.hidden = !echeq;
    drawer.body.querySelectorAll(".pay-tile").forEach((tile) => tile.setAttribute("aria-checked", String(tile.dataset.method === state.method)));
  }
  function evaluate() {
    const amount = Number(state.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, why: "Falta el monto del pago." };
    if (isEcheq()) return state.echeqNumber.trim() ? { ok: true, why: "" } : { ok: false, why: "Falta el número de eCheq." };
    if (!state.date) return { ok: false, why: "Falta la fecha del pago." };
    if (state.allocate && state.status === "confirmed") {
      const allocations = readAllocations();
      const total = round2(allocations.reduce((sum, item) => sum + item.amount, 0));
      if (total > round2(amount) + 0.005) return { ok: false, why: `La imputación (${money(total, ctx.currency)}) supera el pago.` };
      const excessive = allocations.find((item) => { const row = state.allocationRows.find((candidate) => candidate.id === item.installmentId); return row && item.amount > row.debt + 0.005; });
      if (excessive) return { ok: false, why: "Una imputación supera lo que debe esa cuota." };
    }
    return { ok: true, why: "" };
  }
  function refresh() {
    const canAllocate = !isEcheq() && state.status === "confirmed";
    allocation.classList.toggle("is-off", !canAllocate || !state.allocate);
    drawer.body.querySelector("#paymentAllocate").disabled = !canAllocate;
    const validation = evaluate();
    const method = PAY_TILES.find(([value]) => value === state.method)?.[1] || state.method;
    const parts = [method];
    const amount = Number(state.amount);
    if (Number.isFinite(amount) && amount > 0) parts.push(money(amount, ctx.currency));
    if (!isEcheq()) {
      const applied = state.allocate && canAllocate ? round2(readAllocations().reduce((sum, item) => sum + item.amount, 0)) : 0;
      parts.push(applied ? `imputa ${money(applied, ctx.currency)}` : "sin imputar");
      parts.push(state.status === "confirmed" ? "confirmado" : "informado");
    }
    if (state.file) parts.push(`con ${state.file.name}`);
    drawer.footSum.innerHTML = `<b>${esc(parts.join(" · "))}</b>${validation.why ? `<span class="why">${esc(validation.why)}</span>` : ""}`;
    submit.disabled = !validation.ok;
    submit.textContent = isEcheq() ? "Registrar eCheq" : "Registrar pago";
  }

  drawer.body.querySelector(".pay-tiles").addEventListener("click", (event) => { const tile = event.target.closest(".pay-tile"); if (!tile) return; state.method = tile.dataset.method; updateMethodVisibility(); refresh(); });
  drawer.body.querySelector("#paymentAmount").addEventListener("input", (event) => { state.amount = event.target.value; isEcheq() ? refresh() : renderAllocations(); });
  drawer.body.querySelector("#paymentDate").addEventListener("change", (event) => { state.date = event.target.value; refresh(); });
  drawer.body.querySelector("#paymentReference").addEventListener("input", (event) => { state.reference = event.target.value; });
  drawer.body.querySelector("#payerName").addEventListener("input", (event) => { state.payerName = event.target.value; });
  drawer.body.querySelector("#payerTaxId").addEventListener("input", (event) => { state.payerTaxId = event.target.value; });
  drawer.body.querySelector("#payerBankRef").addEventListener("input", (event) => { state.payerBankRef = event.target.value; });
  drawer.body.querySelector("#echeqNumber").addEventListener("input", (event) => { state.echeqNumber = event.target.value; refresh(); });
  drawer.body.querySelector("#echeqBank").addEventListener("input", (event) => { state.bankName = event.target.value; });
  drawer.body.querySelector("#echeqIssuer").addEventListener("input", (event) => { state.issuerName = event.target.value; });
  drawer.body.querySelector("#echeqIssuerTax").addEventListener("input", (event) => { state.issuerTaxId = event.target.value; });
  drawer.body.querySelector("#echeqPaymentDate").addEventListener("change", (event) => { state.paymentDate = event.target.value; });
  drawer.body.querySelector("#echeqCreditDate").addEventListener("change", (event) => { state.expectedCreditDate = event.target.value; });
  drawer.body.querySelectorAll('input[name="paymentStatus"]').forEach((radio) => radio.addEventListener("change", () => {
    state.status = radio.value;
    drawer.body.querySelectorAll("[data-status]").forEach((option) => option.classList.toggle("is-sel", option.dataset.status === state.status));
    refresh();
  }));
  drawer.body.querySelector("#paymentAllocate").addEventListener("change", (event) => { state.allocate = event.target.checked; refresh(); });
  allocationRows.addEventListener("input", refresh);

  async function submitPayment(button) {
    if (!evaluate().ok) return;
    button.disabled = true; button.textContent = "Registrando..."; errorHost.hidden = true;
    try {
      if (state.file && !state.documentId) state.documentId = await uploadDocument(state.file, { documentType: isEcheq() ? "comprobante_echeq" : "comprobante_transferencia", orderId: ctx.orderId });
      if (isEcheq()) {
        await postJson(`/api/admin/orders/${ctx.orderId}/echeqs`, {
          amount: Number(state.amount), echeqNumber: state.echeqNumber.trim() || null,
          bankName: state.bankName.trim() || null, issuerName: state.issuerName.trim() || null,
          issuerTaxId: state.issuerTaxId.trim() || null, paymentDate: state.paymentDate || null,
          expectedCreditDate: state.expectedCreditDate || null, documentId: state.documentId
        });
        closeFinanceDrawer(); refreshFinanceOrder(ctx.orderId); notify("eCheq registrado."); return;
      }
      const allocations = state.allocate && state.status === "confirmed" ? readAllocations() : [];
      const payload = {
        orderId: ctx.orderId, method: state.method, amount: Number(state.amount), paymentDate: state.date || null,
        reference: state.reference.trim() || null, documentId: state.documentId,
        payerName: state.payerName.trim() || null, payerTaxId: state.payerTaxId.trim() || null,
        payerBankRef: state.payerBankRef.trim() || null, status: state.status
      };
      if (ctx.clientId) await postJson(`/api/admin/clients/${ctx.clientId}/payments`, { ...payload, allocations });
      else {
        const { payment } = await postJson(`/api/admin/orders/${ctx.orderId}/payments`, payload);
        if (allocations.length && payment?.id) await postJson(`/api/admin/payments/${payment.id}/apply`, { allocations });
      }
      closeFinanceDrawer(); refreshFinanceOrder(ctx.orderId); notify("Pago registrado.");
    } catch (error) {
      const allocationCodes = ["excede_saldo_del_pago", "excede_saldo_de_la_cuota", "cuota_no_encontrada", "factura_anulada", "cuota_de_otro_cliente", "sin_asignaciones"];
      const code = error?.body?.error || error?.message || "";
      errorHost.hidden = false;
      errorHost.textContent = allocationCodes.includes(code) ? `El pago se registró pero no se pudo imputar: ${friendly(error)} Aplicalo desde el historial.` : `No se pudo registrar: ${friendly(error)}`;
      button.disabled = false; button.textContent = isEcheq() ? "Registrar eCheq" : "Registrar pago";
    }
  }
  updateMethodVisibility(); refresh(); drawer.body.querySelector("#paymentAmount").focus();
}
