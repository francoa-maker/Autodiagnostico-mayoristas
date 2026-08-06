import { fetchJson, postJson, money as apiMoney } from "./api.js";
import { confirmDialog } from "./ui-confirm.js";
import { PAY_TILES, fifoPrefill, round2 } from "./finance-math.js";

const state = {
  mounted: false,
  clients: [], totals: {}, total: 0, offset: 0, limit: 50,
  filter: "all", search: "", sort: "pending", direction: "desc",
  currentClientId: null, current: null, tab: "installments", status: null, userRole: null
};

const q = (s, root = document) => root.querySelector(s);
const qa = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (value) => String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const dateKey = (value) => value ? String(value).slice(0,10) : "";
const today = () => {
  const d = new Date();
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
};
const fmt = (value) => value == null ? "s/d" : apiMoney(Number(value), "ARS");
const clientName = (c) => c?.company_name || c?.display_name || c?.email || "Cliente";
const notify = (message, type = "") => typeof window.v5Toast === "function" ? window.v5Toast(message, type) : window.alert(message);
const errorText = (error) => error?.body?.detail || error?.body?.error || error?.message || "Error inesperado";

function linkStyles() {
  if (q("#payments-section-css")) return;
  const link=document.createElement("link");
  link.id="payments-section-css"; link.rel="stylesheet"; link.href="/assets/payments-section.css?v=20260806-payments1";
  document.head.appendChild(link);
}

function modalOpen(html) {
  const overlay=q("#modalOverlay"), box=q("#modalBox");
  box.classList.add("pay-modal"); box.innerHTML=html; overlay.hidden=false;
}
function modalClose() {
  const overlay=q("#modalOverlay"), box=q("#modalBox");
  overlay.hidden=true; box.innerHTML=""; box.classList.remove("pay-modal");
}

async function safe(url, fallback) {
  try { return await fetchJson(url); }
  catch (error) {
    if ([403,404].includes(error.status)) return fallback;
    throw error;
  }
}

function installLegacySection() {
  const nav=q("#adminNav");
  if (!nav) return false;
  let link=q('#adminNav > a[data-section="payments"]');
  if (!link) {
    link=document.createElement("a"); link.dataset.section="payments"; link.innerHTML='<span class="ic">$</span>Pagos';
    const billing=q('#adminNav > a[data-section="billing"]');
    if (billing) billing.after(link); else nav.appendChild(link);
  }
  let section=q("#section-payments");
  if (!section) {
    section=document.createElement("div"); section.className="admin-section"; section.id="section-payments"; section.hidden=true;
    section.innerHTML=`
      <div class="admin-topline"><div><h1>Pagos</h1><p>Cobranzas, vencimientos y saldos por cliente.</p></div></div>
      <div class="v5-kpi-strip" id="payKpis"></div>
      <div class="pay-toolbar">
        <input id="paySearch" class="admin-search" type="search" placeholder="Buscar cliente, código o CUIT...">
        <button class="pay-chip active" data-pay-filter="all">Todos</button>
        <button class="pay-chip" data-pay-filter="overdue">Vencidos</button>
        <button class="pay-chip" data-pay-filter="debt">Con deuda</button>
        <button class="pay-chip" data-pay-filter="unapplied">Sin imputar</button>
        <button class="pay-chip" data-pay-filter="favor">A favor</button>
        <select id="paySort" class="admin-search"><option value="pending">Mayor saldo pendiente</option><option value="overdue">Mayor vencido</option><option value="debt">Mayor deuda</option><option value="unapplied">Mayor sin imputar</option><option value="client">Cliente</option></select>
      </div>
      <div class="pay-layout">
        <div class="panel"><div class="pay-client-list" id="payClientsBody"><div class="empty-row">Cargando...</div></div><div id="payPager" class="pay-toolbar"></div></div>
        <div class="panel" id="payDetailBody"><div class="empty-row">Seleccioná un cliente para ver la cuenta.</div></div>
      </div>`;
    q(".admin-main")?.appendChild(section);
  }
  link.addEventListener("click", () => { setTimeout(loadClients,0); setHash(); });
  return true;
}

function installV5Button() {
  const shell=q(".v5-admin-nav");
  if (!shell || q('[data-v5-admin-target="payments"]',shell)) return false;
  const button=document.createElement("button");
  button.type="button"; button.className="v5-nav-item"; button.dataset.v5AdminTarget="payments";
  button.innerHTML='<svg class="v5-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18v12H3zM3 10h18M7 15h4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg><span>Pagos</span>';
  const settings=q('[data-v5-admin-target="settings"]',shell);
  if (settings) settings.before(button); else shell.appendChild(button);
  button.addEventListener("click", showPayments);
  return true;
}

function setHash() {
  const target="#/admin/pagos";
  if (location.hash!==target) history.pushState(null,"",target);
}
function showPayments() {
  q('#adminNav > a[data-section="payments"]')?.click();
  qa("[data-v5-admin-target]").forEach((b)=>b.classList.toggle("is-active",b.dataset.v5AdminTarget==="payments"));
  const mobile=q("#v5MobileSection"); if(mobile) mobile.textContent="Pagos";
  document.body.classList.remove("v5-menu-open");
  setHash(); loadClients();
}

function bindSection() {
  let timer;
  q("#paySearch")?.addEventListener("input",(e)=>{ clearTimeout(timer); timer=setTimeout(()=>{state.search=e.target.value.trim();state.offset=0;loadClients();},250); });
  qa("[data-pay-filter]").forEach((button)=>button.addEventListener("click",()=>{
    state.filter=button.dataset.payFilter; state.offset=0;
    qa("[data-pay-filter]").forEach((b)=>b.classList.toggle("active",b===button)); loadClients();
  }));
  q("#paySort")?.addEventListener("change",(e)=>{state.sort=e.target.value;state.offset=0;loadClients();});
}

function renderKpis() {
  const t=state.totals||{};
  q("#payKpis").innerHTML=[
    ["Cartera pendiente",fmt(t.pending)],["Vencido",fmt(t.overdue)],["A vencer",fmt(t.toDue)],
    ["Sin imputar",fmt(t.unapplied)],["Saldo a favor",fmt(t.inFavor)]
  ].map(([label,value])=>`<div class="v5-kpi"><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function renderClientList() {
  const body=q("#payClientsBody");
  if(!state.clients.length){body.innerHTML='<div class="empty-row">No hay clientes para este filtro.</div>';return;}
  body.innerHTML=state.clients.map((c)=>`<button type="button" class="pay-client-row${c.id===state.currentClientId?" active":""}" data-pay-client="${c.id}">
    <span><strong>${esc(clientName(c))}</strong><small>${esc(c.client_code||"")} ${c.tax_cuit?"· CUIT "+esc(c.tax_cuit):""}</small><small>${c.open_count} cuota(s) abierta(s)${c.oldest_due?" · desde "+dateKey(c.oldest_due):""}</small></span>
    <span class="pay-amount"><strong>${fmt(c.pending_total)}</strong><small>${Number(c.overdue)>0?"Vencido "+fmt(c.overdue):"Sin vencidos"}</small>${c.ledger_total==null?'<small>Mayor s/d</small>':`<small>${Number(c.debt)>0?"Deuda "+fmt(c.debt):Number(c.in_favor)>0?"A favor "+fmt(c.in_favor):"Sin saldo"}</small>`}</span>
  </button>`).join("");
  qa("[data-pay-client]",body).forEach((button)=>button.addEventListener("click",()=>openClient(button.dataset.payClient)));
}

function renderPager() {
  const p=q("#payPager"), from=state.total?state.offset+1:0, to=Math.min(state.offset+state.limit,state.total);
  p.innerHTML=`<span class="pay-muted">${from}-${to} de ${state.total}</span><span style="flex:1"></span><button class="link-btn ghost" id="payPrev" ${state.offset<=0?"disabled":""}>Anterior</button><button class="link-btn ghost" id="payNext" ${state.offset+state.limit>=state.total?"disabled":""}>Siguiente</button>`;
  q("#payPrev")?.addEventListener("click",()=>{state.offset=Math.max(0,state.offset-state.limit);loadClients();});
  q("#payNext")?.addEventListener("click",()=>{state.offset+=state.limit;loadClients();});
}

async function loadClients() {
  if(q("#section-payments")?.hidden) return;
  const body=q("#payClientsBody"); if(body) body.innerHTML='<div class="empty-row">Cargando cartera...</div>';
  const params=new URLSearchParams({search:state.search,filter:state.filter,sort:state.sort,direction:state.direction,limit:String(state.limit),offset:String(state.offset)});
  try {
    const result=await fetchJson(`/api/admin/finance/clients?${params}`);
    Object.assign(state,{clients:result.clients||[],totals:result.totals||{},total:result.total||0,status:{ledgerAvailable:result.ledgerAvailable,echeqAvailable:result.echeqAvailable}});
    renderKpis(); renderClientList(); renderPager();
    qa('[data-pay-filter="debt"],[data-pay-filter="favor"]').forEach((button) => { button.hidden = !result.ledgerAvailable; });
    if(state.currentClientId && state.clients.some((c)=>c.id===state.currentClientId)) q(`[data-pay-client="${state.currentClientId}"]`)?.classList.add("active");
  } catch(error) { body.innerHTML=`<div class="empty-row">No se pudo cargar la cartera: ${esc(errorText(error))}</div>`; }
}

async function openClient(clientId) {
  state.currentClientId=clientId; state.tab="installments";
  renderClientList(); q("#payDetailBody").innerHTML='<div class="empty-row">Cargando cuenta...</div>';
  try {
    const [account,invoices,payments,echeqs,installments]=await Promise.all([
      safe(`/api/admin/clients/${clientId}/account`,null),
      safe(`/api/admin/clients/${clientId}/invoices`,{invoices:[]}),
      safe(`/api/admin/clients/${clientId}/payments`,{payments:[]}),
      safe(`/api/admin/clients/${clientId}/echeqs`,{echeqs:[]}),
      safe(`/api/admin/clients/${clientId}/open-installments`,{installments:[]})
    ]);
    const listed=state.clients.find((c)=>c.id===clientId)||{};
    state.current={client:account?.client||listed,balance:account?.balance||null,movements:account?.movements||[],invoices:invoices.invoices||[],payments:payments.payments||[],echeqs:echeqs.echeqs||[],installments:installments.installments||[]};
    renderDetail();
  } catch(error) { q("#payDetailBody").innerHTML=`<div class="empty-row">No se pudo cargar la cuenta: ${esc(errorText(error))}</div>`; }
}

function balanceCard(label,value,klass="") { return `<div class="pay-balance ${klass}"><span>${label}</span><strong>${fmt(value)}</strong></div>`; }
function renderDetail() {
  const d=state.current, c=d.client||{}, b=d.balance;
  const pending=d.installments.reduce((sum,row)=>sum+Number(row.debt||0),0);
  const overdue=d.installments.filter((row)=>dateKey(row.due_date)<today()).reduce((sum,row)=>sum+Number(row.debt||0),0);
  const toDue=round2(pending-overdue);
  const debt=b?b.debt:null, inFavor=b?b.inFavor:null, pendingAcc=b?b.pendingAccreditation:0;
  const discrepancy=b?round2(pending-Number(debt||0)):null;
  q("#payDetailBody").innerHTML=`
    <div class="pay-detail-head"><div><h2 style="margin:0">${esc(clientName(c))}</h2><div class="pay-muted">${esc(c.client_code||"")} ${c.tax_cuit?"· CUIT "+esc(c.tax_cuit):""} ${c.email?"· "+esc(c.email):""}</div></div>
      <div class="pay-actions"><button class="btn-primary" id="payRegisterBtn">Registrar cobro</button>${b?'<button class="link-btn" id="payCreditBtn">Generar saldo a favor</button>':""}<button class="link-btn ghost" id="payStatementBtn" ${b?"":"disabled"}>Ver estado de cuenta</button></div></div>
    <div class="pay-balance-strip">${balanceCard("Deuda",debt)}${balanceCard("Vencido",overdue)}${balanceCard("A vencer",toDue)}${balanceCard("A favor",inFavor)}${balanceCard("eCheqs pend.",pendingAcc)}</div>
    ${b&&Math.abs(discrepancy)>0.01?`<div class="pay-warning">La diferencia de ${fmt(Math.abs(discrepancy))} entre vencimientos y deuda corresponde a pagos sin imputar y/o ajustes manuales.</div>`:""}
    <div class="pay-tabs">${[["installments","Vencimientos"],["payments","Pagos"],...(state.status?.echeqAvailable?[["echeqs","eCheqs"]]:[]),["account","Cuenta corriente"],["invoices","Facturas"]].map(([id,label])=>`<button class="pay-tab${state.tab===id?" active":""}" data-pay-tab="${id}">${label}</button>`).join("")}</div>
    <div id="payTabBody"></div>`;
  q("#payRegisterBtn")?.addEventListener("click",openRegisterModal);
  q("#payCreditBtn")?.addEventListener("click",openCreditModal);
  q("#payStatementBtn")?.addEventListener("click",()=>window.open(`/api/admin/clients/${state.currentClientId}/account-statement`,"_blank"));
  qa("[data-pay-tab]").forEach((button)=>button.addEventListener("click",()=>{state.tab=button.dataset.payTab;renderDetail();}));
  renderTab();
}

function invoiceLabel(row) { return `${row.invoice_type||"Factura"} ${row.point_of_sale||""}-${row.invoice_number||"s/n"}`; }
function statusLabel(value) { return ({informed:"Informado",confirmed:"Confirmado",pending_accreditation:"Pend. acreditación",rejected:"Rechazado",reversed:"Reversado",paid:"Pagada",partially_paid:"Parcial",issued:"Emitida",overdue:"Vencida",pending:"Pendiente"})[value]||value||"-"; }

function renderTab() {
  const d=state.current, body=q("#payTabBody");
  if(state.tab==="installments") {
    body.innerHTML=d.installments.length?`<div class="pay-table-wrap"><table><thead><tr><th>Vencimiento</th><th>Pedido</th><th>Factura</th><th>Cuota</th><th class="num">Pendiente</th></tr></thead><tbody>${d.installments.map((r)=>`<tr><td><span class="v5-pill ${dateKey(r.due_date)<today()?"danger":"info"}">${dateKey(r.due_date)}</span></td><td>${r.request_number?"#"+esc(r.request_number):"Sin pedido"}</td><td>${esc(invoiceLabel(r))}</td><td>${r.installment_number}</td><td class="num">${fmt(r.debt)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty-row">El cliente no tiene vencimientos pendientes.</div>';
  } else if(state.tab==="payments") {
    body.innerHTML=d.payments.length?`<div class="pay-table-wrap"><table><thead><tr><th>Fecha</th><th>Medio</th><th>Estado</th><th>Referencia</th><th class="num">Monto</th><th class="num">Imputado</th><th></th></tr></thead><tbody>${d.payments.map((p)=>`<tr><td>${dateKey(p.payment_date||p.created_at)}</td><td>${esc(p.payment_method)}</td><td><span class="v5-pill">${statusLabel(p.status)}</span></td><td>${esc(p.reference_number||"")}</td><td class="num">${fmt(p.amount)}</td><td class="num">${fmt(p.applied_amount)}</td><td>${paymentActions(p)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty-row">No hay pagos registrados.</div>';
    bindPaymentActions();
  } else if(state.tab==="echeqs") {
    body.innerHTML=d.echeqs.length?`<div class="pay-table-wrap"><table><thead><tr><th>Número</th><th>Banco</th><th>Fecha pago</th><th>Estado</th><th class="num">Monto</th><th></th></tr></thead><tbody>${d.echeqs.map((e)=>`<tr><td>${esc(e.echeq_number||"s/n")}</td><td>${esc(e.bank_name||"")}</td><td>${dateKey(e.payment_date)}</td><td><span class="v5-pill">${statusLabel(e.status)}</span></td><td class="num">${fmt(e.amount)}</td><td>${echeqActions(e)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty-row">No hay eCheqs registrados o el módulo está apagado.</div>';
    bindEcheqActions();
  } else if(state.tab==="account") {
    body.innerHTML=state.current.balance?`<div class="pay-actions" style="margin-bottom:10px"><button class="link-btn" id="payDebitAdjustment">Agregar débito/ajuste</button></div><div class="pay-table-wrap"><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Descripción</th><th class="num">Débito</th><th class="num">Crédito</th><th></th></tr></thead><tbody>${d.movements.map((m)=>`<tr><td>${dateKey(m.effective_date)}</td><td>${esc(m.movement_type)}</td><td>${esc(m.description||"")}</td><td class="num">${fmt(m.debit_amount)}</td><td class="num">${fmt(m.credit_amount)}</td><td>${m.is_reversed||m.reversed_movement_id?"":`<button class="link-btn ghost" data-reverse-movement="${m.id}">Reversar</button>`}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty-row">El módulo de cuenta corriente está apagado.</div>';
    q("#payDebitAdjustment")?.addEventListener("click",openDebitAdjustmentModal); bindMovementActions();
  } else {
    body.innerHTML=d.invoices.length?`<div class="pay-table-wrap"><table><thead><tr><th>Emisión</th><th>Comprobante</th><th>Pedido</th><th>Estado</th><th class="num">Total</th><th></th></tr></thead><tbody>${d.invoices.map((i)=>`<tr><td>${dateKey(i.issue_date)}</td><td>${esc(invoiceLabel(i))}</td><td>${i.order_id?"Vinculada":"Sin pedido"}</td><td>${statusLabel(i.status)}</td><td class="num">${fmt(i.total_amount)}</td><td>${i.document_id?`<button class="link-btn" data-open-doc="${i.document_id}">Ver</button>`:""}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty-row">No hay facturas registradas.</div>';
    qa("[data-open-doc]").forEach((button)=>button.addEventListener("click",()=>window.open(`/api/documents/${button.dataset.openDoc}/download`,"_blank")));
  }
}

function paymentActions(p) {
  const buttons=[];
  if(["informed","draft"].includes(p.status)&&p.payment_method!=="echeq") buttons.push(`<button class="link-btn" data-confirm-payment="${p.id}">Confirmar</button>`);
  if(p.status==="confirmed"&&p.payment_method!=="customer_credit"&&Number(p.amount)-Number(p.applied_amount)>0.005) buttons.push(`<button class="link-btn" data-apply-payment="${p.id}" data-available="${round2(Number(p.amount)-Number(p.applied_amount))}">Imputar</button>`);
  if(p.status==="confirmed") buttons.push(`<button class="link-btn ghost" data-reverse-payment="${p.id}">Reversar</button>`);
  return buttons.join(" ");
}
function echeqActions(e) {
  if(["received","pending_bank_acceptance"].includes(e.status)) return `<button class="link-btn" data-ech-accept="${e.id}">Aceptar</button> <button class="link-btn ghost" data-ech-reject="${e.id}">Rechazar</button>`;
  if(e.status==="pending_accreditation") return `<button class="link-btn" data-ech-accredit="${e.id}">Acreditar</button> <button class="link-btn ghost" data-ech-reject="${e.id}">Rechazar</button>`;
  return "";
}

async function reloadAll(message="") { if(message) notify(message); await Promise.all([openClient(state.currentClientId),loadClients()]); }
function disableDuring(button,fn){ return async()=>{if(button.disabled)return;button.disabled=true;try{await fn();}finally{button.disabled=false;}}; }

function bindPaymentActions() {
  qa("[data-confirm-payment]").forEach((button)=>button.addEventListener("click",disableDuring(button,async()=>{
    const result=await confirmDialog({title:"Confirmar pago",body:"El pago generará crédito contable.",confirmLabel:"Confirmar",field:{label:"Fecha contable",type:"date",value:today(),required:true}}); if(!result.ok)return;
    await postJson(`/api/admin/payments/${button.dataset.confirmPayment}/confirm`,{accountingDate:result.value}); await reloadAll("Pago confirmado");
  })));
  qa("[data-apply-payment]").forEach((button)=>button.addEventListener("click",()=>openAllocationModal(button.dataset.applyPayment,Number(button.dataset.available))));
  qa("[data-reverse-payment]").forEach((button)=>button.addEventListener("click",disableDuring(button,async()=>{
    const result=await confirmDialog({title:"Reversar pago",body:"Se desharán sus imputaciones y movimientos.",confirmLabel:"Reversar",danger:true,field:{label:"Motivo",type:"textarea",required:true}}); if(!result.ok)return;
    await postJson(`/api/admin/payments/${button.dataset.reversePayment}/reverse`,{reason:result.value}); await reloadAll("Pago reversado");
  })));
}
function bindEcheqActions() {
  qa("[data-ech-accept]").forEach((button)=>button.addEventListener("click",disableDuring(button,async()=>{
    const result=await confirmDialog({title:"Aceptar eCheq",body:"La aceptación bancaria todavía no acredita dinero.",confirmLabel:"Aceptar",field:{label:"Fecha estimada de acreditación",type:"date",value:today(),required:true}});if(!result.ok)return;
    await postJson(`/api/admin/echeqs/${button.dataset.echAccept}/accept`,{expectedCreditDate:result.value});await reloadAll("eCheq aceptado; pendiente de acreditación");
  })));
  qa("[data-ech-accredit]").forEach((button)=>button.addEventListener("click",disableDuring(button,async()=>{
    const result=await confirmDialog({title:"Acreditar eCheq",body:"Recién ahora se generará el crédito.",confirmLabel:"Acreditar",field:{label:"Fecha real de acreditación",type:"date",value:today(),required:true}});if(!result.ok)return;
    await postJson(`/api/admin/echeqs/${button.dataset.echAccredit}/accredit`,{actualCreditDate:result.value});await reloadAll("eCheq acreditado");
  })));
  qa("[data-ech-reject]").forEach((button)=>button.addEventListener("click",disableDuring(button,async()=>{
    const result=await confirmDialog({title:"Rechazar eCheq",confirmLabel:"Rechazar",danger:true,field:{label:"Motivo",type:"textarea",required:true}});if(!result.ok)return;
    await postJson(`/api/admin/echeqs/${button.dataset.echReject}/reject`,{reason:result.value});await reloadAll("eCheq rechazado");
  })));
}
function bindMovementActions() {
  qa("[data-reverse-movement]").forEach((button)=>button.addEventListener("click",disableDuring(button,async()=>{
    const result=await confirmDialog({title:"Reversar movimiento",confirmLabel:"Reversar",danger:true,field:{label:"Motivo",type:"textarea",required:true}});if(!result.ok)return;
    await postJson(`/api/admin/movements/${button.dataset.reverseMovement}/reverse`,{reason:result.value});await reloadAll("Movimiento reversado");
  })));
}

async function uploadFile(file,type,orderId=null) {
  if(!file) return null;
  const status=await safe("/api/admin/documents/status",{configured:false,maxMb:25});
  if(!status.configured) throw new Error("El almacenamiento de documentos no está configurado.");
  if(file.size>Number(status.maxMb||25)*1024*1024) throw new Error(`El archivo supera ${status.maxMb} MB.`);
  const qs=new URLSearchParams({documentType:type,clientId:state.currentClientId,filename:file.name}); if(orderId)qs.set("orderId",orderId);
  const response=await fetch(`/api/admin/documents?${qs}`,{method:"POST",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});
  const body=await response.json().catch(()=>({})); if(!response.ok)throw Object.assign(new Error(body.error||"upload_failed"),{body});
  return body.document?.id||null;
}

function allocationRowsHtml(rows) {
  return rows.map((r)=>`<div class="pay-allocation-row" data-allocation="${r.id}" data-order="${r.order_id||""}"><div><strong>${r.request_number?"Pedido #"+esc(r.request_number):"Sin pedido"} · ${esc(invoiceLabel(r))}</strong><div class="pay-muted">Cuota ${r.installment_number} · vence ${dateKey(r.due_date)} · debe ${fmt(r.debt)}</div></div><input type="number" min="0" max="${r.debt}" step="0.01" value="${r.prefill||0}"></div>`).join("");
}
function readAllocations(root=q("#modalBox")) {
  return qa("[data-allocation]",root).map((row)=>({installmentId:row.dataset.allocation,amount:round2(row.querySelector("input").value),orderId:row.dataset.order||null})).filter((a)=>a.amount>0);
}
function singleOrder(allocations) { const ids=[...new Set(allocations.map((a)=>a.orderId).filter(Boolean))]; return ids.length===1?ids[0]:null; }
function refreshAllocationSummary(amount) {
  const allocations=readAllocations(), sum=round2(allocations.reduce((a,r)=>a+r.amount,0));
  q("#payAllocationSum").textContent=fmt(sum); q("#payAllocationRest").textContent=fmt(round2(Number(amount||0)-sum)); return {allocations,sum};
}

async function openRegisterModal() {
  const d=state.current, availableCredit=Number(d.balance?.inFavor||0), tiles=[...PAY_TILES]; if(availableCredit>0)tiles.push(["customer_credit","Saldo a favor",`Disponible ${fmt(availableCredit)}`]);
  const prefilled=fifoPrefill(d.installments.map((r)=>({...r,id:r.id,debt:Number(r.debt)})),0);
  modalOpen(`<div class="modal-head"><h3>Registrar cobro · ${esc(clientName(d.client))}</h3><button class="link-btn ghost" data-pay-close>✕</button></div>
    <div class="pay-tiles">${tiles.filter(([v])=>v!=="echeq"||state.status?.echeqAvailable).map(([v,l,desc])=>`<button type="button" class="pay-tile${v==="bank_transfer"?" active":""}" data-method="${v}"><strong>${l}</strong><small>${esc(desc)}</small></button>`).join("")}</div>
    <div class="pay-form-grid">
      <label>Monto<input id="payAmount" type="number" step="0.01" min="0.01"></label><label>Fecha<input id="payDate" type="date" value="${today()}"></label><label>Referencia<input id="payReference"></label>
      <label>Quién pagó<input id="payPayerName"></label><label>CUIT del pagador<input id="payPayerTax"></label><label>Referencia bancaria<input id="payPayerBank"></label>
      <label class="full">Comprobante<input id="payFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>
      <div class="full" id="payStateBlock"><strong>Estado</strong><div class="pay-state-options"><label><input type="radio" name="payState" value="confirmed" checked> <b>Confirmado</b><br><span class="pay-muted">Genera crédito y puede imputarse ahora.</span></label><label><input type="radio" name="payState" value="informed"> <b>Informado</b><br><span class="pay-muted">Queda pendiente de verificación; no se imputa.</span></label></div></div>
      <div class="full" id="payEcheqFields" hidden><div class="pay-form-grid"><label>Número eCheq<input id="payEcheqNumber"></label><label>Banco<input id="payEcheqBank"></label><label>Fecha de pago<input id="payEcheqPaymentDate" type="date"></label><label>Emisor<input id="payEcheqIssuer"></label><label>CUIT emisor<input id="payEcheqIssuerTax"></label><label>Acreditación estimada<input id="payEcheqExpected" type="date"></label></div><div class="pay-warning">Aceptar el eCheq no acredita dinero. El crédito se genera al marcarlo como acreditado.</div></div>
      <div class="full" id="payAllocationBlock"><div style="display:flex;justify-content:space-between;align-items:center"><strong>Imputación a cuotas</strong><label style="display:block"><input id="payLeaveUnapplied" type="checkbox"> Dejar remanente sin imputar</label></div><div class="pay-allocation" id="payAllocationRows">${allocationRowsHtml(prefilled)}</div><div class="pay-summary"><span>Imputado: <b id="payAllocationSum">$ 0</b></span><span>Remanente: <b id="payAllocationRest">$ 0</b></span></div></div>
      <label class="full">Notas<textarea id="payNotes" rows="2"></textarea></label>
    </div><div class="pay-modal-actions"><span class="msg" id="payModalMsg"></span><button class="link-btn ghost" data-pay-close>Cancelar</button><button class="btn-primary" id="paySubmit">Registrar</button></div>`);
  let method="bank_transfer";
  const update=()=>{
    const amount=Number(q("#payAmount").value||0), status=q('input[name="payState"]:checked')?.value||"confirmed";
    const isEcheq=method==="echeq", isCredit=method==="customer_credit";
    q("#payEcheqFields").hidden=!isEcheq; q("#payStateBlock").hidden=isEcheq||isCredit; q("#payAllocationBlock").hidden=isEcheq;
    if(isCredit){q("#payLeaveUnapplied").checked=false;q("#payLeaveUnapplied").disabled=true;}else q("#payLeaveUnapplied").disabled=status==="informed";
    qa("#payAllocationRows input").forEach((input)=>input.disabled=status==="informed"&&!isCredit);
    if(status==="informed"&&!isCredit)qa("#payAllocationRows input").forEach((input)=>input.value="0");
    else {
      const rows=fifoPrefill(d.installments.map((r)=>({...r,id:r.id,debt:Number(r.debt)})),isCredit?Math.min(amount,availableCredit):amount);
      q("#payAllocationRows").innerHTML=allocationRowsHtml(rows);
      qa("#payAllocationRows input").forEach((input)=>input.addEventListener("input",()=>refreshAllocationSummary(q("#payAmount").value)));
    }
    refreshAllocationSummary(amount);
  };
  qa("[data-method]").forEach((button)=>button.addEventListener("click",()=>{method=button.dataset.method;qa("[data-method]").forEach((b)=>b.classList.toggle("active",b===button));update();}));
  q("#payAmount").addEventListener("input",update); qa('input[name="payState"]').forEach((r)=>r.addEventListener("change",update));
  qa("#payAllocationRows input").forEach((input)=>input.addEventListener("input",()=>refreshAllocationSummary(q("#payAmount").value)));
  qa("[data-pay-close]").forEach((button)=>button.addEventListener("click",modalClose));
  q("#paySubmit").addEventListener("click",async()=>{
    const button=q("#paySubmit"),msg=q("#payModalMsg"),amount=round2(q("#payAmount").value),payDate=q("#payDate").value;
    if(!Number.isFinite(amount)||amount<=0){msg.textContent="Ingresá un monto válido.";return;}
    button.disabled=true; msg.textContent="Registrando...";
    try {
      const {allocations,sum}=refreshAllocationSummary(amount), status=q('input[name="payState"]:checked')?.value||"confirmed";
      if(method==="customer_credit") {
        if(amount>availableCredit+0.005)throw new Error(`El saldo disponible es ${fmt(availableCredit)}.`);
        if(Math.abs(sum-amount)>0.005)throw new Error("El saldo a favor aplicado debe coincidir con la imputación.");
        await postJson(`/api/admin/clients/${state.currentClientId}/credits/apply`,{allocations:allocations.map(({installmentId,amount})=>({installmentId,amount})),notes:q("#payNotes").value||null});
      } else if(method==="echeq") {
        const documentId=await uploadFile(q("#payFile").files[0],"comprobante_echeq",null);
        await postJson(`/api/admin/clients/${state.currentClientId}/echeqs`,{orderId:null,amount,echeqNumber:q("#payEcheqNumber").value||null,bankName:q("#payEcheqBank").value||null,issuerName:q("#payEcheqIssuer").value||null,issuerTaxId:q("#payEcheqIssuerTax").value||null,paymentDate:q("#payEcheqPaymentDate").value||payDate,expectedCreditDate:q("#payEcheqExpected").value||null,documentId,notes:q("#payNotes").value||null});
      } else {
        if(status==="confirmed"&&!q("#payLeaveUnapplied").checked&&Math.abs(sum-amount)>0.005)throw new Error("Imputá el total o marcá ‘dejar remanente sin imputar’.");
        const finalAlloc=status==="confirmed"?allocations:[];
        const orderId=singleOrder(finalAlloc);
        const documentId=await uploadFile(q("#payFile").files[0],"comprobante_transferencia",orderId);
        await postJson(`/api/admin/clients/${state.currentClientId}/payments`,{orderId,method,amount,paymentDate:payDate||null,reference:q("#payReference").value||null,payerName:q("#payPayerName").value||null,payerTaxId:q("#payPayerTax").value||null,payerBankRef:q("#payPayerBank").value||null,status,documentId,notes:q("#payNotes").value||null,allocations:finalAlloc.map(({installmentId,amount})=>({installmentId,amount}))});
      }
      modalClose(); await reloadAll(method==="customer_credit"?"Saldo a favor aplicado":"Cobro registrado");
    } catch(error){msg.textContent=errorText(error);} finally{button.disabled=false;}
  });
  update();
}

function openAllocationModal(paymentId,available) {
  const rows=fifoPrefill(state.current.installments.map((r)=>({...r,id:r.id,debt:Number(r.debt)})),available);
  modalOpen(`<div class="modal-head"><h3>Imputar pago · disponible ${fmt(available)}</h3><button class="link-btn ghost" data-pay-close>✕</button></div><div class="pay-allocation" id="payAllocationRows">${allocationRowsHtml(rows)}</div><div class="pay-summary"><span>Imputado: <b id="payAllocationSum">${fmt(available)}</b></span><span>Remanente: <b id="payAllocationRest">${fmt(0)}</b></span></div><div class="pay-modal-actions"><span id="payModalMsg"></span><button class="link-btn ghost" data-pay-close>Cancelar</button><button class="btn-primary" id="payApplySubmit">Imputar</button></div>`);
  qa("#payAllocationRows input").forEach((input)=>input.addEventListener("input",()=>refreshAllocationSummary(available)));qa("[data-pay-close]").forEach((b)=>b.addEventListener("click",modalClose));
  q("#payApplySubmit").addEventListener("click",async()=>{const button=q("#payApplySubmit"),msg=q("#payModalMsg"),allocations=readAllocations();if(!allocations.length){msg.textContent="Elegí al menos una cuota.";return;}button.disabled=true;try{await postJson(`/api/admin/payments/${paymentId}/apply`,{allocations:allocations.map(({installmentId,amount})=>({installmentId,amount}))});modalClose();await reloadAll("Pago imputado");}catch(error){msg.textContent=errorText(error);}finally{button.disabled=false;}});
}

function openCreditModal() {
  const orders=[...new Map(state.current.installments.filter((r)=>r.order_id).map((r)=>[r.order_id,r.request_number])).entries()];
  modalOpen(`<div class="modal-head"><h3>Generar saldo a favor</h3><button class="link-btn ghost" data-pay-close>✕</button></div><div class="pay-form-grid"><label>Monto<input id="creditAmount" type="number" min="0.01" step="0.01"></label><label>Fecha<input id="creditDate" type="date" value="${today()}"></label><label>Motivo<select id="creditCategory"><option value="devolucion">Devolución</option><option value="reclamo">Reclamo / bonificación</option><option value="reintegro_envio">Reintegro de envío o gasto</option><option value="diferencia_comercial">Diferencia comercial</option><option value="otro">Otro</option></select></label><label class="span2">Pedido relacionado (opcional)<select id="creditOrder"><option value="">Sin pedido</option>${orders.map(([id,n])=>`<option value="${id}">Pedido #${esc(n)}</option>`).join("")}</select></label><label>Comprobante<input id="creditFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label><label class="full">Descripción obligatoria<textarea id="creditDescription" rows="3"></textarea></label></div><div class="pay-modal-actions"><span id="payModalMsg"></span><button class="link-btn ghost" data-pay-close>Cancelar</button><button class="btn-primary" id="creditSubmit">Generar saldo</button></div>`);
  qa("[data-pay-close]").forEach((b)=>b.addEventListener("click",modalClose));q("#creditSubmit").addEventListener("click",async()=>{const button=q("#creditSubmit"),msg=q("#payModalMsg"),amount=round2(q("#creditAmount").value),description=q("#creditDescription").value.trim(),orderId=q("#creditOrder").value||null;if(!amount||amount<=0){msg.textContent="Ingresá un monto válido.";return;}if(!description){msg.textContent="La descripción es obligatoria.";return;}button.disabled=true;try{const documentId=await uploadFile(q("#creditFile").files[0],"nota_credito",orderId);await postJson(`/api/admin/clients/${state.currentClientId}/credits`,{amount,category:q("#creditCategory").value,description,effectiveDate:q("#creditDate").value||null,orderId,documentId});modalClose();await reloadAll("Saldo a favor generado");}catch(error){msg.textContent=errorText(error);}finally{button.disabled=false;}});
}
function openDebitAdjustmentModal() {
  modalOpen(`<div class="modal-head"><h3>Agregar débito / ajuste</h3><button class="link-btn ghost" data-pay-close>✕</button></div><div class="pay-form-grid"><label>Monto<input id="debitAmount" type="number" min="0.01" step="0.01"></label><label class="span2">Descripción<textarea id="debitDescription" rows="2"></textarea></label></div><div class="pay-modal-actions"><span id="payModalMsg"></span><button class="link-btn ghost" data-pay-close>Cancelar</button><button class="btn-primary" id="debitSubmit">Registrar débito</button></div>`);
  qa("[data-pay-close]").forEach((b)=>b.addEventListener("click",modalClose));q("#debitSubmit").addEventListener("click",async()=>{const button=q("#debitSubmit"),msg=q("#payModalMsg"),amount=round2(q("#debitAmount").value),description=q("#debitDescription").value.trim();if(!amount||!description){msg.textContent="Completá monto y descripción.";return;}button.disabled=true;try{await postJson(`/api/admin/clients/${state.currentClientId}/adjustments`,{type:"debit_adjustment",amount,description});modalClose();await reloadAll("Ajuste registrado");}catch(error){msg.textContent=errorText(error);}finally{button.disabled=false;}});
}

function cleanOrderFinance() {
  const style=document.createElement("style"); style.id="pay-order-cleanup"; style.textContent="#billingDetailBody #paymentsSection,#billingDetailBody #echeqSection,#billingDetailBody #accountSection{display:none!important}"; if(!q("#pay-order-cleanup"))document.head.appendChild(style);
  const run=()=>{
    qa('[data-v5-order-view="billing"]').forEach((b)=>{if(b.textContent.includes("Facturación"))b.textContent="Facturación";});
    const finance=q("#financeSection"); if(finance&&!q("#payJumpClient",finance)){
      const button=document.createElement("button");button.id="payJumpClient";button.className="link-btn";button.type="button";button.textContent="Ver cobranzas del cliente";
      button.addEventListener("click",()=>{const clientId=finance.dataset.clientId;if(clientId){showPayments();setTimeout(()=>openClient(clientId),80);}else showPayments();});
      finance.prepend(button);
    }
  };
  run(); new MutationObserver(run).observe(document.body,{childList:true,subtree:true});
}

export async function mountPaymentsSection() {
  if(state.mounted)return; state.mounted=true; linkStyles(); cleanOrderFinance();
  try {
    const [me,status]=await Promise.all([safe("/api/me",{capabilities:[]}),safe("/api/admin/finance/status",null)]);
    const caps=new Set(me.capabilities||[]); if(!status?.financial||!(caps.has("*")||caps.has("financial.reports.view")))return;
    state.status={ledgerAvailable:status.currentAccount,echeqAvailable:status.echeq};
    state.userRole=me.user?.role||null;
  } catch{return;}
  if(!installLegacySection())return; bindSection();
  let tries=0;const timer=setInterval(()=>{if(installV5Button()||++tries>30)clearInterval(timer);},100);
  const restore=()=>{if(location.hash.replace(/^#\/?admin\/?/,"").startsWith("pagos"))setTimeout(showPayments,0);};
  window.addEventListener("hashchange",restore);window.addEventListener("popstate",restore);restore();
  window.openPaymentsClient=(clientId)=>{showPayments();setTimeout(()=>openClient(clientId),80);};
  if(state.userRole==="administration") {
    qa("#adminNav > a[data-section]").forEach((a)=>{a.style.display=a.dataset.section==="payments"?"":"none";});
    const limitV5=()=>qa(".v5-admin-nav [data-v5-admin-target]").forEach((b)=>{b.hidden=b.dataset.v5AdminTarget!=="payments";});
    limitV5(); setTimeout(limitV5,250); showPayments();
  }
}
