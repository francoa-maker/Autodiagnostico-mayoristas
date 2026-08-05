import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(new URL("../public/assets/progressive-finance.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

describe("interfaz financiera progresiva", () => {
  it("deja una acción principal para facturas y otra para pagos", () => {
    expect(source).toContain('action.textContent = "Cargar factura"');
    expect(source).toContain('action.textContent = "Informar pago"');
    expect(source).toContain('makeHistory("Ver facturas cargadas"');
    expect(source).toContain('makeHistory("Ver pagos registrados"');
  });

  it("ofrece los medios de pago desde un menú y absorbe eCheq", () => {
    for (const method of ["bank_transfer", "cash", "echeq", "other"]) {
      expect(source).toContain(`["${method}"`);
    }
    expect(source).toContain("simple-finance-menu");
    expect(source).toContain("simple-finance-absorbed");
    expect(source).toContain('echeqHistoryGroup.hidden = disabled');
  });

  it("reutiliza los formularios existentes sin cambiar APIs financieras", () => {
    for (const id of ["finInvoicesList", "finPayCond", "paymentsList", "payMethod", "echeqList"]) {
      expect(source).toContain(`"${id}"`);
    }
    expect(source).not.toContain("/api/");
  });

  it("carga la mejora con versión propia para evitar caché", () => {
    expect(server).toContain('/assets/progressive-finance.js?v=20260805-finance1');
  });
});
