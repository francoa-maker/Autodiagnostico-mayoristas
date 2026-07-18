import { describe, it, expect } from "vitest";
import { isValidCuit, formatCuit, normalizeCuit } from "../src/cuit.js";

describe("isValidCuit", () => {
  it("accepts a valid CUIT (with and without separators)", () => {
    expect(isValidCuit("30-71610175-0")).toBe(true);
    expect(isValidCuit("30716101750")).toBe(true);
  });
  it("rejects a wrong check digit", () => {
    expect(isValidCuit("30-71610175-1")).toBe(false);
  });
  it("rejects wrong length", () => {
    expect(isValidCuit("3071610175")).toBe(false);
    expect(isValidCuit("307161017500")).toBe(false);
    expect(isValidCuit("")).toBe(false);
  });
  it("rejects non-numeric junk", () => {
    expect(isValidCuit("abc")).toBe(false);
  });
});

describe("formatCuit", () => {
  it("formats 11 digits as XX-XXXXXXXX-X", () => {
    expect(formatCuit("30716101750")).toBe("30-71610175-0");
  });
  it("leaves non-11-digit input as-is", () => {
    expect(formatCuit("123")).toBe("123");
  });
});

describe("normalizeCuit", () => {
  it("strips non-digits", () => {
    expect(normalizeCuit("30-71610175-0")).toBe("30716101750");
  });
});
