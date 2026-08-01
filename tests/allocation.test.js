import { describe, expect, it } from "vitest";
import { validateAllocationPlan } from "../src/finance/payments.js";

describe("asignación de pagos", () => {
  it("acepta repartir un pago entre varias cuotas del mismo cliente", () => {
    expect(validateAllocationPlan(1000, [{ installmentId: "a", amount: 400 }, { installmentId: "b", amount: 600 }])).toEqual({ sum: 1000, available: 1000 });
  });
  it("rechaza asignar más que el saldo disponible", () => {
    expect(() => validateAllocationPlan(1000, [{ installmentId: "a", amount: 1000 }], 100)).toThrow("excede_saldo_del_pago");
  });
});
