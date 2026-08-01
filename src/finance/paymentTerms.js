const DAY_MS = 86400000;

function parseDate(value) {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw Object.assign(new Error("fecha_invalida"), { statusCode: 400 });
  }
  const date = new Date(raw + "T12:00:00.000Z");
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error("fecha_invalida"), { statusCode: 400 });
  return date;
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

export const PAYMENT_TERMS = ["contado", "fin_de_mes", "dias_30", "echeq_30"];

export function computeDueDate(term, baseDate = new Date(), { echeqDepositDate = null } = {}) {
  if (!PAYMENT_TERMS.includes(term)) {
    throw Object.assign(new Error("condicion_de_pago_invalida"), { statusCode: 400 });
  }
  const base = parseDate(baseDate);
  if (term === "contado") return iso(base);
  if (term === "fin_de_mes") return iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 12)));
  if (term === "dias_30") return iso(new Date(base.getTime() + 30 * DAY_MS));
  const start = echeqDepositDate ? parseDate(echeqDepositDate) : base;
  return iso(new Date(start.getTime() + 30 * DAY_MS));
}

export function paymentTermLabel(term) {
  return ({
    contado: "Contado",
    fin_de_mes: "Fin de mes",
    dias_30: "30 días",
    echeq_30: "eCheq a 30 días"
  })[term] || term || "Sin definir";
}
