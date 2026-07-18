import { describe, it, expect } from "vitest";
import { isValidCuit, formatCuit, normalizeCuit, isValidDni, isValidTaxId, formatTaxId, allowedTaxIdTypes, defaultTaxIdType } from "../src/cuit.js";

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

describe("isValidDni", () => {
  it("accepts 7-8 digits", () => {
    expect(isValidDni("12345678")).toBe(true);
    expect(isValidDni("1234567")).toBe(true);
    expect(isValidDni("12.345.678")).toBe(true);
  });
  it("rejects too short/long", () => {
    expect(isValidDni("123456")).toBe(false);
    expect(isValidDni("123456789")).toBe(false);
  });
});

describe("isValidTaxId", () => {
  it("validates CUIT/CUIL with the 11-digit algorithm", () => {
    expect(isValidTaxId("CUIT", "30-71610175-0")).toBe(true);
    expect(isValidTaxId("CUIL", "30716101750")).toBe(true);
    expect(isValidTaxId("CUIT", "30716101751")).toBe(false);
  });
  it("validates DNI by length", () => {
    expect(isValidTaxId("DNI", "12345678")).toBe(true);
    expect(isValidTaxId("DNI", "30716101750")).toBe(false);
  });
});

describe("allowed/default tax id types by condition", () => {
  it("restricts non-CF conditions to CUIT", () => {
    expect(allowedTaxIdTypes("responsable_inscripto")).toEqual(["CUIT"]);
    expect(allowedTaxIdTypes("monotributo")).toEqual(["CUIT"]);
    expect(defaultTaxIdType("responsable_inscripto")).toBe("CUIT");
  });
  it("offers DNI/CUIL/CUIT (default DNI) for consumidor final", () => {
    expect(allowedTaxIdTypes("consumidor_final")).toEqual(["DNI", "CUIL", "CUIT"]);
    expect(defaultTaxIdType("consumidor_final")).toBe("DNI");
  });
});

describe("formatTaxId", () => {
  it("formats DNI with dots and CUIT with dashes", () => {
    expect(formatTaxId("DNI", "12345678")).toBe("12.345.678");
    expect(formatTaxId("CUIT", "30716101750")).toBe("30-71610175-0");
  });
});
