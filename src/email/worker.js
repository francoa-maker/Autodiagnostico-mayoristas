import { pool } from "../db.js";
import { sendGmail } from "../mailer.js";
import { downloadDocument } from "../documents.js";

let timer = null;
let running = false;

async function config() {
  const row = (await pool.query(`select value from portal.app_settings where key='email_queue'`)).rows[0];
  return { pollIntervalMs: 15000, maxAttempts: 5, reminderDays: 3, ...(row?.value || {}) };
}

async function claimBatch(limit = 10) {
  const r = await pool.query(
    `with picked as (
       select id from portal.email_queue
       where status='pending' and scheduled_at <= now()
         and (claimed_at is null or claimed_at < now() - interval '10 minutes')
       order by scheduled_at, created_at
       for update skip locked limit $1
     )
     update portal.email_queue q set claimed_at=now(), attempts=q.attempts+1
     from picked where q.id=picked.id returning q.*`,
    [limit]
  );
  return r.rows;
}

async function senderFor(item) {
  const r = await pool.query(
    `select u.gmail_refresh_token, u.gmail_address, u.email, u.display_name
     from portal.users u
     where u.gmail_refresh_token is not null
       and (u.id=(select quoted_by_user_id from portal.quote_requests where id=$1)
         or u.id=(select assigned_admin_id from portal.quote_requests where id=$1)
         or u.role in ('superadmin','admin','sales'))
     order by
       case when u.id=(select quoted_by_user_id from portal.quote_requests where id=$1) then 0
            when u.id=(select assigned_admin_id from portal.quote_requests where id=$1) then 1 else 2 end,
       u.gmail_connected_at desc nulls last
     limit 1`,
    [item.quote_request_id]
  );
  return r.rows[0] || null;
}

async function loadAttachments(refs) {
  const out = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const id = typeof ref === "string" ? ref : ref?.documentId;
    if (!id) continue;
    const doc = (await pool.query(`select * from portal.documents where id=$1 and deleted_at is null`, [id])).rows[0];
    if (!doc) continue;
    const file = await downloadDocument(doc);
    out.push({ filename: file.filename, mimeType: file.mimeType, content: file.buffer });
  }
  return out;
}

async function sendItem(item, maxAttempts) {
  try {
    const sender = await senderFor(item);
    if (!sender) throw new Error("gmail_sender_no_configurado");
    const attachments = await loadAttachments(item.attachments);
    await sendGmail({
      refreshToken: sender.gmail_refresh_token,
      from: sender.gmail_address || sender.email,
      fromName: sender.display_name || "Autodiagnóstico",
      to: item.to_addrs.join(", "),
      cc: item.cc_addrs?.length ? item.cc_addrs.join(", ") : undefined,
      subject: item.subject,
      html: item.body,
      replyTo: sender.email,
      attachments
    });
    await pool.query(`update portal.email_queue set status='sent', sent_at=now(), claimed_at=null, error=null where id=$1`, [item.id]);
  } catch (error) {
    const exhausted = Number(item.attempts) >= Number(maxAttempts);
    const delayMinutes = Math.min(60, 2 ** Math.max(0, Number(item.attempts) - 1));
    await pool.query(
      `update portal.email_queue set status=$2, claimed_at=null, error=$3,
       scheduled_at=case when $2='pending' then now()+($4::text || ' minutes')::interval else scheduled_at end
       where id=$1`,
      [item.id, exhausted ? "failed" : "pending", String(error.message || error).slice(0, 1000), delayMinutes]
    );
  }
}

export async function runEmailWorkerOnce() {
  if (!pool || running) return { processed: 0 };
  running = true;
  try {
    const cfg = await config();
    const batch = await claimBatch(10);
    for (const item of batch) await sendItem(item, cfg.maxAttempts);
    return { processed: batch.length };
  } finally {
    running = false;
  }
}

export async function certificateWarning() {
  if (!pool) return null;
  const r = await pool.query(`select value from portal.app_settings where key='certificate_expiry'`);
  const v = r.rows[0]?.value || {};
  if (!v.expiresAt) return null;
  const days = Math.ceil((new Date(v.expiresAt).getTime() - Date.now()) / 86400000);
  return { expiresAt: v.expiresAt, daysRemaining: days, warning: days <= Number(v.warningDays || 30) };
}

export async function startEmailWorker() {
  if (!pool || timer) return;
  const cfg = await config().catch(() => ({ pollIntervalMs: 15000 }));
  runEmailWorkerOnce().catch((e) => console.error("email_worker_failed", e.message));
  timer = setInterval(() => runEmailWorkerOnce().catch((e) => console.error("email_worker_failed", e.message)), Math.max(5000, Number(cfg.pollIntervalMs) || 15000));
  timer.unref?.();
}
