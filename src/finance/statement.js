// Estado de cuenta imprimible (HTML autocontenido, se descarga por el backend).
// Reutiliza esc/fmtMoney de la proforma. Muestra saldos + movimientos con saldo
// corrido. No se guarda en Drive: se genera on-demand.
import { esc, fmtMoney } from "../proforma.js";

const MOV_LABEL = {
  invoice_debit: "Factura", payment_credit: "Pago", credit_note: "Nota de crédito",
  debit_adjustment: "Ajuste (débito)", credit_adjustment: "Ajuste (crédito)",
  balance_applied: "Saldo aplicado", refund: "Reintegro", payment_reversal: "Reversa"
};

export function renderAccountStatementHtml({ client, balance, movements, company, forEmail = false }) {
  const day = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  // Movimientos de más viejo a más nuevo con saldo corrido.
  const asc = [...movements].reverse();
  let running = 0;
  const rows = asc.map((m) => {
    running = Math.round((running + Number(m.debit_amount) - Number(m.credit_amount)) * 100) / 100;
    const rev = m.is_reversed ? " (reversado)" : "";
    return `<tr${m.is_reversed ? ' style="color:#999;text-decoration:line-through"' : ""}>
      <td>${esc(m.effective_date)}</td>
      <td>${esc(MOV_LABEL[m.movement_type] || m.movement_type)}${rev}</td>
      <td>${esc(m.description || "")}</td>
      <td class="num">${Number(m.debit_amount) > 0 ? fmtMoney(m.debit_amount) : ""}</td>
      <td class="num">${Number(m.credit_amount) > 0 ? fmtMoney(m.credit_amount) : ""}</td>
      <td class="num">${fmtMoney(running)}</td>
    </tr>`;
  }).join("");
  const toolbar = forEmail ? "" : `<div class="toolbar"><button data-action="print">Imprimir / PDF</button></div><script src="/assets/doc-actions.js"></script>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Estado de cuenta - ${esc(client.display_name || client.email)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0} body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#1a1a1a;background:#f3f4f6;padding:18px}
    .toolbar{width:210mm;max-width:100%;margin:0 auto 14px;display:flex;justify-content:flex-end}
    .toolbar button{background:#c8102e;color:#fff;border:none;padding:10px 20px;border-radius:7px;font-size:14px;cursor:pointer;font-weight:600}
    .sheet{width:210mm;max-width:100%;margin:0 auto;background:#fff;padding:16mm 15mm;box-shadow:0 2px 16px rgba(0,0,0,.08)}
    h1{font-size:20px;margin-bottom:4px} .muted{color:#777;font-size:12.5px}
    .head{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;border-bottom:2px solid #1a1a1a;padding-bottom:12px;margin-bottom:14px}
    .chips{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
    .chip{border:1px solid #e2e2e2;border-radius:8px;padding:6px 10px;font-size:12.5px} .chip b{display:block;font-size:14px}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px} th,td{padding:6px 8px;border-bottom:1px solid #eee;text-align:left}
    th{background:#fafafa;text-transform:uppercase;font-size:10.5px;color:#777} .num{text-align:right;font-variant-numeric:tabular-nums}
    @media print{body{background:#fff;padding:0}.toolbar{display:none}.sheet{box-shadow:none;width:auto}}
  </style></head><body>
  ${toolbar}
  <div class="sheet">
    <div class="head">
      <div><h1>${esc(company.name || "Autodiagnóstico")}</h1><div class="muted">${esc(company.legalName || "")}${company.taxId ? " · CUIT " + esc(company.taxId) : ""}</div></div>
      <div style="text-align:right"><div class="muted">Estado de cuenta</div><div class="muted">${day}</div></div>
    </div>
    <div><b>${esc(client.company_name || client.display_name || client.email)}</b>${client.client_code ? ` <span class="muted">(${esc(client.client_code)})</span>` : ""}<div class="muted">${esc(client.email)}${client.tax_cuit ? " · " + esc(client.tax_cuit) : ""}</div></div>
    <div class="chips">
      <div class="chip">Deuda total<b>${fmtMoney(balance.debt)}</b></div>
      <div class="chip">Vencido<b>${fmtMoney(balance.overdue)}</b></div>
      <div class="chip">A vencer<b>${fmtMoney(balance.toDue)}</b></div>
      <div class="chip">A favor<b>${fmtMoney(balance.inFavor)}</b></div>
      <div class="chip">Pend. acreditación<b>${fmtMoney(balance.pendingAccreditation)}</b></div>
    </div>
    <table>
      <thead><tr><th>Fecha</th><th>Concepto</th><th>Detalle</th><th class="num">Débito</th><th class="num">Crédito</th><th class="num">Saldo</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#999;padding:20px">Sin movimientos.</td></tr>'}</tbody>
    </table>
    <p class="muted" style="margin-top:16px">${esc(company.proformaFooter || "")}</p>
  </div></body></html>`;
}
