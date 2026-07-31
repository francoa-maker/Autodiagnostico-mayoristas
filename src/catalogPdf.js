// Catálogo imprimible para el cliente (se guarda como PDF desde el navegador,
// mismo patrón que la proforma: HTML autocontenido + botón Imprimir). Lleva
// marca de agua por usuario (trazabilidad ante fugas) y fecha de emisión.
import { esc, fmtMoney } from "./proforma.js";

// Marca de agua fija que se repite en cada página impresa (position:fixed se
// pinta en cada hoja al imprimir). Igual criterio que la proforma: identidad de
// quien tiene el documento, tenue y en diagonal.
function watermarkLayer(client, dateStr) {
  const who = client.company_name || client.display_name || client.email || "";
  const tag = esc(`CONFIDENCIAL · ${who} · ${client.client_code || ""} · ${client.email || ""} · ${dateStr}`);
  const line = `<div class="wm-line">${(tag + "&nbsp;&nbsp;&nbsp;&nbsp;").repeat(3)}</div>`;
  return `<div class="wm" aria-hidden="true">${line.repeat(26)}</div>`;
}

function priceText(price) {
  if (!price) return "-";
  if (price.state === "value" && price.amount != null) return fmtMoney(price.amount, price.currency || "ARS");
  if (price.state === "consult") return "Consultar";
  return "-";
}

// groups: [{ brand, products: [{ sku, name, imageUrl, pvp:{...}, wholesale:{...} }] }]
export function renderCatalogPdfHtml({ client, groups, company, issueDate = new Date(), filtered = false, filterSummary = "" }) {
  const dateStr = issueDate.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const timeStr = issueDate.toLocaleString("es-AR", { hour: "2-digit", minute: "2-digit" });
  const logo = company.logoUrl
    ? `<img src="${esc(company.logoUrl)}" alt="${esc(company.name || "")}" class="logo-img">`
    : `<div class="logo-text">Auto<span>diagnostico</span></div>`;
  const total = groups.reduce((n, g) => n + g.products.length, 0);
  const who = client.company_name || client.display_name || client.email || "";

  const sections = groups.map((g) => `
    <section class="brand">
      <h2>${esc(g.brand || "Sin marca")} <span class="bcount">${g.products.length}</span></h2>
      <table class="items">
        <thead><tr><th class="thumb-col"></th><th>SKU</th><th>Producto</th><th class="num">PVP</th><th class="num">Mayorista</th></tr></thead>
        <tbody>
          ${g.products.map((p) => `<tr>
            <td class="thumb-col">${p.imageUrl ? `<img class="thumb" src="${esc(p.imageUrl)}" alt="" loading="lazy">` : '<div class="thumb-empty"></div>'}</td>
            <td class="sku">${esc(p.sku)}</td>
            <td class="pname">${esc(p.name)}</td>
            <td class="num pvp">${priceText(p.pvp)}</td>
            <td class="num whole">${priceText(p.wholesale)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>`).join("");

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Catálogo ${esc(company.name || "Autodiagnostico")} - ${dateStr}</title>
<style>
  :root{--red:#c8102e;--ink:#1a1a1a;--muted:#777;--line:#e2e2e2}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:var(--ink);background:#f3f4f6;padding:18px}
  .toolbar{width:210mm;max-width:100%;margin:0 auto 14px;display:flex;gap:10px;justify-content:flex-end}
  .toolbar button{background:var(--red);color:#fff;border:none;padding:10px 20px;border-radius:7px;font-size:14px;cursor:pointer;font-weight:600}
  .toolbar button.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
  .wm{position:fixed;top:-20%;left:-25%;width:150%;height:150%;transform:rotate(-24deg);pointer-events:none;z-index:0;display:flex;flex-direction:column;gap:34px;overflow:hidden}
  .wm-line{white-space:nowrap;font-size:13px;letter-spacing:1px;color:var(--red);opacity:.09;font-weight:600}
  .sheet{position:relative;z-index:1;width:210mm;max-width:100%;margin:0 auto;background:#fff;padding:15mm 14mm;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--ink);padding-bottom:14px;margin-bottom:14px;gap:20px}
  .logo-img{max-height:56px;max-width:240px}
  .logo-text{font-size:26px;font-weight:800;letter-spacing:-.5px}.logo-text span{color:var(--red)}
  .head h1{font-size:20px;font-weight:800;margin-bottom:2px}
  .meta{text-align:right;font-size:11px;color:var(--muted);line-height:1.6}
  .meta b{color:var(--ink)}
  .company{font-size:11px;color:var(--muted);margin-bottom:14px;line-height:1.5}
  .filter-note{font-size:11px;color:var(--red);background:#fff0f2;border:1px solid #f3c9d0;border-radius:6px;padding:6px 10px;margin-bottom:12px;font-weight:600}
  .brand{margin-bottom:16px;break-inside:avoid}
  .brand h2{font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:var(--red);border-bottom:1px solid var(--line);padding-bottom:5px;margin-bottom:6px}
  .brand h2 .bcount{color:var(--muted);font-size:11px;font-weight:400;text-transform:none;letter-spacing:0}
  table.items{width:100%;border-collapse:collapse}
  table.items thead th{font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);text-align:left;padding:4px 7px;border-bottom:1px solid var(--line)}
  table.items td{padding:5px 7px;border-bottom:1px solid #f0f0f0;font-size:11.5px;vertical-align:middle}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .thumb-col{width:34px}
  .thumb{width:30px;height:30px;object-fit:contain;border:1px solid var(--line);border-radius:5px;background:#fff}
  .thumb-empty{width:30px;height:30px;border:1px dashed var(--line);border-radius:5px}
  .sku{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--muted);white-space:nowrap}
  .pname{font-weight:600}
  .whole{font-weight:700;color:var(--ink)}
  .pvp{color:var(--muted)}
  .foot{margin-top:16px;padding-top:10px;border-top:1px solid var(--line);font-size:10px;color:var(--muted);text-align:center}
  @media print{body{background:#fff;padding:0}.toolbar{display:none}.sheet{box-shadow:none;width:auto;padding:12mm 10mm}.brand{break-inside:auto}}
</style></head>
<body>
  <div class="toolbar"><button data-action="print">Imprimir / Guardar PDF</button><button class="ghost" data-action="close">Cerrar</button></div>
  <script src="/assets/doc-actions.js"></script>
  <div class="sheet">
    ${watermarkLayer(client, dateStr)}
    <div class="head">
      <div>${logo}<h1 style="margin-top:8px">${filtered ? "Catálogo filtrado" : "Catálogo de productos"}</h1></div>
      <div class="meta">
        <div>Emitido: <b>${dateStr}</b> ${timeStr}</div>
        <div>Documento para: <b>${esc(who)}</b></div>
        ${client.client_code ? `<div>Código: <b>${esc(client.client_code)}</b></div>` : ""}
        <div>${total} productos</div>
      </div>
    </div>
    <div class="company">
      ${company.legalName || company.name ? `<b>${esc(company.legalName || company.name)}</b> · ` : ""}
      Precios mayoristas orientativos en ARS, sujetos a confirmación en la cotización. PVP = precio de venta al público.
    </div>
    ${filtered ? `<div class="filter-note">Selección filtrada${filterSummary ? `: ${esc(filterSummary)}` : ""} · ${total} producto${total === 1 ? "" : "s"}</div>` : ""}
    ${sections || '<p style="color:#999">No hay productos disponibles.</p>'}
    <div class="foot">Documento confidencial para ${esc(who)}${client.client_code ? ` (${esc(client.client_code)})` : ""} · Emitido el ${dateStr} · Prohibida su distribución.</div>
  </div>
</body></html>`;
}
