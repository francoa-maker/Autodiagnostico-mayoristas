import { describe, it, expect } from "vitest";
import { normalizeSku } from "../src/skuNormalize.js";

describe("normalizeSku", () => {
  it("trims, uppercases, and strips internal whitespace", () => {
    expect(normalizeSku("  aut-mx900  ")).toBe("AUT-MX900");
    expect(normalizeSku("aut mx 900")).toBe("AUTMX900");
  });

  it("returns an empty string for null/undefined/blank", () => {
    expect(normalizeSku(null)).toBe("");
    expect(normalizeSku(undefined)).toBe("");
    expect(normalizeSku("   ")).toBe("");
  });

  it("is stable under repeated application", () => {
    const once = normalizeSku("  Aut-MX900 ");
    expect(normalizeSku(once)).toBe(once);
  });
});
