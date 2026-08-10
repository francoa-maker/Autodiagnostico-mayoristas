import fs from "node:fs";
import { describe, expect, it } from "vitest";

const entry = fs.readFileSync(new URL("../public/assets/progressive-finance.js", import.meta.url), "utf8");
const context = fs.readFileSync(new URL("../public/assets/finance-context.js", import.meta.url), "utf8");
const invoice = fs.readFileSync(new URL("../public/assets/finance-invoice-drawer.js", import.meta.url), "utf8");
const payment = fs.readFileSync(new URL("../public/assets/finance-payment-drawer.js", import.meta.url), "utf8");
const common = fs.readFileSync(new URL("../public/assets/finance-common.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/assets/finance-drawer.css", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

describe("rediseño financiero con panel lateral", () => {
  it("muestra sólo las dos acciones principales y abre un drawer por flujo", () => {
    expect(entry).toContain('<strong>${title}</strong>');
    expect(entry).toContain('title: "Cargar factura"');
    expect(entry).toContain('title: "Cargar pago"');
    expect(entry).toContain("openInvoiceDrawer");
    expect(entry).toContain("openPaymentDrawer");
    expect(css).toContain("#billingDetailBody #financeSection,");
    expect(css).toContain("#billingDetailBody #accountSection { display: none !important; }");
    expect(entry).toContain('invoiceSection.closest("#billingDetailBody")');
    expect(entry).toContain("invoiceSection.hidden || paymentSection.hidden");
  });

  it("captura el pedido activo una sola vez sin modificar admin.js", () => {
    expect(context).toContain("if (installed) return;");
    expect(context).toContain("window.fetch = async");
    expect(context).toContain("/api/admin/quotes/");
    expect(context).toContain('emit("finance:context"');
  });

  it("crea facturas con fecha local, moneda y condición persistida antes del alta", () => {
    expect(invoice).toContain("issueDate: localIsoDate()");
    expect(invoice).toContain("currency: ctx.currency");
    expect(invoice.indexOf("payment-condition")).toBeLessThan(invoice.indexOf("/invoices`, {"));
  });

  it("separa historiales y acciones de facturas y pagos", () => {
    expect(invoice).toContain('sourceId: "finInvoicesList"');
    expect(invoice).not.toContain('sourceId: "paymentsList"');
    for (const source of ["paymentsList", "echeqList", "accountBalance", "accountMovements"]) {
      expect(payment).toContain(`sourceId: "${source}"`);
    }
    expect(common).toContain("confirmDialog");
    expect(common).toContain("data-payreverse");
    expect(common).toContain("data-echrej");
  });

  it("limita el ocultamiento de pestañas al detalle de facturación", () => {
    expect(css).toContain("#billingDetailBody > .v5-tabs");
    expect(css).not.toContain("#quoteDetailBody > .v5-tabs");
    expect(css).not.toContain("#logiDetailAdmin > .v5-tabs");
  });

  it("carga la nueva versión sin caché", () => {
    expect(server).toContain('/assets/progressive-finance.js?v=20260806-drawer2');
  });
});
