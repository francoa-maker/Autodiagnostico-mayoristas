// Renders the proforma (and the warehouse picking sheet) as self-contained
// HTML. Used by the printable admin route (forEmail=false: A4 + print toolbar)
// and by the Gmail sender (forEmail=true: no toolbar). Totals come from the
// shared computeQuoteTotals so emailed and on-screen documents never disagree.
import { computeQuoteTotals, resolveItemUnit, resolveItemRate } from "./quoteTotals.js";
import { formatTaxId } from "./cuit.js";

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

const TAX_CONDITION_LABEL = {
  responsable_inscripto: "Responsable Inscripto",
  monotributo: "Monotributo",
  exento: "Exento",
  consumidor_final: "Consumidor Final"
};

// Dirección de entrega en el orden que usa Andreani, campo por campo.
function addressLines(q) {
  const l1 = [q.ship_street, q.ship_number].filter(Boolean).join(" ");
  const l2 = [q.ship_floor ? `Piso ${q.ship_floor}` : "", q.ship_apartment ? `Depto ${q.ship_apartment}` : ""].filter(Boolean).join(" ");
  const l3 = [q.ship_postal_code, q.ship_city, q.ship_province].filter(Boolean).join(", ");
  return [l1, l2, l3, q.ship_phone ? `Tel: ${q.ship_phone}` : "", q.ship_notes || ""].filter(Boolean);
}

// Marca de agua por usuario: repite en diagonal la identidad de quien tiene el
// documento (nombre · código · email · fecha), tenue, para que toda captura o
// reenvío quede atribuible. Se apoya sobre .sheet (position:relative).
function watermarkLayer(quote) {
  const who = quote.company_name || quote.display_name || quote.email || "";
  const day = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const tag = esc(`CONFIDENCIAL · ${who} · ${quote.client_code || ""} · ${quote.email || ""} · ${day}`);
  const line = `<div class="wm-line">${(tag + "    ").repeat(3)}</div>`;
  return `<div class="wm" aria-hidden="true">${line.repeat(14)}</div>`;
}

const A4_STYLES = `
  .wm{position:absolute;top:-20%;left:-25%;width:150%;height:150%;transform:rotate(-24deg);pointer-events:none;z-index:0;display:flex;flex-direction:column;gap:30px;overflow:hidden}
  .wm-line{white-space:nowrap;font-size:13px;letter-spacing:1px;color:#c8102e;opacity:.10;font-weight:600}
  .sheet-body{position:relative;z-index:1}

  :root{--red:#c8102e;--ink:#1a1a1a;--muted:#777;--line:#e2e2e2}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:var(--ink);background:#f3f4f6;padding:18px}
  .toolbar{width:210mm;max-width:100%;margin:0 auto 14px;display:flex;gap:10px;justify-content:flex-end}
  .toolbar button{background:var(--red);color:#fff;border:none;padding:10px 20px;border-radius:7px;font-size:14px;cursor:pointer;font-weight:600}
  .toolbar button.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
  /* Hoja A4 real */
  .sheet{position:relative;overflow:hidden;width:210mm;min-height:297mm;margin:0 auto;background:#fff;padding:16mm 15mm;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:18px}
  .logo-img{max-height:60px;max-width:260px}
  .logo-text{font-size:28px;font-weight:800;letter-spacing:-.5px;color:var(--ink)}
  .logo-text span{color:var(--red)}
  .company{text-align:right;font-size:11px;color:var(--muted);line-height:1.5}
  .company .cname{font-size:13.5px;color:var(--ink);font-weight:700}
  .parties{display:flex;justify-content:space-between;gap:24px;margin-bottom:18px}
  .party{font-size:11.5px;line-height:1.55;max-width:52%}
  .party .lbl{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:4px}
  .party .cname{font-weight:700;font-size:12.5px}
  h1{font-size:22px;font-weight:800;margin-bottom:4px}
  .docmeta{font-size:11.5px;color:var(--muted);text-align:right;line-height:1.7}
  .docmeta b{color:var(--ink)}
  table.items{width:100%;border-collapse:collapse;margin-bottom:8px}
  table.items thead th{background:var(--ink);color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.4px;padding:8px 9px;text-align:left}
  table.items thead th.num{text-align:right}
  table.items tbody td{padding:8px 9px;border-bottom:1px solid var(--line);font-size:11.5px;vertical-align:middle}
  table.items td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .thumb{width:38px;height:38px;object-fit:contain;background:#f6f6f6;border:1px solid var(--line);border-radius:5px}
  .thumb-empty{width:38px;height:38px;background:#f6f6f6;border:1px solid var(--line);border-radius:5px}
  .desc .sku{color:var(--muted);font-family:ui-monospace,monospace;font-size:10.5px}
  .desc .brand{color:var(--muted);font-size:10px;border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-left:4px}
  .totals{display:flex;justify-content:flex-end;margin-top:12px}
  .totals table{min-width:320px;border-collapse:collapse}
  .totals td{padding:5px 12px;font-size:12px}
  .totals td.lbl{color:var(--muted)}
  .totals td.num{text-align:right;font-variant-numeric:tabular-nums}
  .totals tr.sep td{border-top:1px solid var(--line)}
  .totals tr.grand td{background:var(--red);color:#fff;font-weight:700;font-size:14px;padding:10px 12px}
  .iva-note{font-size:10px;color:var(--muted);margin-top:2px}
  .signature{margin-top:34px;width:270px}
  .sig-line{border-top:1px solid var(--ink);margin-bottom:6px}
  .sig-name{font-weight:700;font-size:12.5px}
  .sig-role{font-size:11px;color:var(--muted)}
  .notes{margin-top:20px;font-size:11px;color:var(--muted);line-height:1.6;border-top:1px solid var(--line);padding-top:12px}
  .footer{margin-top:22px;text-align:center;font-size:10px;color:var(--muted);border-top:1px solid var(--line);padding-top:12px}
  @page{size:A4;margin:12mm}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;width:auto;min-height:auto;padding:0}.toolbar{display:none}}
`;

export function renderProformaHtml({ quote, items, company, signer, forEmail = false }) {
  const currency = quote.currency || "ARS";
  const totals = computeQuoteTotals({
    items,
    discount: quote.discount,
    discountType: quote.discount_type,
    shipping: quote.shipping,
    surcharge: quote.surcharge
  });

  const rows = items
    .map((it) => {
      const unit = resolveItemUnit(it);
      const lineTotal = unit != null ? unit * Number(it.quantity) : null;
      const rate = resolveItemRate(it);
      const isConsult = unit == null && (it.displayed_price_snapshot || {}).state === "consult";
      const unitCell = unit != null ? fmtMoney(unit, currency) : isConsult ? "Consultar" : "-";
      const totalCell = lineTotal != null ? fmtMoney(lineTotal, currency) : isConsult ? "Consultar" : "-";
      const thumb = it.image_url
        ? `<img class="thumb" src="${esc(it.image_url)}" alt="">`
        : `<div class="thumb-empty"></div>`;
      return `<tr>
        <td>${thumb}</td>
        <td class="desc"><span class="sku">[${esc(it.sku_snapshot)}]</span> ${esc(it.product_name_snapshot)}${it.brand_snapshot ? ` <span class="brand">${esc(it.brand_snapshot)}</span>` : ""}</td>
        <td class="num">${Number(it.quantity)}</td>
        <td class="num">${rate}%</td>
        <td class="num">${unitCell}</td>
        <td class="num">${totalCell}</td>
      </tr>`;
    })
    .join("");

  const discountLabel = quote.discount_type === "percent" ? `Descuento (${Number(quote.discount) || 0}%)` : "Descuento";
  const adjRow = (label, value, sign) =>
    value ? `<tr><td class="lbl">${label}</td><td class="num">${sign}${fmtMoney(Math.abs(value), currency)}</td></tr>` : "";
  const ivaRows = totals.ivaGroups
    .map((g) => `<tr><td class="lbl">Neto gravado ${g.rate}%</td><td class="num">${fmtMoney(g.neto, currency)}</td></tr>
                 <tr><td class="lbl">IVA ${g.rate}%</td><td class="num">${fmtMoney(g.iva, currency)}</td></tr>`)
    .join("");

  const logo = company.logoUrl
    ? `<img src="${esc(company.logoUrl)}" alt="${esc(company.name)}" class="logo-img">`
    : `<div class="logo-text">Auto<span>diagnostico</span></div>`;

  const dateStr = new Date(quote.submitted_at).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const addr = addressLines(quote);

  const signatureBlock = signer
    ? `<div class="signature">
        <div class="sig-line"></div>
        <div class="sig-name">${esc(signer.display_name || signer.email)}</div>
        <div class="sig-role">Vendedor · ${esc(signer.email)}</div>
        <div class="sig-role">Cotización emitida el ${esc(dateStr)}</div>
      </div>`
    : "";

  const toolbar = forEmail
    ? ""
    : `<div class="toolbar">
        <button onclick="window.print()">Imprimir / Guardar PDF</button>
        <button class="ghost" onclick="window.close()">Cerrar</button>
      </div>`;

  const sheet = `
  <div class="sheet">
    ${watermarkLayer(quote)}
    <div class="sheet-body">
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

    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:14px">
      <div style="flex:1"></div>
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

    <div class="parties">
      <div class="party">
        <div class="lbl">Cliente</div>
        <div class="cname">${esc(quote.company_name || quote.display_name || quote.email)}</div>
        ${quote.tax_cuit ? `<div>${esc(quote.tax_id_type || "CUIT")}: ${esc(formatTaxId(quote.tax_id_type || "CUIT", quote.tax_cuit))}</div>` : ""}
        ${quote.tax_condition ? `<div>${esc(TAX_CONDITION_LABEL[quote.tax_condition] || quote.tax_condition)}</div>` : ""}
        <div>${esc(quote.email)}</div>
      </div>
      <div class="party">
        <div class="lbl">Entrega</div>
        ${addr.length ? addr.map((l) => `<div>${esc(l)}</div>`).join("") : '<div style="color:#999">Sin dirección cargada</div>'}
      </div>
    </div>

    <table class="items">
      <thead><tr><th></th><th>Descripción</th><th class="num">Cant.</th><th class="num">IVA</th><th class="num">Precio unit.</th><th class="num">Importe</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#999;padding:24px">Sin items</td></tr>'}</tbody>
    </table>

    <div class="totals">
      <table>
        <tr><td class="lbl">Subtotal (IVA incl.)</td><td class="num">${fmtMoney(totals.itemsGross, currency)}</td></tr>
        ${adjRow(discountLabel, totals.discountAmount, "-")}
        ${adjRow("Envío", quote.shipping, "+")}
        ${adjRow("Recargo", quote.surcharge, "+")}
        <tr class="sep"><td class="lbl" colspan="2" style="padding-top:8px;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Discriminación de IVA</td></tr>
        ${ivaRows}
        <tr class="grand"><td>Total</td><td class="num">${fmtMoney(totals.total, currency)}</td></tr>
      </table>
    </div>

    ${signatureBlock}
    ${quote.public_notes ? `<div class="notes"><b>Notas:</b> ${esc(quote.public_notes)}</div>` : ""}
    <div class="footer">${esc(company.proformaFooter || "")}${quote.client_code ? ` · Documento para ${esc(quote.company_name || quote.display_name || quote.email)} (${esc(quote.client_code)})` : ""}</div>
    </div>
  </div>`;

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proforma #${quote.request_number} - ${esc(company.name)}</title>
<style>${A4_STYLES}</style></head>
<body>
  ${toolbar}
  ${sheet}
</body></html>`;
}

// Hoja de armado para el depósito: qué preparar y a dónde enviarlo. Sin
// precios (el depósito no los necesita), con foco en SKU, cantidades y la
// dirección de entrega lista para Andreani.
export function renderWarehouseHtml({ quote, items, company }) {
  const rows = items
    .map((it) => {
      const thumb = it.image_url ? `<img class="thumb" src="${esc(it.image_url)}" alt="">` : `<div class="thumb-empty"></div>`;
      return `<tr>
        <td>${thumb}</td>
        <td style="font-family:ui-monospace,monospace;font-size:12px">${esc(it.sku_snapshot)}</td>
        <td>${esc(it.product_name_snapshot)}${it.brand_snapshot ? ` <span style="color:#888;font-size:11px">${esc(it.brand_snapshot)}</span>` : ""}</td>
        <td style="text-align:right;font-weight:700;font-size:15px">${Number(it.quantity)}</td>
      </tr>`;
    })
    .join("");
  const addr = addressLines(quote);
  const dateStr = new Date(quote.submitted_at).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:12px}
  h2{font-size:18px;margin:0 0 4px}
  .muted{color:#777;font-size:12.5px}
  .box{border:1px solid #e2e2e2;border-radius:8px;padding:14px 16px;margin:14px 0}
  .box h3{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#777}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  th{text-align:left;font-size:11px;text-transform:uppercase;color:#777;border-bottom:2px solid #1a1a1a;padding:6px 8px}
  td{padding:8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:middle}
  .thumb{width:40px;height:40px;object-fit:contain;background:#f6f6f6;border:1px solid #e2e2e2;border-radius:5px}
  .thumb-empty{width:40px;height:40px;background:#f6f6f6;border:1px solid #e2e2e2;border-radius:5px}
  .addr div{font-size:13px;line-height:1.6}
</style></head>
<body>
  <h2>Pedido para preparar #${quote.request_number}</h2>
  <div class="muted">Cliente: ${esc(quote.company_name || quote.display_name || quote.email)} · ${esc(dateStr)}</div>

  <div class="box">
    <h3>Productos a preparar</h3>
    <table>
      <thead><tr><th></th><th>SKU</th><th>Producto</th><th style="text-align:right">Cant.</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">Sin items</td></tr>'}</tbody>
    </table>
  </div>

  <div class="box addr">
    <h3>Dirección de entrega (Andreani)</h3>
    ${addr.length ? addr.map((l) => `<div>${esc(l)}</div>`).join("") : '<div style="color:#999">Sin dirección cargada</div>'}
  </div>

  ${quote.public_notes ? `<div class="box"><h3>Notas</h3><div style="font-size:13px">${esc(quote.public_notes)}</div></div>` : ""}
  <div class="muted" style="margin-top:16px">Enviado desde el Portal Autodiagnóstico.</div>
</body></html>`;
}
