// Single source of truth for quote math, shared by the admin recompute path,
// the editor UI, and the proforma.
//
// Business rules:
// - List prices ARE IVA-included. So line subtotals and the total are gross;
//   the neto and IVA amounts are BACKED OUT of the gross for display.
// - IVA is per-line now (each product carries its own rate, default 10,5%),
//   so the proforma discriminates IVA grouped by rate ("Neto 10,5% / IVA
//   10,5% / Neto 21% / IVA 21%"), like a real invoice.
// - A quote-level discount is prorated across lines by their gross share so
//   each rate group reflects its portion of the discount.
// - Shipping/surcharge are added as gross, outside the goods' IVA breakdown.

const DEFAULT_IVA_RATE = 10.5;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function resolveItemUnit(item) {
  // When the column is explicitly present and null, the line is deliberately
  // pending pricing (open monthly order) and must not use a stale snapshot.
  if (Object.prototype.hasOwnProperty.call(item, "quoted_unit_price")) {
    return item.quoted_unit_price == null ? null : Number(item.quoted_unit_price);
  }
  const snap = item.displayed_price_snapshot || {};
  return snap.amount != null ? Number(snap.amount) : null;
}

export function resolveItemRate(item) {
  return item.iva_rate != null && item.iva_rate !== "" ? Number(item.iva_rate) : DEFAULT_IVA_RATE;
}

export function computeQuoteTotals({ items = [], discount = 0, discountType = "nominal", shipping = 0, surcharge = 0 }) {
  const lines = [];
  let itemsGross = 0;
  let unpricedLines = 0;
  for (const it of items) {
    const unit = resolveItemUnit(it);
    if (unit == null) {
      unpricedLines++;
      continue;
    }
    const gross = unit * Number(it.quantity || 0);
    itemsGross += gross;
    lines.push({ gross, rate: resolveItemRate(it) });
  }
  itemsGross = round2(itemsGross);

  const discountAmount =
    discountType === "percent" ? round2(itemsGross * (Number(discount) || 0) / 100) : round2(Number(discount) || 0);

  // Prorratea el descuento por participación de cada línea en el bruto.
  const factor = itemsGross > 0 ? Math.max(0, (itemsGross - discountAmount)) / itemsGross : 0;

  const groups = new Map(); // rate -> { rate, gross }
  for (const line of lines) {
    const discountedGross = line.gross * factor;
    const g = groups.get(line.rate) || { rate: line.rate, gross: 0 };
    g.gross += discountedGross;
    groups.set(line.rate, g);
  }

  const ivaGroups = [...groups.values()]
    .sort((a, b) => a.rate - b.rate)
    .map((g) => {
      const gross = round2(g.gross);
      const neto = round2(gross / (1 + g.rate / 100));
      return { rate: g.rate, gross, neto, iva: round2(gross - neto) };
    });

  const netoTotal = round2(ivaGroups.reduce((s, g) => s + g.neto, 0));
  const ivaTotal = round2(ivaGroups.reduce((s, g) => s + g.iva, 0));
  const goodsAfterDiscount = round2(itemsGross - discountAmount);
  const total = round2(goodsAfterDiscount + (Number(shipping) || 0) + (Number(surcharge) || 0));

  return {
    itemsGross,
    discountAmount,
    goodsAfterDiscount,
    ivaGroups,
    netoTotal,
    ivaTotal,
    shipping: round2(Number(shipping) || 0),
    surcharge: round2(Number(surcharge) || 0),
    total,
    unpricedLines
  };
}
