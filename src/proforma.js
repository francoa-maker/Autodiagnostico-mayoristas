// Renders the proforma as self-contained HTML, used both by the printable
// admin route (forEmail=false: includes a print toolbar) and by the Gmail
// sender (forEmail=true: no toolbar, inline styles only so it survives email
// clients). Totals come from the shared computeQuoteTotals so the emailed and
// on-screen documents can never disagree.
import { computeQuoteTotals, resolveItemUnit } from "./quoteTotals.js";

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtMoney(amount, currency = "ARS") {
  if (amount === null || amount === undefined || amount === "") return "-";
  const prefix = currency === "USD" ? "US$ " : "$ ";
  return prefix + Number(amount).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderProformaHtml({ quote, items, company, signer, forEmail = false }) {
  const currency = quote.currency || "ARS";
  const totals = computeQuoteTotals({
    items,
    discount: quote.discount,
    discountType: quote.discount_type,
    shipping: quote.shipping,
    surcharge: quote.surcharge,
    ivaRate: quote.iva_rate
  });

  const rows = items
    .map((it) => {
      const unit = resolveItemUnit(it);
      const lineTotal = unit != null ? unit * Number(it.quantity) : null;
      return `<tr>
        <td class="desc"><span class="sku">[${esc(it.sku_snapshot)}]</span> ${esc(it.product_name_snapshot)}${it.brand_snapshot ? ` <span class="brand">${esc(it.brand_snapshot)}</span>` : ""}</td>
        <td class="num">${Number(it.quantity)}</td>
        <td class="num">${unit != null ? fmtMoney(unit, currency) : "-"}</td>
        <td class="num total">${lineTotal != null ? fmtMoney(lineTotal, currency) : "-"}</td>
      </tr>`;
    })
    .join("");

  const discountLabel = quote.discount_type === "percent" ? `Descuento (${Number(quote.discount) || 0}%)` : "Descuento";
  const adjRow = (label, value, sign) =>
    value ? `<tr><td class="lbl">${label}</td><td class="num">${sign}${fmtMoney(Math.abs(value), currency)}</td></tr>` : "";

  const logo = company.logoUrl
    ? `<img src="${esc(company.logoUrl)}" alt="${esc(company.name)}" class="logo-img">`
    : `<div class="logo-text">Auto<span>diagnostico</span></div>`;

  const dateStr = new Date(quote.submitted_at).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const ivaPct = Number(quote.iva_rate) || 0;

  const signatureBlock = signer
    ? `<div class="signature">
        <div class="sig-line"></div>
        <div class="sig-name">${esc(signer.display_name || signer.email)}</div>
        <div class="sig-role">Vendedor · ${esc(signer.email)}</div>
        <div class="sig-note">Cotización emitida el ${esc(dateStr)}</div>
      </div>`
    : "";

  const toolbar = forEmail
    ? ""
    : `<div class="toolbar">
        <button onclick="window.print()">Imprimir / Guardar PDF</button>
        <button class="ghost" onclick="window.close()">Cerrar</button>
      </div>`;

  const styles = `
    :root{--red:#c8102e;--ink:#1a1a1a;--muted:#777;--line:#e2e2e2}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:var(--ink);background:#f3f4f6;padding:24px}
    .sheet{max-width:820px;margin:0 auto;background:#fff;padding:44px 48px;box-shadow:0 2px 16px rgba(0,0,0,.08)}
    .toolbar{max-width:820px;margin:0 auto 16px;display:flex;gap:10px;justify-content:flex-end}
    .toolbar button{background:var(--red);color:#fff;border:none;padding:10px 20px;border-radius:7px;font-size:14px;cursor:pointer;font-weight:600}
    .toolbar button.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--ink);padding-bottom:22px;margin-bottom:26px}
    .logo-img{max-height:64px;max-width:280px}
    .logo-text{font-size:30px;font-weight:800;letter-spacing:-.5px;color:var(--ink)}
    .logo-text span{color:var(--red)}
    .company{text-align:right;font-size:12px;color:var(--muted);line-height:1.55}
    .company .cname{font-size:14px;color:var(--ink);font-weight:700}
    .meta-row{display:flex;justify-content:space-between;gap:32px;margin-bottom:26px}
    .bill-to{font-size:12.5px;line-height:1.6}
    .bill-to .lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:5px}
    .bill-to .cname{font-weight:700;font-size:13.5px}
    h1{font-size:24px;font-weight:800;margin-bottom:4px}
    .docmeta{font-size:12px;color:var(--muted);text-align:right;line-height:1.7}
    .docmeta b{color:var(--ink)}
    table.items{width:100%;border-collapse:collapse;margin-bottom:8px}
    table.items thead th{background:var(--ink);color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:9px 12px;text-align:left}
    table.items thead th.num{text-align:right}
    table.items tbody td{padding:11px 12px;border-bottom:1px solid var(--line);font-size:12.5px;vertical-align:top}
    table.items td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    table.items td.total{font-weight:600}
    .desc .sku{color:var(--muted);font-family:ui-monospace,monospace;font-size:11.5px}
    .desc .brand{color:var(--muted);font-size:11px;border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-left:4px}
    .totals{display:flex;justify-content:flex-end;margin-top:14px}
    .totals table{min-width:300px;border-collapse:collapse}
    .totals td{padding:6px 12px;font-size:13px}
    .totals td.lbl{color:var(--muted)}
    .totals td.num{text-align:right;font-variant-numeric:tabular-nums}
    .totals tr.sep td{border-top:1px solid var(--line)}
    .totals tr.grand td{background:var(--red);color:#fff;font-weight:700;font-size:15px;padding:11px 12px}
    .signature{margin-top:40px;width:280px}
    .sig-line{border-top:1px solid var(--ink);margin-bottom:6px}
    .sig-name{font-weight:700;font-size:13px}
    .sig-role{font-size:11.5px;color:var(--muted)}
    .sig-note{font-size:11px;color:var(--muted);margin-top:2px}
    .notes{margin-top:26px;font-size:12px;color:var(--muted);line-height:1.6;border-top:1px solid var(--line);padding-top:16px}
    .footer{margin-top:30px;text-align:center;font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:14px}
    @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;padding:24px 8px;max-width:none}.toolbar{display:none}}
  `;

  const sheet = `
  <div class="sheet">
    <div class="head">
      <div>${logo}</div>
      <div class="company">
        <div class="cname">${esc(company.legalName || company.name)}</div>
        ${(company.addressLines || []).map((l) => `<div>${esc(l)}</div>`).join("")}
        ${company.phone ? `<div>Tel: ${esc(company.phone)}</div>` : ""}
        ${company.email ? `<div>${esc(company.email)}</div>` : ""}
        ${company.website ? `<div>${esc(company.website)}</div>` : ""}
        ${company.taxId ? `<div>CUIT: ${esc(company.taxId)}</div>` : ""}
      </div>
    </div>

    <div class="meta-row">
      <div class="bill-to">
        <div class="lbl">Cliente</div>
        <div class="cname">${esc(quote.company_name || quote.display_name || quote.email)}</div>
        ${quote.display_name && quote.company_name ? `<div>${esc(quote.display_name)}</div>` : ""}
        <div>${esc(quote.email)}</div>
      </div>
      <div>
        <h1>Proforma</h1>
        <div class="docmeta">
          <div>N° <b>#${quote.request_number}</b></div>
          <div>Fecha: <b>${esc(dateStr)}</b></div>
          <div>Moneda: <b>${esc(currency)}</b></div>
          ${company.proformaValidityDays ? `<div>Validez: <b>${Number(company.proformaValidityDays)} días</b></div>` : ""}
        </div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>Descripción</th><th class="num">Cantidad</th><th class="num">Precio unit.</th><th class="num">Importe</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:#999;padding:24px">Sin items</td></tr>'}</tbody>
    </table>

    <div class="totals">
      <table>
        <tr><td class="lbl">Subtotal (IVA incl.)</td><td class="num">${fmtMoney(totals.itemsGross, currency)}</td></tr>
        ${adjRow(discountLabel, totals.discountAmount, "-")}
        ${adjRow("Envío", quote.shipping, "+")}
        ${adjRow("Recargo", quote.surcharge, "+")}
        <tr class="sep"><td class="lbl">Neto gravado</td><td class="num">${fmtMoney(totals.neto, currency)}</td></tr>
        <tr><td class="lbl">IVA ${ivaPct}%</td><td class="num">${fmtMoney(totals.iva, currency)}</td></tr>
        <tr class="grand"><td>Total</td><td class="num">${fmtMoney(totals.total, currency)}</td></tr>
      </table>
    </div>

    ${signatureBlock}
    ${quote.public_notes ? `<div class="notes"><b>Notas:</b> ${esc(quote.public_notes)}</div>` : ""}
    <div class="footer">${esc(company.proformaFooter || "")}</div>
  </div>`;

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proforma #${quote.request_number} - ${esc(company.name)}</title>
<style>${styles}</style></head>
<body>
  ${toolbar}
  ${sheet}
</body></html>`;
}
