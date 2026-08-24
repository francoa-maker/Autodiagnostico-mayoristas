import { describe, it, expect, vi } from "vitest";
import {
  normalizeWooProduct,
  prepareWooProducts,
  buildWooSyncPlan,
  fetchWooCommerceCatalog
} from "../src/woocommerceCatalogSync.js";

describe("WooCommerce catalog sync", () => {
  it("normaliza un producto nuevo y conserva datos útiles de la web", () => {
    const product = normalizeWooProduct({
      sku: " mx 900 ",
      name: "AUTEL MaxiCheck MX900",
      permalink: "https://autodiagnostico.com.ar/producto/mx900/",
      images: [{ src: "https://example.com/mx900.jpg" }],
      categories: [{ name: "Productos Destacados" }, { name: "Escáneres: Auto" }]
    }, ["Autel", "Launch"]);

    expect(product).toEqual({
      sku: "mx 900",
      skuNormalized: "MX900",
      name: "AUTEL MaxiCheck MX900",
      brand: "Autel",
      category: "Escáneres: Auto",
      imageUrl: "https://example.com/mx900.jpg",
      publicationUrl: "https://autodiagnostico.com.ar/producto/mx900/"
    });
  });

  it("omite productos sin SKU y duplicados por SKU normalizado", () => {
    const result = prepareWooProducts([
      { sku: "A 1", name: "A" },
      { sku: "", name: "Sin SKU" },
      { sku: "a1", name: "Duplicado" }
    ]);
    expect(result.products).toHaveLength(1);
    expect(result.skippedNoSku).toBe(1);
    expect(result.duplicateWebSkus).toEqual(["a1"]);
  });

  it("crea, reactiva, conserva y desactiva según presencia en la web", () => {
    const web = [
      { sku: "A", skuNormalized: "A" },
      { sku: "B", skuNormalized: "B" },
      { sku: "C", skuNormalized: "C" }
    ];
    const portal = [
      { id: "1", sku: "A", sku_normalized: "A", active: true },
      { id: "2", sku: "B", sku_normalized: "B", active: false },
      { id: "3", sku: "D", sku_normalized: "D", active: true }
    ];
    const plan = buildWooSyncPlan(web, portal);
    expect(plan.created.map((item) => item.sku)).toEqual(["C"]);
    expect(plan.reactivated.map((item) => item.product.sku)).toEqual(["B"]);
    expect(plan.unchanged.map((item) => item.product.sku)).toEqual(["A"]);
    expect(plan.deactivated.map((item) => item.sku)).toEqual(["D"]);
  });

  it("pagina el Store API antes de devolver el catálogo completo", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ sku: `A${i}` }));
    const second = [{ sku: "B1" }];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (name) => name.toLowerCase() === "x-wp-totalpages" ? "2" : null },
        json: async () => first
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (name) => name.toLowerCase() === "x-wp-totalpages" ? "2" : null },
        json: async () => second
      });

    const result = await fetchWooCommerceCatalog({ baseUrl: "https://example.com", fetchImpl });
    expect(result).toHaveLength(101);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain("page=2");
  });
});

describe("Modo agregar productos nuevos", () => {
  const web = [
    { sku: "A", skuNormalized: "A" },
    { sku: "B", skuNormalized: "B" },
    { sku: "C", skuNormalized: "C" }
  ];
  const portal = [
    { id: "1", sku: "A", sku_normalized: "A", active: true },
    { id: "2", sku: "B", sku_normalized: "B", active: false },
    { id: "3", sku: "D", sku_normalized: "D", active: true }
  ];

  it("con deactivateMissing:false no desactiva nada pero informa los faltantes", () => {
    const plan = buildWooSyncPlan(web, portal, { deactivateMissing: false });
    expect(plan.created.map((item) => item.sku)).toEqual(["C"]);
    expect(plan.deactivated).toEqual([]);
    expect(plan.missingFromWeb.map((item) => item.sku)).toEqual(["D"]);
  });

  it("la sincronizacion completa sigue desactivando por defecto", () => {
    const plan = buildWooSyncPlan(web, portal);
    expect(plan.deactivated.map((item) => item.sku)).toEqual(["D"]);
    expect(plan.missingFromWeb.map((item) => item.sku)).toEqual(["D"]);
  });

  it("no crea nada cuando la web no aporta SKU nuevos", () => {
    const plan = buildWooSyncPlan(
      [{ sku: "A", skuNormalized: "A" }],
      [{ id: "1", sku: "A", sku_normalized: "A", active: true }],
      { deactivateMissing: false }
    );
    expect(plan.created).toEqual([]);
    expect(plan.deactivated).toEqual([]);
    expect(plan.missingFromWeb).toEqual([]);
  });
});
