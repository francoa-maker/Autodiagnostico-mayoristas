import { normalizeSku } from "./skuNormalize.js";

const DEFAULT_STORE_URL = "https://autodiagnostico.com.ar";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function normalizedText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function firstUsefulCategory(product) {
  const blocked = new Set(["productos destacados", "featured", "uncategorized", "sin categoria"]);
  const categories = Array.isArray(product?.categories) ? product.categories : [];
  return categories.find((category) => !blocked.has(normalizedText(category?.name)))?.name || "Sin categoría";
}

function inferBrand(product, knownBrands = []) {
  const explicit = Array.isArray(product?.brands) ? product.brands.find((brand) => brand?.name)?.name : null;
  if (explicit) return explicit;

  const categoryNames = new Set((Array.isArray(product?.categories) ? product.categories : []).map((category) => normalizedText(category?.name)));
  const haystack = normalizedText(`${product?.name || ""} ${product?.slug || ""}`);
  const candidates = knownBrands
    .filter(Boolean)
    .map(String)
    .sort((a, b) => b.length - a.length);

  for (const brand of candidates) {
    const normalized = normalizedText(brand);
    if (!normalized) continue;
    if (categoryNames.has(normalized) || haystack.includes(normalized)) return brand;
  }
  return "OTRAS MARCAS";
}

export function normalizeWooProduct(product, knownBrands = []) {
  const sku = String(product?.sku || "").trim();
  const skuNormalized = normalizeSku(sku);
  if (!skuNormalized) return null;
  const image = Array.isArray(product?.images) ? product.images.find((item) => item?.src)?.src : null;
  return {
    sku,
    skuNormalized,
    name: String(product?.name || sku).trim() || sku,
    brand: inferBrand(product, knownBrands),
    category: firstUsefulCategory(product),
    imageUrl: image || null,
    publicationUrl: product?.permalink || null
  };
}

export function prepareWooProducts(rawProducts, knownBrands = []) {
  const products = [];
  const seen = new Set();
  const duplicateWebSkus = [];
  let skippedNoSku = 0;

  for (const raw of rawProducts || []) {
    const normalized = normalizeWooProduct(raw, knownBrands);
    if (!normalized) {
      skippedNoSku += 1;
      continue;
    }
    if (seen.has(normalized.skuNormalized)) {
      duplicateWebSkus.push(normalized.sku);
      continue;
    }
    seen.add(normalized.skuNormalized);
    products.push(normalized);
  }
  return { products, skippedNoSku, duplicateWebSkus };
}

export function buildWooSyncPlan(webProducts, portalProducts, { deactivateMissing = true } = {}) {
  const portalBySku = new Map((portalProducts || []).filter((row) => row.sku_normalized).map((row) => [row.sku_normalized, row]));
  const webSkuSet = new Set((webProducts || []).map((row) => row.skuNormalized));
  const created = [];
  const reactivated = [];
  const unchanged = [];
  const deactivated = [];
  const missingFromWeb = [];

  for (const product of webProducts || []) {
    const current = portalBySku.get(product.skuNormalized);
    if (!current) created.push(product);
    else if (!current.active) reactivated.push({ current, product });
    else unchanged.push({ current, product });
  }

  // Los faltantes se listan siempre para poder informarlos, pero sólo pasan a
  // `deactivated` cuando la sincronización completa lo pide. El botón "Agregar
  // productos nuevos" usa deactivateMissing:false para no tocar nada existente.
  for (const current of portalProducts || []) {
    if (current.active && current.sku_normalized && !webSkuSet.has(current.sku_normalized)) {
      missingFromWeb.push(current);
      if (deactivateMissing) deactivated.push(current);
    }
  }

  return { created, reactivated, unchanged, deactivated, missingFromWeb };
}

export async function fetchWooCommerceCatalog({ baseUrl = process.env.WOOCOMMERCE_STORE_URL || DEFAULT_STORE_URL, fetchImpl = fetch } = {}) {
  const base = String(baseUrl || DEFAULT_STORE_URL).replace(/\/+$/, "");
  const products = [];
  let page = 1;
  let totalPages = null;

  while (page <= MAX_PAGES) {
    const url = new URL(`${base}/wp-json/wc/store/v1/products`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "Autodiagnostico-Mayoristas/1.0" },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const error = new Error(`woocommerce_http_${response.status}`);
      error.statusCode = 502;
      throw error;
    }
    const rows = await response.json();
    if (!Array.isArray(rows)) {
      const error = new Error("woocommerce_invalid_response");
      error.statusCode = 502;
      throw error;
    }
    products.push(...rows);

    const headerPages = Number(response.headers?.get?.("x-wp-totalpages"));
    if (Number.isFinite(headerPages) && headerPages >= 0) totalPages = headerPages;
    if ((totalPages !== null && page >= totalPages) || (totalPages === null && rows.length < PAGE_SIZE) || rows.length === 0) break;
    page += 1;
  }

  if (page > MAX_PAGES) {
    const error = new Error("woocommerce_too_many_pages");
    error.statusCode = 502;
    throw error;
  }
  return products;
}
