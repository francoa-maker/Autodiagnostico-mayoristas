import { describe, expect, it } from "vitest";
import { normalizeInstallments } from "../src/finance/invoices.js";
import { computeDueDate, PAYMENT_TERMS } from "../src/finance/paymentTerms.js";
import { MONEY_METHODS } from "../src/finance/payments.js";
import {
  localIsoDate, splitEven, buildInstallments, validateInstallments,
  computeDueDateClient, CLIENT_PAYMENT_TERMS, buildPendingInstallments,
  fifoPrefill, MONEY_METHOD_VALUES, canonicalInvoiceLabel
} from "../public/assets/finance-math.js";

describe("cálculos del drawer financiero", () => {
  it("usa fecha calendario local y no UTC", () => {
    const fake = { getFullYear: () => 2026, getMonth: () => 7, getDate: () => 5 };
    expect(localIsoDate(fake)).toBe("2026-08-05");
  });

  it("mantiene paridad con los plazos del backend", () => {
    expect(CLIENT_PAYMENT_TERMS).toEqual(PAYMENT_TERMS);
    for (const term of PAYMENT_TERMS) {
      for (const date of ["2026-07-31", "2026-08-05", "2026-12-20", "2028-02-10"]) {
        expect(computeDueDateClient(term, date)).toBe(computeDueDate(term, date));
      }
    }
  });

  it("reparte cuotas en centavos y siempre cierra el total", () => {
    expect(splitEven(1000, 3)).toEqual([333.33, 333.33, 333.34]);
    expect(splitEven(6.9, 3)).toEqual([2.3, 2.3, 2.3]);
    for (const total of [0.03, 7, 999.99, 1000, 1234.56, 3246500]) {
      for (let count = 1; count <= 6; count += 1) {
        const rows = buildInstallments("dias_30", "2026-08-05", total, count);
        const result = validateInstallments(rows, total, "2026-08-05");
        expect(result.ok).toBe(true);
        expect(() => normalizeInstallments(result.installments, total, "2026-08-05")).not.toThrow();
      }
    }
  });

  it("detecta antes de enviar una suma distinta al total", () => {
    const rows = [{ dueDate: "2026-08-15", amount: 400 }];
    const result = validateInstallments(rows, 1000, "2026-08-05");
    expect(result.code).toBe("suma_cuotas_distinta_al_total");
    expect(() => normalizeInstallments(rows, 1000, "2026-08-05")).toThrow(/suma_cuotas/);
  });

  it("arma el número canónico del comprobante", () => {
    expect(canonicalInvoiceLabel("A", "1", "123")).toBe("A 0001-00000123");
  });

  it("prefill FIFO no excede el pago ni la deuda", () => {
    const invoices = [{
      id: "inv-1", invoice_type: "A", point_of_sale: "0001", invoice_number: "00000123", voided_at: null,
      installments: [
        { id: "i1", installment_number: 1, due_date: "2026-08-01", amount: "100", paid_amount: "0" },
        { id: "i2", installment_number: 2, due_date: "2026-09-01", amount: "50", paid_amount: "0" }
      ]
    }];
    const pending = buildPendingInstallments(invoices);
    expect(fifoPrefill(pending, 120).map((row) => row.prefill)).toEqual([100, 20]);
  });

  it("ofrece por la ruta de pagos sólo los métodos monetarios soportados", () => {
    expect(MONEY_METHOD_VALUES).toEqual(MONEY_METHODS);
  });
});
