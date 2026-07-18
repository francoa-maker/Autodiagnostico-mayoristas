// Single source of truth for quote math, shared by the admin recompute path
// (stored quoted_subtotal/tax/quoted_total), the editor UI, and the proforma.
//
// Key rule from the business: list prices ARE IVA-included. So the item
// subtotal and the total are gross (IVA in); the "neto gravado" and the IVA
// amount are BACKED OUT of the gross using the quote's iva_rate, purely for
// display/discrimination - they are not added on top.

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Resolve a line's unit price: the admin's quoted override wins, else the
// customer-facing displayed snapshot amount, else null (not priced).
export function resolveItemUnit(item) {
  if (item.quoted_unit_price != null) return Number(item.quoted_unit_price);
  const snap = item.displayed_price_snapshot || {};
  return snap.amount != null ? Number(snap.amount) : null;
}

export function computeQuoteTotals({ items = [], discount = 0, discountType = "nominal", shipping = 0, surcharge = 0, ivaRate = 21 }) {
  let itemsGross = 0;
  for (const it of items) {
    const unit = resolveItemUnit(it);
    if (unit != null) itemsGross += unit * Number(it.quantity || 0);
  }
  itemsGross = round2(itemsGross);

  const discountAmount =
    discountType === "percent" ? round2(itemsGross * (Number(discount) || 0) / 100) : round2(Number(discount) || 0);

  const baseGross = round2(itemsGross - discountAmount + (Number(shipping) || 0) + (Number(surcharge) || 0));
  const rate = Number(ivaRate) || 0;
  const neto = round2(baseGross / (1 + rate / 100));
  const iva = round2(baseGross - neto);
  const total = baseGross;

  return { itemsGross, discountAmount, baseGross, neto, iva, total, ivaRate: rate };
}
