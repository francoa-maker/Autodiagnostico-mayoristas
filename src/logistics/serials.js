// Números de serie por unidad (Tanda 8). Opcionales: nunca bloquean marcar
// preparado/listo/despachar. Regla: serial_count <= prepared_quantity <=
// confirmed_quantity (quote_items.quantity). Historial: no se borra; se marca.
import { pool, withTransaction } from "../db.js";

export const SERIAL_STATUSES = ["assigned", "delivered", "removed", "returned", "replaced"];
export function normalizeSerial(s) { return String(s ?? "").trim(); }

// Pura (testeable): ¿entran `adding` seriales nuevos dado el actual y lo preparado?
export function canAddSerials(currentAssigned, adding, prepared) {
  return currentAssigned + adding <= prepared;
}

export async function setPreparedQuantity(orderItemId, qty, actorId) {
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  const it = (await pool.query(`select quantity from portal.quote_items where id = $1`, [orderItemId])).rows[0];
  if (!it) throw Object.assign(new Error("item_no_encontrado"), { statusCode: 404 });
  if (q > Number(it.quantity)) throw Object.assign(new Error("preparada_supera_confirmada"), { statusCode: 400, detail: `Confirmada: ${it.quantity}` });
  const assigned = Number((await pool.query(`select count(*)::int n from portal.order_item_serial_numbers where order_item_id = $1 and status = 'assigned'`, [orderItemId])).rows[0].n);
  if (q < assigned) throw Object.assign(new Error("preparada_menor_que_seriales"), { statusCode: 400, detail: `Ya hay ${assigned} seriales; quitá alguno primero.` });
  await pool.query(`update portal.quote_items set prepared_quantity = $2 where id = $1`, [orderItemId, q]);
  return { prepared_quantity: q };
}

export async function registerSerials(orderItemId, serials, actorId) {
  const clean = [...new Set((Array.isArray(serials) ? serials : []).map(normalizeSerial).filter(Boolean))];
  if (!clean.length) throw Object.assign(new Error("sin_seriales"), { statusCode: 400 });
  return withTransaction(async (client) => {
    const it = (await client.query(`select id, quantity, prepared_quantity, quote_request_id, product_id from portal.quote_items where id = $1 for update`, [orderItemId])).rows[0];
    if (!it) throw Object.assign(new Error("item_no_encontrado"), { statusCode: 404 });
    const assigned = Number((await client.query(`select count(*)::int n from portal.order_item_serial_numbers where order_item_id = $1 and status = 'assigned'`, [orderItemId])).rows[0].n);
    if (!canAddSerials(assigned, clean.length, Number(it.prepared_quantity))) {
      throw Object.assign(new Error("excede_preparadas"), { statusCode: 400, detail: `Preparadas: ${it.prepared_quantity}, ya cargados: ${assigned}. Aumentá la cantidad preparada (máx confirmada ${it.quantity}).` });
    }
    // Pre-chequeo de duplicados ya 'assigned' (mensaje claro, sin envenenar la
    // transacción). El índice único parcial sigue siendo el guard final ante
    // una carrera; en ese caso el 23505 se traduce a un mensaje simple y se
    // deja abortar la transacción (no se consulta sobre el cliente envenenado).
    const dup = (await client.query(
      `select serial_number, order_id from portal.order_item_serial_numbers where serial_number = any($1) and status = 'assigned'`,
      [clean]
    )).rows[0];
    if (dup) {
      const other = dup.order_id !== it.quote_request_id;
      throw Object.assign(new Error("serial_ya_asignado"), { statusCode: 409, detail: `El serial "${dup.serial_number}" ya está asignado${other ? " a OTRO pedido activo" : " en este pedido"}.` });
    }
    const inserted = [];
    for (const sn of clean) {
      try {
        const r = await client.query(
          `insert into portal.order_item_serial_numbers (order_id, order_item_id, product_id, serial_number, status, registered_by, updated_by)
           values ($1,$2,$3,$4,'assigned',$5,$5) returning id, serial_number`,
          [it.quote_request_id, orderItemId, it.product_id, sn, actorId]
        );
        inserted.push(r.rows[0]);
      } catch (e) {
        if (e.code === "23505") throw Object.assign(new Error("serial_ya_asignado"), { statusCode: 409, detail: `El serial "${sn}" ya está asignado.` });
        throw e;
      }
    }
    return { inserted: inserted.length, serials: inserted };
  });
}

export async function removeSerial(serialId, { reason, actorId }) {
  const r = await pool.query(
    `update portal.order_item_serial_numbers
       set status = 'removed', removal_reason = $2, removed_at = now(), updated_by = $3, updated_at = now()
     where id = $1 and status = 'assigned' returning id`,
    [serialId, reason || null, actorId]
  );
  return r.rowCount > 0;
}

export async function listSerialsByOrder(orderId) {
  const r = await pool.query(
    `select s.id, s.order_item_id, s.serial_number, s.status, s.notes, s.registered_at, s.removal_reason,
            u.display_name as registered_by_name
     from portal.order_item_serial_numbers s left join portal.users u on u.id = s.registered_by
     where s.order_id = $1 order by s.registered_at`,
    [orderId]
  );
  return r.rows;
}
