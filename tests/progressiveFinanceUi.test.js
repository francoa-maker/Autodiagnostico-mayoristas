import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(new URL("../public/assets/progressive-finance.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

describe("selector financiero de dos acciones", () => {
  it("muestra inicialmente solo cargar factura y cargar pago", () => {
    expect(source).toContain('hub.id = HUB_ID');
    expect(source).toContain('<strong>Cargar factura</strong>');
    expect(source).toContain('<strong>Cargar pago</strong>');
    expect(source).toContain('setFlow(null)');
    expect(source).toContain('.finance-flow-panel {');
    expect(source).toContain('.finance-flow-panel.is-open');
  });

  it("abre un solo flujo por vez y permite volver al inicio", () => {
    expect(source).toContain('invoiceFlow.hide();');
    expect(source).toContain('paymentFlow.hide();');
    expect(source).toContain('if (flow === "invoice") invoiceFlow.open();');
    expect(source).toContain('if (flow === "payment") paymentFlow.open();');
    expect(source).toContain('invoiceFlow.close.addEventListener("click", () => setFlow(null))');
    expect(source).toContain('paymentFlow.close.addEventListener("click", () => setFlow(null))');
  });

  it("mantiene los medios de pago y absorbe eCheq y cuenta corriente", () => {
    for (const method of ["bank_transfer", "cash", "echeq", "other"]) {
      expect(source).toContain(`["${method}"`);
    }
    expect(source).toContain("finance-method-menu");
    expect(source).toContain("finance-legacy-shell");
    expect(source).toContain("finance-embedded-section");
    expect(source).toContain('summary.textContent = "Ver cuenta corriente del cliente"');
  });

  it("reutiliza los formularios existentes sin agregar APIs", () => {
    for (const id of ["financeSection", "paymentsSection", "echeqSection", "accountSection", "finInvoicesList", "paymentsList", "payMethod"]) {
      expect(source).toContain(`"${id}"`);
    }
    expect(source).not.toContain("/api/");
  });

  it("carga la nueva versión sin caché", () => {
    expect(server).toContain('/assets/progressive-finance.js?v=20260805-finance2');
  });
});
