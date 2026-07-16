// Single normalization rule shared by the legacy importer and the stock
// read-model, so `portal.products.sku_normalized` always lines up with the
// same transform applied to the stock source's SKU column. Changing this
// after the initial import requires re-running the importer's --apply.
export function normalizeSku(rawSku) {
  return String(rawSku ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}
