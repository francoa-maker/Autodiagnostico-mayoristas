import { pool } from "../db.js";
import { flags } from "../featureFlags.js";

const OPEN_INSTALLMENT = "ii.paid_amount < ii.amount and ii.status <> 'cancelled'";
const SORTS = {
  pending: "coalesce(inst.pending_total,0)",
  overdue: "coalesce(inst.overdue,0)",
  debt: "coalesce(led.total,0)",
  unapplied: "coalesce(unap.unapplied,0)",
  client: "coalesce(u.company_name,u.display_name,u.email)"
};

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function buildReceivablesQuery({ search = "", filter = "all", sort = "pending", direction = "desc", limit = 50, offset = 0 } = {}) {
  const params = [];
  const where = ["u.role in ('client','customer')", "u.status = 'approved'"];
  const normalizedSearch = String(search || "").trim();
  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    where.push(`(u.display_name ilike $${params.length} or u.company_name ilike $${params.length} or u.email ilike $${params.length} or u.client_code ilike $${params.length} or u.tax_cuit ilike $${params.length})`);
  }
  const requestedFilter = ["all", "overdue", "debt", "unapplied", "favor"].includes(filter) ? filter : "all";
  const validFilter = (!flags.currentAccount && ["debt", "favor"].includes(requestedFilter)) ? "all" : requestedFilter;
  if (validFilter === "overdue") where.push("coalesce(inst.overdue,0) > 0");
  if (validFilter === "debt") where.push("coalesce(led.total,0) > 0");
  if (validFilter === "unapplied") where.push("coalesce(unap.unapplied,0) > 0");
  if (validFilter === "favor") where.push("coalesce(led.total,0) < 0");

  const normalizedSort = SORTS[sort] ? sort : "pending";
  const normalizedDirection = String(direction).toLowerCase() === "asc" ? "asc" : "desc";
  const normalizedLimit = clampInt(limit, 50, 1, 200);
  const normalizedOffset = clampInt(offset, 0, 0, 1000000);
  const orderSql = `${SORTS[normalizedSort]} ${normalizedDirection}, coalesce(u.company_name,u.display_name,u.email) asc, u.id asc`;

  const ctes = `
    with led as (
      select client_id, sum(debit_amount)-sum(credit_amount) total
      from portal.account_movements where status='active' group by client_id
    ), inst as (
      select i.client_id,
        sum(case when ${OPEN_INSTALLMENT} and ii.due_date < current_date then ii.amount-ii.paid_amount else 0 end) overdue,
        sum(case when ${OPEN_INSTALLMENT} and ii.due_date >= current_date then ii.amount-ii.paid_amount else 0 end) to_due,
        sum(case when ${OPEN_INSTALLMENT} then ii.amount-ii.paid_amount else 0 end) pending_total,
        min(case when ${OPEN_INSTALLMENT} then ii.due_date end) oldest_due,
        count(*) filter (where ${OPEN_INSTALLMENT}) open_count
      from portal.invoices i join portal.invoice_installments ii on ii.invoice_id=i.id
      where i.voided_at is null group by i.client_id
    ), unap as (
      select p.client_id,
        sum(greatest(p.amount-coalesce(a.applied,0),0)) unapplied
      from portal.payments p
      left join (
        select payment_id,sum(amount_applied) applied from portal.payment_allocations
        where reversed_at is null group by payment_id
      ) a on a.payment_id=p.id
      where p.status='confirmed' and p.payment_method <> 'customer_credit'
      group by p.client_id
    )`;
  const select = `select u.id,u.display_name,u.company_name,u.email,u.client_code,u.tax_cuit,
      coalesce(inst.overdue,0) overdue,coalesce(inst.to_due,0) to_due,
      coalesce(inst.pending_total,0) pending_total,inst.oldest_due,coalesce(inst.open_count,0) open_count,
      coalesce(unap.unapplied,0) unapplied,
      ${flags.currentAccount ? "coalesce(led.total,0)" : "null"} ledger_total
    from portal.users u left join led on led.client_id=u.id left join inst on inst.client_id=u.id left join unap on unap.client_id=u.id
    where ${where.join(" and ")}`;
  const sql = `${ctes} ${select} order by ${orderSql} limit ${normalizedLimit} offset ${normalizedOffset}`;
  const countSql = `${ctes} select count(*) total from (${select}) x`;
  const totalsSql = `${ctes} select
      coalesce(sum(coalesce(inst.overdue,0)),0) overdue,
      coalesce(sum(coalesce(inst.to_due,0)),0) to_due,
      coalesce(sum(coalesce(inst.pending_total,0)),0) pending_total,
      coalesce(sum(coalesce(unap.unapplied,0)),0) unapplied,
      ${flags.currentAccount ? "coalesce(sum(greatest(coalesce(led.total,0),0)),0)" : "null"} debt,
      ${flags.currentAccount ? "coalesce(sum(greatest(-coalesce(led.total,0),0)),0)" : "null"} in_favor
    from portal.users u left join led on led.client_id=u.id left join inst on inst.client_id=u.id left join unap on unap.client_id=u.id
    where ${where.join(" and ")}`;
  return { sql, countSql, totalsSql, params, sort: normalizedSort, direction: normalizedDirection, limit: normalizedLimit, offset: normalizedOffset };
}

function num(value) { return value == null ? null : Number(value); }

export async function listReceivables(opts = {}) {
  const q = buildReceivablesQuery(opts);
  const [rows, count, totals] = await Promise.all([
    pool.query(q.sql, q.params), pool.query(q.countSql, q.params), pool.query(q.totalsSql, q.params)
  ]);
  const clients = rows.rows.map((row) => {
    const ledgerTotal = num(row.ledger_total);
    return {
      ...row,
      overdue: num(row.overdue) || 0,
      to_due: num(row.to_due) || 0,
      pending_total: num(row.pending_total) || 0,
      unapplied: num(row.unapplied) || 0,
      ledger_total: ledgerTotal,
      debt: ledgerTotal == null ? null : Math.max(0, ledgerTotal),
      in_favor: ledgerTotal == null ? null : Math.max(0, -ledgerTotal),
      open_count: Number(row.open_count || 0)
    };
  });
  const t = totals.rows[0] || {};
  return {
    clients,
    total: Number(count.rows[0]?.total || 0),
    totals: {
      overdue: num(t.overdue) || 0, toDue: num(t.to_due) || 0, pending: num(t.pending_total) || 0,
      unapplied: num(t.unapplied) || 0, debt: num(t.debt), inFavor: num(t.in_favor)
    },
    ledgerAvailable: flags.currentAccount,
    echeqAvailable: flags.echeq,
    pagination: { limit: q.limit, offset: q.offset },
    sort: q.sort, direction: q.direction
  };
}

export async function listOpenInstallments(clientId) {
  const r = await pool.query(
    `select ii.id,ii.invoice_id,ii.installment_number,ii.due_date,ii.amount,ii.paid_amount,ii.status,
            i.invoice_type,i.point_of_sale,i.invoice_number,i.order_id,q.request_number,
            (ii.amount-ii.paid_amount) debt
     from portal.invoice_installments ii
     join portal.invoices i on i.id=ii.invoice_id
     left join portal.quote_requests q on q.id=i.order_id
     where i.client_id=$1 and i.voided_at is null and ${OPEN_INSTALLMENT}
     order by ii.due_date asc,i.issue_date asc,ii.installment_number asc`,
    [clientId]
  );
  return r.rows.map((row) => ({ ...row, amount: Number(row.amount), paid_amount: Number(row.paid_amount), debt: Number(row.debt) }));
}
