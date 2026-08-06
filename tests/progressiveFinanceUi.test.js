import fs from "node:fs";
import { describe, expect, it } from "vitest";

const entry = fs.readFileSync(new URL("../public/assets/progressive-finance.js", import.meta.url), "utf8");
const section = fs.readFileSync(new URL("../public/assets/payments-section.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

describe("sección de cobranzas por cliente", () => {
  it("reemplaza el drawer por una sección independiente", () => {
    expect(entry).toContain('import { mountPaymentsSection } from "./payments-section.js"');
    expect(entry).not.toContain("finance-drawer");
    expect(section).toContain('section.id="section-payments"');
    expect(section).toContain('data-section="payments"');
  });

  it("registra cobros multi-pedido, eCheqs y saldo a favor", () => {
    expect(section).toContain('/payments`');
    expect(section).toContain('/echeqs`');
    expect(section).toContain('/credits/apply`');
    expect(section).toContain('singleOrder(finalAlloc)');
    expect(section).toContain('fifoPrefill');
  });

  it("oculta del pedido pagos, eCheqs y cuenta corriente, pero no facturas", () => {
    expect(section).toContain('#billingDetailBody #paymentsSection');
    expect(section).toContain('#billingDetailBody #echeqSection');
    expect(section).toContain('#billingDetailBody #accountSection');
    expect(section).not.toContain('#billingDetailBody #financeSection{display:none');
    expect(section).toContain('b.textContent="Facturación"');
  });

  it("carga la versión anticaché nueva", () => {
    expect(server).toContain('/assets/progressive-finance.js?v=20260806-payments1');
  });
});
