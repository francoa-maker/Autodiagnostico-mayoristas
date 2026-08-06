import fs from "node:fs";
import { describe, expect, it } from "vitest";

const ui = fs.readFileSync(new URL("../public/assets/payments-section.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/routes/collections.js", import.meta.url), "utf8");
const collections = fs.readFileSync(new URL("../src/finance/clientCollections.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

describe("cobranzas por cliente", () => {
  it("gated por el reporte financiero y no por cuenta corriente", () => {
    expect(routes).toContain('"/admin/finance/clients", requireFlag("financial"), requireCapability("financial.reports.view")');
    expect(routes).not.toContain('"/admin/finance/clients", requireFlag("currentAccount")');
  });

  it("monta las rutas de cobranzas antes del router financiero legado", () => {
    expect(server.indexOf('wrapRouterErrors(collectionsRouter)')).toBeLessThan(server.indexOf('wrapRouterErrors(financeRouter)'));
  });

  it("expone vistas por cliente y eCheq sin pedido obligatorio", () => {
    for (const path of ["invoices", "payments", "echeqs", "open-installments"]) expect(routes).toContain(`/admin/clients/:clientId/${path}`);
    expect(routes).toContain('clientId: req.params.clientId');
  });

  it("crea e imputa el pago confirmado dentro de una transacción", () => {
    expect(collections).toContain("export async function registerClientPayment");
    expect(collections).toContain("return withTransaction(async (client)");
    expect(collections).toContain("const allocation = confirmed ? await applyRows");
  });

  it("permite generar, aplicar y revertir saldo a favor", () => {
    expect(collections).toContain("createCustomerCredit");
    expect(collections).toContain("applyCustomerCredit");
    expect(collections).toContain("reverseCustomerCredit");
    expect(collections).toContain('movementType: "balance_applied"');
    expect(ui).toContain("Generar saldo a favor");
    expect(ui).toContain("Saldo a favor aplicado");
  });

  it("no usa JS inline", () => {
    expect(ui).not.toMatch(/onclick\s*=/i);
  });
});
