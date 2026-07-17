import { describe, it, expect } from "vitest";
import {
  parsePriceCell,
  rowsToSnapshotProducts,
  hashSnapshot,
  diffSnapshot
} from "../src/imports/legacyCatalogImporter.js";

describe("parsePriceCell", () => {
  it("parses a plain ARS amount with thousands separators", () => {
    expect(parsePriceCell("$1.350.000")).toEqual({ state: "value", amount: 1350000, currency: "ARS", label: null });
  });

  it("parses en-US comma thousands as emitted by the Sheet's gviz formatted values", () => {
    expect(parsePriceCell("$ 1,350,000")).toEqual({ state: "value", amount: 1350000, currency: "ARS", label: null });
  });

  it("parses a USD amount", () => {
    expect(parsePriceCell("U$S 250")).toEqual({ state: "value", amount: 250, currency: "USD", label: null });
  });

  it("recognizes Consultar", () => {
    expect(parsePriceCell("Consultar")).toEqual({ state: "consult", amount: null, currency: "ARS", label: null });
  });

  it("treats a blank cell as hidden", () => {
    expect(parsePriceCell("")).toEqual({ state: "hidden", amount: null, currency: "ARS", label: null });
    expect(parsePriceCell("   ")).toEqual({ state: "hidden", amount: null, currency: "ARS", label: null });
  });

  it("falls back to a custom label for unrecognized free text", () => {
    expect(parsePriceCell("Bulto x10")).toEqual({ state: "custom", amount: null, currency: "ARS", label: "Bulto x10" });
  });
});

describe("rowsToSnapshotProducts", () => {
  const header = ["Orden", "Marca", "Categoría", "SKU", "Stock", "Producto", "PVP", "Dist 1 u", "Dist 4 u", "Dist 8 u", "Link publicacion", "Foto URL", "Nota", "Incluir"];

  it("drops rows without SKU and rows with Incluir=FALSE", () => {
    const rows = [
      header,
      [1, "AUTEL", "Escáneres: Auto", "", 5, "Sin SKU", "$1", "$1", "$1", "$1", "", "", "", "TRUE"],
      [2, "AUTEL", "Escáneres: Auto", "AUT-1", 5, "Excluido", "$1", "$1", "$1", "$1", "", "", "", "FALSE"],
      [3, "AUTEL", "Escáneres: Auto", "AUT-2", 5, "Incluido", "$100", "$90", "$85", "$80", "", "", "", "TRUE"]
    ];
    const { products, skippedNoSku, skippedExcluded } = rowsToSnapshotProducts(rows);
    expect(skippedNoSku).toBe(1);
    expect(skippedExcluded).toBe(1);
    expect(products).toHaveLength(1);
    expect(products[0].sku).toBe("AUT-2");
  });

  it("throws when required columns are missing", () => {
    expect(() => rowsToSnapshotProducts([["Marca", "SKU"]])).toThrow(/legacy_source_columns_missing/);
  });
});

describe("hashSnapshot", () => {
  it("hashes differently when only a price differs (regression for the Object.keys(array) bug)", () => {
    const base = { sku: "AUT-1", name: "Autel MX900", prices: { pvp: { state: "value", amount: 100 } } };
    const changed = { ...base, prices: { pvp: { state: "value", amount: 999 } } };
    expect(hashSnapshot([base])).not.toBe(hashSnapshot([changed]));
  });

  it("is stable for identical input", () => {
    const product = { sku: "AUT-1", name: "Autel MX900", prices: { pvp: { state: "value", amount: 100 } } };
    expect(hashSnapshot([product])).toBe(hashSnapshot([{ ...product }]));
  });
});

function priceValue(amount) {
  return { state: "value", amount, currency: "ARS", label: null };
}

describe("diffSnapshot", () => {
  it("classifies new, updated, unchanged, and duplicate SKUs", () => {
    const existing = new Map([
      [
        "AUT-1",
        {
          id: "id-1",
          name: "Autel MX900",
          brand: "AUTEL",
          prices: { pvp: priceValue(100), one: priceValue(90), four: priceValue(85), eight: priceValue(80) }
        }
      ],
      [
        "AUT-2",
        {
          id: "id-2",
          name: "Autel MX808",
          brand: "AUTEL",
          prices: { pvp: priceValue(50), one: priceValue(45), four: priceValue(40), eight: priceValue(35) }
        }
      ]
    ]);

    const incoming = [
      { sku: "AUT-1", name: "Autel MX900", brand: "AUTEL", prices: { pvp: priceValue(999), one: priceValue(90), four: priceValue(85), eight: priceValue(80) } }, // pvp differs but is ignored - stays unchanged
      { sku: "AUT-2", name: "Autel MX808", brand: "AUTEL", prices: { pvp: priceValue(50), one: priceValue(45), four: priceValue(999), eight: priceValue(35) } }, // four changed
      { sku: "AUT-3", name: "Autel MaxiIM", brand: "AUTEL", prices: { pvp: priceValue(1), one: priceValue(1), four: priceValue(1), eight: priceValue(1) } }, // new
      { sku: "aut-3", name: "Autel MaxiIM (dup)", brand: "AUTEL", prices: { pvp: priceValue(1), one: priceValue(1), four: priceValue(1), eight: priceValue(1) } } // duplicate of AUT-3 once normalized
    ];

    const report = diffSnapshot(incoming, existing);
    // AUT-1's pvp differs (100 vs 999) but pvp is never diffed - it's read
    // live from Supabase, not portal-owned - so it stays "unchanged".
    expect(report.unchanged).toEqual(["AUT-1"]);
    expect(report.updated).toEqual([{ sku: "AUT-2", tiersChanged: ["four"] }]);
    expect(report.new).toEqual(["AUT-3"]);
    expect(report.duplicates).toEqual(["aut-3"]);
  });
});
