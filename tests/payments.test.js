import { describe, it, expect } from "vitest";
import { computeOrderPaymentState, PAYMENT_METHODS, MONEY_METHODS } from "../src/finance/payments.js";

describe("pagos - computeOrderPaymentState", () => {
  it("sin facturar => unpaid", () => {
    expect(computeOrderPaymentState({ invoiced: 0, applied: 0, hasOverdue: false })).toBe("unpaid");
  });
  it("nada aplicado => unpaid", () => {
    expect(computeOrderPaymentState({ invoiced: 1000, applied: 0, hasOverdue: false })).toBe("unpaid");
  });
  it("parcial => partially_paid", () => {
    expect(computeOrderPaymentState({ invoiced: 1000, applied: 400, hasOverdue: false })).toBe("partially_paid");
  });
  it("total => paid", () => {
    expect(computeOrderPaymentState({ invoiced: 1000, applied: 1000, hasOverdue: false })).toBe("paid");
  });
  it("excedente => overpaid", () => {
    expect(computeOrderPaymentState({ invoiced: 1000, applied: 1200, hasOverdue: false })).toBe("overpaid");
  });
  it("vencido pesa sobre parcial", () => {
    expect(computeOrderPaymentState({ invoiced: 1000, applied: 400, hasOverdue: true })).toBe("overdue");
  });
  it("pagado pesa sobre vencido", () => {
    expect(computeOrderPaymentState({ invoiced: 1000, applied: 1000, hasOverdue: true })).toBe("paid");
  });
  it("eCheq aceptado que cubre => pending_accreditation", () => {
    expect(computeOrderPaymentState({ invoiced: 1000, applied: 0, hasOverdue: false, pendingAccreditation: 1000 })).toBe("pending_accreditation");
  });
  it("tolera centavos", () => {
    expect(computeOrderPaymentState({ invoiced: 1000, applied: 999.999, hasOverdue: false })).toBe("paid");
  });
});

describe("pagos - métodos", () => {
  it("los money-methods de esta etapa son subconjunto", () => {
    expect(MONEY_METHODS).toEqual(["cash", "bank_transfer", "other"]);
    expect(PAYMENT_METHODS).toContain("echeq");
    expect(PAYMENT_METHODS).toContain("current_account");
  });
});
