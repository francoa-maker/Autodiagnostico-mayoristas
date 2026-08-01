import { describe, it, expect } from "vitest";
import { computeQuoteTotals, resolveItemUnit, resolveItemRate } from "../src/quoteTotals.js";

const item = (unit, qty, rate, quoted) => {
  const row = {
    quantity: qty,
    iva_rate: rate,
    displayed_price_snapshot: unit == null ? {} : { amount: unit }
  };
  if (quoted !== undefined) row.quoted_unit_price = quoted;
  return row;
};

describe("resolveItemUnit", () => {
  it("prefers the admin's quoted unit price over the displayed snapshot", () => {
    expect(resolveItemUnit(item(1000, 1, 21, 800))).toBe(800);
  });
  it("falls back to the displayed snapshot amount for legacy rows", () => {
    expect(resolveItemUnit(item(1000, 1, 21))).toBe(1000);
  });
  it("treats an explicitly null quoted price as pending pricing", () => {
    expect(resolveItemUnit(item(1000, 1, 21, null))).toBeNull();
    const totals = computeQuoteTotals({ items: [item(1000, 2, 21, null)] });
    expect(totals.itemsGross).toBe(0);
    expect(totals.unpricedLines).toBe(1);
  });
});

describe("resolveItemRate", () => {
  it("defaults to 10.5 when the item has no rate", () => {
    expect(resolveItemRate({ quantity: 1 })).toBe(10.5);
  });
  it("uses the item's own rate", () => {
    expect(resolveItemRate({ quantity: 1, iva_rate: 21 })).toBe(21);
  });
});

describe("computeQuoteTotals (IVA por línea)", () => {
  it("backs out 10.5% IVA from an IVA-included price", () => {
    const t = computeQuoteTotals({ items: [item(1105, 1, 10.5)] });
    expect(t.itemsGross).toBe(1105);
    expect(t.total).toBe(1105);
    expect(t.ivaGroups).toHaveLength(1);
    expect(t.ivaGroups[0].rate).toBe(10.5);
    expect(t.ivaGroups[0].neto).toBe(1000);
    expect(t.ivaGroups[0].iva).toBe(105);
  });

  it("groups two different rates separately", () => {
    const t = computeQuoteTotals({ items: [item(1105, 1, 10.5), item(1210, 1, 21)] });
    expect(t.ivaGroups.map((g) => g.rate)).toEqual([10.5, 21]);
    const g105 = t.ivaGroups.find((g) => g.rate === 10.5);
    const g21 = t.ivaGroups.find((g) => g.rate === 21);
    expect(g105.neto).toBe(1000);
    expect(g105.iva).toBe(105);
    expect(g21.neto).toBe(1000);
    expect(g21.iva).toBe(210);
    expect(t.netoTotal).toBe(2000);
    expect(t.ivaTotal).toBe(315);
    expect(t.total).toBe(2315);
  });

  it("prorates a nominal discount across rate groups", () => {
    // Dos líneas iguales de 1000 gross, distinta alícuota; 10% off => 900 c/u.
    const t = computeQuoteTotals({ items: [item(1000, 1, 10.5), item(1000, 1, 21)], discount: 200, discountType: "nominal" });
    expect(t.discountAmount).toBe(200);
    expect(t.goodsAfterDiscount).toBe(1800);
    const g105 = t.ivaGroups.find((g) => g.rate === 10.5);
    const g21 = t.ivaGroups.find((g) => g.rate === 21);
    expect(g105.gross).toBe(900);
    expect(g21.gross).toBe(900);
    expect(t.total).toBe(1800);
  });

  it("applies a percentage discount on the gross subtotal", () => {
    const t = computeQuoteTotals({ items: [item(1000, 2, 21)], discount: 10, discountType: "percent" });
    expect(t.itemsGross).toBe(2000);
    expect(t.discountAmount).toBe(200);
    expect(t.total).toBe(1800);
  });

  it("adds shipping as gross outside the IVA breakdown", () => {
    const t = computeQuoteTotals({ items: [item(1105, 1, 10.5)], shipping: 500 });
    expect(t.total).toBe(1605);
    expect(t.netoTotal).toBe(1000); // el envío no entra al neto gravado de bienes
  });
});
