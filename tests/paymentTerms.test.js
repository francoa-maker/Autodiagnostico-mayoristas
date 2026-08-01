import { describe, expect, it } from "vitest";
import { computeDueDate } from "../src/finance/paymentTerms.js";

describe("computeDueDate", () => {
  it("mantiene la fecha para contado", () => {
    expect(computeDueDate("contado", "2026-07-31")).toBe("2026-07-31");
  });
  it("calcula el último día del mes incluso en febrero", () => {
    expect(computeDueDate("fin_de_mes", "2028-02-10")).toBe("2028-02-29");
  });
  it("suma treinta días sin depender de la zona horaria", () => {
    expect(computeDueDate("dias_30", "2026-12-20")).toBe("2027-01-19");
  });
  it("usa la fecha de depósito del eCheq", () => {
    expect(computeDueDate("echeq_30", "2026-08-01", { echeqDepositDate: "2026-08-15" })).toBe("2026-09-14");
  });
});
