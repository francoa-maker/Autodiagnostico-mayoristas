import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildReceivablesQuery } from "../src/finance/receivables.js";

const oldFlag = process.env.ENABLE_CURRENT_ACCOUNT_MODULE;
beforeEach(() => { process.env.ENABLE_CURRENT_ACCOUNT_MODULE = "true"; });
afterEach(() => { if (oldFlag == null) delete process.env.ENABLE_CURRENT_ACCOUNT_MODULE; else process.env.ENABLE_CURRENT_ACCOUNT_MODULE = oldFlag; });

describe("consulta de cobranzas", () => {
  it("usa el predicado canónico de cuota abierta", () => {
    const q = buildReceivablesQuery();
    expect(q.sql).toContain("ii.paid_amount < ii.amount and ii.status <> 'cancelled'");
  });

  it("parametriza la búsqueda y acota paginación", () => {
    const q = buildReceivablesQuery({ search: "x' or true --", limit: 9999, offset: -3 });
    expect(q.params).toEqual(["%x' or true --%"]);
    expect(q.sql).not.toContain("x' or true");
    expect(q.limit).toBe(200);
    expect(q.offset).toBe(0);
  });

  it("aplica whitelist de orden y dirección", () => {
    const q = buildReceivablesQuery({ sort: "drop table", direction: "sideways" });
    expect(q.sort).toBe("pending");
    expect(q.direction).toBe("desc");
    expect(q.sql).not.toContain("drop table");
  });

  it("no presenta datos del mayor cuando el módulo está apagado", () => {
    process.env.ENABLE_CURRENT_ACCOUNT_MODULE = "false";
    const q = buildReceivablesQuery({ filter: "debt" });
    expect(q.sql).toContain("null ledger_total");
    expect(q.sql).not.toContain("coalesce(led.total,0) > 0");
  });
});
