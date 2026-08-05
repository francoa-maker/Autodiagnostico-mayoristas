// Lógica pura de la carga de facturas y pagos: aritmética de vencimientos,
// validación y reparto FIFO. Sin DOM y sin fetch para poder verificarla contra
// las mismas reglas del servidor.

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function isValidDateString(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function localIsoDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseIsoDate(value) {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "");
  if (!isValidDateString(raw)) return null;
  const date = new Date(raw + "T12:00:00.000Z");
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(isoDate, days) {
  const base = parseIsoDate(isoDate);
  if (!base) return null;
  return toIso(new Date(base.getTime() + Number(days) * 86400000));
}

export const CLIENT_PAYMENT_TERMS = ["contado", "fin_de_mes", "dias_30", "echeq_30"];

export function paymentTermLabelClient(term) {
  return ({
    contado: "Contado",
    fin_de_mes: "Fin de mes",
    dias_30: "30 días",
    echeq_30: "eCheq a 30 días"
  })[term] || term || "Sin definir";
}

export function computeDueDateClient(term, baseDate, { echeqDepositDate = null } = {}) {
  if (!CLIENT_PAYMENT_TERMS.includes(term)) return null;
  const base = parseIsoDate(baseDate);
  if (!base) return null;
  if (term === "contado") return toIso(base);
  if (term === "fin_de_mes") return toIso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 12)));
  if (term === "dias_30") return toIso(new Date(base.getTime() + 30 * 86400000));
  const start = echeqDepositDate ? (parseIsoDate(echeqDepositDate) || base) : base;
  return toIso(new Date(start.getTime() + 30 * 86400000));
}

export function splitEven(total, count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const cents = Math.round(round2(total) * 100);
  const base = Math.floor(cents / n);
  const amounts = new Array(n).fill(base);
  amounts[n - 1] = cents - base * (n - 1);
  return amounts.map((c) => round2(c / 100));
}

export function maxInstallments(total) {
  const cents = Math.round(round2(total) * 100);
  return Math.max(1, Math.min(36, cents));
}

export function buildInstallments(term, issueDate, total, count = 1, { echeqDepositDate = null, intervalDays = 30 } = {}) {
  const amounts = splitEven(total, count);
  const first = computeDueDateClient(term, issueDate, { echeqDepositDate })
    || (isValidDateString(issueDate) ? issueDate : null);
  return amounts.map((amount, index) => ({
    dueDate: index === 0 ? first : addDays(first, index * Number(intervalDays || 30)),
    amount
  }));
}

export function validateInstallments(rows, total, issueDate, { singleRowTakesTotal = true } = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const nonEmpty = source.filter((row) => {
    const date = String(row?.dueDate ?? "").trim();
    const amount = String(row?.amount ?? "").trim();
    return date !== "" || amount !== "";
  });
  let installments = nonEmpty
    .map((row) => ({ dueDate: row.dueDate, amount: round2(row.amount) }))
    .filter((item) => item.amount != null && !Number.isNaN(item.amount));
  if (singleRowTakesTotal && installments.length === 1 && !installments[0].amount) {
    installments = [{ dueDate: installments[0].dueDate, amount: round2(total) }];
  }
  const effective = installments.length ? installments : [{ dueDate: issueDate, amount: round2(total) }];
  for (const item of effective) {
    if (!isValidDateString(item.dueDate)) return { ok: false, code: "vencimiento_fecha_invalida", installments: effective, sum: null, diff: null };
    if (!Number.isFinite(item.amount) || item.amount < 0) return { ok: false, code: "vencimiento_monto_invalido", installments: effective, sum: null, diff: null };
  }
  const sum = round2(effective.reduce((acc, item) => acc + item.amount, 0));
  const diff = round2(round2(total) - sum);
  if (Math.abs(diff) > 0.01) return { ok: false, code: "suma_cuotas_distinta_al_total", installments: effective, sum, diff };
  return { ok: true, code: null, installments: effective, sum, diff };
}

export function absorbRemainder(rows, total) {
  const list = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
  if (!list.length) return list;
  const sum = round2(list.reduce((acc, row) => acc + (Number.isNaN(round2(row.amount)) ? 0 : round2(row.amount)), 0));
  const diff = round2(round2(total) - sum);
  const last = list[list.length - 1];
  const current = Number.isNaN(round2(last.amount)) ? 0 : round2(last.amount);
  last.amount = round2(current + diff);
  return list;
}

export function padPointOfSale(value) {
  const normalized = String(value ?? "").trim();
  return /^\d+$/.test(normalized) ? normalized.padStart(4, "0") : normalized;
}

export function padInvoiceNumber(value) {
  const normalized = String(value ?? "").trim();
  return /^\d+$/.test(normalized) ? normalized.padStart(8, "0") : normalized;
}

export function canonicalInvoiceLabel(type, pointOfSale, invoiceNumber) {
  const normalizedType = String(type || "").trim();
  const normalizedPoint = String(pointOfSale ?? "").trim();
  const normalizedNumber = String(invoiceNumber ?? "").trim();
  if (!normalizedPoint && !normalizedNumber) return normalizedType;
  return `${normalizedType} ${normalizedPoint ? padPointOfSale(normalizedPoint) : "----"}-${normalizedNumber ? padInvoiceNumber(normalizedNumber) : "--------"}`;
}

export function buildPendingInstallments(invoices) {
  const pending = [];
  for (const invoice of Array.isArray(invoices) ? invoices : []) {
    if (invoice.voided_at) continue;
    for (const installment of Array.isArray(invoice.installments) ? invoice.installments : []) {
      const debt = round2(Number(installment.amount) - Number(installment.paid_amount));
      if (debt > 0.005) {
        pending.push({
          id: installment.id,
          invoiceId: invoice.id,
          installmentNumber: installment.installment_number,
          dueDate: installment.due_date,
          label: `${invoice.invoice_type} ${invoice.point_of_sale || ""}-${invoice.invoice_number || "s/n"} · cuota ${installment.installment_number} (vence ${installment.due_date})`,
          debt
        });
      }
    }
  }
  return pending;
}

export function fifoPrefill(pending, available) {
  let left = round2(available);
  if (!Number.isFinite(left) || left <= 0) left = 0;
  return (Array.isArray(pending) ? pending : []).map((row) => {
    const prefill = round2(Math.min(left, row.debt));
    left = round2(left - prefill);
    return { ...row, prefill: prefill > 0 ? prefill : 0 };
  });
}

export const PAY_TILES = [
  ["bank_transfer", "Transferencia", "Comprobante bancario o transferencia"],
  ["cash", "Efectivo", "Cobro recibido en efectivo"],
  ["echeq", "eCheq", "Cheque electrónico recibido"],
  ["other", "Otro", "Otro medio de pago"]
];

export const MONEY_METHOD_VALUES = PAY_TILES.map(([value]) => value).filter((value) => value !== "echeq");
