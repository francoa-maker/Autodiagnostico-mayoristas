import { describe, it, expect } from "vitest";
import { normalizeInstallments, installmentDisplayStatus, PAYMENT_CONDITIONS, INVOICE_TYPES } from "../src/finance/invoices.js";

describe("facturas - normalizeInstallments", () => {
  it("sin cuotas => una sola por el total con vencimiento = emisión", () => {
    const r = normalizeInstallments([], 1000, "2026-07-23");
    expect(r).toEqual([{ dueDate: "2026-07-23", amount: 1000 }]);
  });
  it("cuotas que suman el total => OK", () => {
    const r = normalizeInstallments([{ dueDate: "2026-08-01", amount: 400 }, { dueDate: "2026-09-01", amount: 600 }], 1000, "2026-07-23");
    expect(r.length).toBe(2);
  });
  it("suma distinta al total => error", () => {
    expect(() => normalizeInstallments([{ dueDate: "2026-08-01", amount: 400 }], 1000, "2026-07-23")).toThrow(/suma_cuotas/);
  });
  it("tolera centavos de redondeo", () => {
    expect(() => normalizeInstallments([{ dueDate: "2026-08-01", amount: 333.33 }, { dueDate: "2026-09-01", amount: 333.33 }, { dueDate: "2026-10-01", amount: 333.34 }], 1000, "2026-07-23")).not.toThrow();
  });
  it("fecha inválida => error", () => {
    expect(() => normalizeInstallments([{ dueDate: "no-fecha", amount: 1000 }], 1000, "2026-07-23")).toThrow(/fecha_invalida/);
  });
  it("monto negativo => error", () => {
    expect(() => normalizeInstallments([{ dueDate: "2026-08-01", amount: -5 }], -5, "2026-07-23")).toThrow(/monto_invalido/);
  });
});

describe("facturas - installmentDisplayStatus", () => {
  const today = new Date("2026-07-23T12:00:00");
  it("pagada cuando paid >= amount", () => {
    expect(installmentDisplayStatus({ amount: 100, paid_amount: 100, due_date: "2026-07-01", status: "pending" }, today)).toBe("paid");
  });
  it("vencida cuando pasó la fecha y no está paga", () => {
    expect(installmentDisplayStatus({ amount: 100, paid_amount: 0, due_date: "2026-07-01", status: "pending" }, today)).toBe("overdue");
  });
  it("pendiente cuando falta y no venció", () => {
    expect(installmentDisplayStatus({ amount: 100, paid_amount: 0, due_date: "2026-08-01", status: "pending" }, today)).toBe("pending");
  });
  it("parcial cuando hay algo pago y no venció", () => {
    expect(installmentDisplayStatus({ amount: 100, paid_amount: 40, due_date: "2026-08-01", status: "pending" }, today)).toBe("partially_paid");
  });
  it("cancelada respeta el estado", () => {
    expect(installmentDisplayStatus({ amount: 100, paid_amount: 0, due_date: "2026-01-01", status: "cancelled" }, today)).toBe("cancelled");
  });
  it("acepta fechas devueltas por pg como Date", () => {
    expect(installmentDisplayStatus({ amount: 100, paid_amount: 0, due_date: new Date(2026, 6, 7), status: "pending" }, today)).toBe("overdue");
  });
  it("mantiene pendiente una fecha Date futura", () => {
    expect(installmentDisplayStatus({ amount: 100, paid_amount: 0, due_date: new Date(2026, 7, 7), status: "pending" }, today)).toBe("pending");
  });
});

describe("facturas - constantes", () => {
  it("condiciones de pago y tipos", () => {
    expect(PAYMENT_CONDITIONS).toContain("cuenta_corriente");
    expect(PAYMENT_CONDITIONS).toContain("mixto");
    expect(INVOICE_TYPES).toContain("nota_credito");
  });
});
