import { describe, it, expect } from "vitest";
import { statusFor } from "../src/stock/stockRepository.js";

describe("statusFor (customer-facing stock status thresholds)", () => {
  const threshold = 10;

  it("treats null, undefined, and zero as out_of_stock (SKU ausente/NULL/0 rule)", () => {
    expect(statusFor(null, threshold)).toBe("out_of_stock");
    expect(statusFor(undefined, threshold)).toBe("out_of_stock");
    expect(statusFor(0, threshold)).toBe("out_of_stock");
  });

  it("treats 1..threshold as low_stock", () => {
    expect(statusFor(1, threshold)).toBe("low_stock");
    expect(statusFor(10, threshold)).toBe("low_stock");
  });

  it("treats anything above threshold as in_stock", () => {
    expect(statusFor(11, threshold)).toBe("in_stock");
    expect(statusFor(500, threshold)).toBe("in_stock");
  });

  it("respects a configurable threshold, not just the default of 10", () => {
    expect(statusFor(3, 2)).toBe("in_stock");
    expect(statusFor(2, 2)).toBe("low_stock");
  });
});
