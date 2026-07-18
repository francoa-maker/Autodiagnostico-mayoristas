import { describe, it, expect } from "vitest";
import { tierForQuantity, hasAnyWholesale, resolveWholesaleUnit } from "../src/pricing.js";

const val = (amount) => ({ state: "value", amount });

describe("tierForQuantity", () => {
  it("maps quantity to tier", () => {
    expect(tierForQuantity(1)).toBe("one");
    expect(tierForQuantity(3)).toBe("one");
    expect(tierForQuantity(4)).toBe("four");
    expect(tierForQuantity(7)).toBe("four");
    expect(tierForQuantity(8)).toBe("eight");
    expect(tierForQuantity(100)).toBe("eight");
  });
});

describe("resolveWholesaleUnit", () => {
  it("uses the exact tier price when present", () => {
    const prices = { one: val(1000), four: val(900), eight: val(800) };
    expect(resolveWholesaleUnit(prices, 2000, 1)).toEqual({ state: "value", amount: 1000, source: "tier" });
    expect(resolveWholesaleUnit(prices, 2000, 5)).toEqual({ state: "value", amount: 900, source: "tier" });
    expect(resolveWholesaleUnit(prices, 2000, 10)).toEqual({ state: "value", amount: 800, source: "tier" });
  });

  it("falls back to 15% off PVP when there is NO wholesale price at all", () => {
    const r = resolveWholesaleUnit({}, 1000, 1);
    expect(r).toEqual({ state: "value", amount: 850, source: "pvp_discount" });
  });

  it("uses 15% off PVP for any quantity when no wholesale exists", () => {
    expect(resolveWholesaleUnit({}, 1000, 20).amount).toBe(850);
  });

  it("says consultar when a tier is missing but other wholesale prices exist", () => {
    const prices = { one: val(1000) }; // sólo 1u
    const r = resolveWholesaleUnit(prices, 5000, 8); // pide 8 → tier eight, sin precio
    expect(r.state).toBe("consult");
    expect(r.amount).toBe(null);
  });

  it("says consultar when there is neither tier nor PVP", () => {
    expect(resolveWholesaleUnit({}, null, 1)).toEqual({ state: "consult", amount: null, source: "none" });
    expect(resolveWholesaleUnit({}, 0, 1).state).toBe("consult");
  });

  it("hasAnyWholesale detects presence of any tier price", () => {
    expect(hasAnyWholesale({})).toBe(false);
    expect(hasAnyWholesale({ four: val(900) })).toBe(true);
    expect(hasAnyWholesale({ one: { state: "hidden", amount: null } })).toBe(false);
  });
});
