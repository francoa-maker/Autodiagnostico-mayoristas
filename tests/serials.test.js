import { describe, it, expect } from "vitest";
import { canAddSerials, normalizeSerial, SERIAL_STATUSES } from "../src/logistics/serials.js";

describe("seriales - canAddSerials", () => {
  it("entra si cabe dentro de lo preparado", () => {
    expect(canAddSerials(0, 3, 5)).toBe(true);
  });
  it("entra justo hasta lo preparado", () => {
    expect(canAddSerials(2, 3, 5)).toBe(true);
  });
  it("no entra si supera lo preparado", () => {
    expect(canAddSerials(4, 2, 5)).toBe(false);
  });
  it("no entra si ya está lleno", () => {
    expect(canAddSerials(5, 1, 5)).toBe(false);
  });
  it("con preparado 0 no entra nada", () => {
    expect(canAddSerials(0, 1, 0)).toBe(false);
  });
});

describe("seriales - normalizeSerial", () => {
  it("recorta espacios", () => {
    expect(normalizeSerial("  ABC123  ")).toBe("ABC123");
  });
  it("null/undefined => cadena vacía", () => {
    expect(normalizeSerial(null)).toBe("");
    expect(normalizeSerial(undefined)).toBe("");
  });
  it("convierte números a texto", () => {
    expect(normalizeSerial(12345)).toBe("12345");
  });
});

describe("seriales - constantes", () => {
  it("los estados incluyen assigned y removed", () => {
    expect(SERIAL_STATUSES).toContain("assigned");
    expect(SERIAL_STATUSES).toContain("removed");
  });
});
