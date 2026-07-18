// Resolución del precio unitario mayorista para un producto + cantidad.
// Reglas (definidas con el cliente):
//  1) Si existe precio para el tier que corresponde a la cantidad → ese.
//  2) Si el producto NO tiene NINGÚN precio mayorista (1u/4u/8u) → PVP menos
//     15% (el PVP ya viene con fallback a precio_web desde Supabase).
//  3) Si tiene algún precio mayorista pero NO para el tier pedido (p. ej. pide
//     más unidades de las estipuladas) → "consultar" (no $0).
//  4) Si no hay tier ni PVP → "consultar".

export const WHOLESALE_DISCOUNT_PCT = 15;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function tierForQuantity(qty) {
  const q = Math.max(1, Math.floor(Number(qty)) || 1);
  if (q >= 8) return "eight";
  if (q >= 4) return "four";
  return "one";
}

function tierAmount(prices, tier) {
  const e = prices ? prices[tier] : null;
  return e && e.state === "value" && e.amount != null ? Number(e.amount) : null;
}

export function hasAnyWholesale(prices) {
  return ["one", "four", "eight"].some((t) => tierAmount(prices, t) != null);
}

// prices: { one, four, eight } con entradas { state, amount } (de
// portal.product_prices). pvp: número|null ya efectivo (precio_efectivo con
// fallback a precio_web). Devuelve { state:'value'|'consult', amount, source }.
export function resolveWholesaleUnit(prices, pvp, quantity, discountPct = WHOLESALE_DISCOUNT_PCT) {
  const tier = tierForQuantity(quantity);
  const direct = tierAmount(prices, tier);
  if (direct != null) return { state: "value", amount: direct, source: "tier" };

  if (!hasAnyWholesale(prices)) {
    const p = pvp != null ? Number(pvp) : null;
    if (p != null && p > 0) return { state: "value", amount: round2(p * (1 - discountPct / 100)), source: "pvp_discount" };
    return { state: "consult", amount: null, source: "none" };
  }
  // Tiene mayorista pero no para este tier: pidió más (o menos) de lo estipulado.
  return { state: "consult", amount: null, source: "tier_missing" };
}
