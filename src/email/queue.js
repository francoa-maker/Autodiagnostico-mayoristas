import { pool } from "../db.js";
import { renderTemplate } from "./templates.js";

function addresses(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
}

export async function enqueueEmail({
  templateKey, variables = {}, to, cc = [], attachments = [],
  quoteRequestId = null, userId = null, scheduledAt = null, idempotencyKey = null
}) {
  if (!pool) throw new Error("db_unavailable");
  const template = (await pool.query(
    `select key, subject, body_html, body_text, variables from portal.email_templates where key = $1`,
    [templateKey]
  )).rows[0];
  if (!template) throw Object.assign(new Error("email_template_no_encontrada"), { statusCode: 404 });
  const toAddrs = addresses(to);
  const ccAddrs = addresses(cc).filter((email) => !toAddrs.includes(email));
  if (!toAddrs.length) throw Object.assign(new Error("email_destinatario_requerido"), { statusCode: 400 });
  const rendered = renderTemplate(template, variables);
  const result = await pool.query(
    `insert into portal.email_queue
       (template_key, to_addrs, cc_addrs, subject, body, attachments, quote_request_id, user_id, scheduled_at, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,now()),$10)
     on conflict (idempotency_key) where idempotency_key is not null
     do update set idempotency_key = excluded.idempotency_key
     returning *`,
    [templateKey, toAddrs, ccAddrs, rendered.subject, rendered.body, JSON.stringify(attachments || []),
     quoteRequestId, userId, scheduledAt, idempotencyKey]
  );
  return result.rows[0];
}

export async function listEmailTemplates() {
  return (await pool.query(`select * from portal.email_templates order by key`)).rows;
}

export async function saveEmailTemplate({ key, subject, bodyHtml, bodyText = null, variables = [], updatedBy }) {
  const result = await pool.query(
    `insert into portal.email_templates (key, subject, body_html, body_text, variables, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,now())
     on conflict (key) do update set subject=excluded.subject, body_html=excluded.body_html,
       body_text=excluded.body_text, variables=excluded.variables, updated_by=excluded.updated_by, updated_at=now()
     returning *`,
    [key, subject, bodyHtml, bodyText, JSON.stringify(variables), updatedBy]
  );
  return result.rows[0];
}
