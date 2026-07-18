import { describe, it, expect } from "vitest";
import { computeQuoteTotals, resolveItemUnit } from "../src/quoteTotals.js";

const item = (unit, qty, quoted) => ({
  quantity: qty,
  quoted_unit_price: quoted ?? null,
  displayed_price_snapshot: unit == null ? {} : { amount: unit }
});

describe("resolveItemUnit", () => {
  it("prefers the admin's quoted unit price over the displayed snapshot", () => {
    expect(resolveItemUnit(item(1000, 1, 800))).toBe(800);
  });
  it("falls back to the displayed snapshot amount", () => {
    expect(resolveItemUnit(item(1000, 1))).toBe(1000);
  });
  it("returns null when nothing is priced", () => {
    expect(resolveItemUnit(item(null, 1))).toBe(null);
  });
});

describe("computeQuoteTotals", () => {
  it("sums IVA-included line items and backs out 21% IVA", () => {
    const t = computeQuoteTotals({ items: [item(1210, 1)], ivaRate: 21 });
    expect(t.itemsGross).toBe(1210);
    expect(t.total).toBe(1210); // IVA included, total unchanged
    expect(t.neto).toBe(1000);
    expect(t.iva).toBe(210);
  });

  it("supports 10.5% IVA", () => {
    const t = computeQuoteTotals({ items: [item(1105, 1)], ivaRate: 10.5 });
    expect(t.neto).toBe(1000);
    expect(t.iva).toBe(105);
    expect(t.total).toBe(1105);
  });

  it("treats 0% IVA as neto == total", () => {
    const t = computeQuoteTotals({ items: [item(1000, 1)], ivaRate: 0 });
    expect(t.neto).toBe(1000);
    expect(t.iva).toBe(0);
    expect(t.total).toBe(1000);
  });

  it("applies a nominal discount before backing out IVA", () => {
    const t = computeQuoteTotals({ items: [item(1210, 1)], discount: 210, discountType: "nominal", ivaRate: 21 });
    expect(t.discountAmount).toBe(210);
    expect(t.total).toBe(1000);
    expect(t.neto).toBeCloseTo(826.45, 2);
    expect(t.iva).toBeCloseTo(173.55, 2);
  });

  it("applies a percentage discount on the gross items subtotal", () => {
    const t = computeQuoteTotals({ items: [item(1000, 2)], discount: 10, discountType: "percent", ivaRate: 21 });
    expect(t.itemsGross).toBe(2000);
    expect(t.discountAmount).toBe(200);
    expect(t.total).toBe(1800);
  });

  it("adds shipping as an IVA-included amount", () => {
    const t = computeQuoteTotals({ items: [item(1210, 1)], shipping: 500, ivaRate: 21 });
    expect(t.total).toBe(1710);
  });

  it("multiplies unit by quantity", () => {
    const t = computeQuoteTotals({ items: [item(100, 3)], ivaRate: 0 });
    expect(t.itemsGross).toBe(300);
  });
});
