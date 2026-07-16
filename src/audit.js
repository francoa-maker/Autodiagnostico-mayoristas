import { pool } from "./db.js";

export async function recordAudit({ actorUserId, action, entityType, entityId, before, after, requestId, metadata }) {
  if (!pool) return;
  await pool.query(
    `insert into portal.audit_log (actor_user_id, action, entity_type, entity_id, request_id, before_data, after_data, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actorUserId || null,
      action,
      entityType,
      entityId ? String(entityId) : null,
      requestId || null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      JSON.stringify(metadata || {})
    ]
  );
}
