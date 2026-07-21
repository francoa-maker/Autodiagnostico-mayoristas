import crypto from "node:crypto";
import { pool, withTransaction } from "./db.js";

const SESSION_COOKIE = "portal_session";
const OAUTH_STATE_COOKIE = "portal_oauth_state";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secureSuffix(appBaseUrl) {
  return appBaseUrl.startsWith("https://") ? "; Secure" : "";
}

export function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((item) => {
        const [key, ...rest] = item.trim().split("=");
        return [key, rest.join("=")];
      })
      .filter(([key]) => key)
  );
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest();
}

export function oauthStateCookieHeader(state, appBaseUrl) {
  return `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secureSuffix(appBaseUrl)}`;
}

export function clearOauthStateCookieHeader(appBaseUrl) {
  return `${OAUTH_STATE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureSuffix(appBaseUrl)}`;
}

export function readOauthState(req) {
  return parseCookies(req.headers.cookie).portal_oauth_state;
}

export async function createSession(userId, { userAgent, ipHash } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `insert into portal.sessions (user_id, token_hash, expires_at, user_agent, ip_hash)
     values ($1, $2, $3, $4, $5)`,
    [userId, tokenHash, expiresAt, userAgent || null, ipHash || null]
  );
  return { token, expiresAt };
}

export function sessionCookieHeader(token, appBaseUrl) {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureSuffix(appBaseUrl)}`;
}

export function clearSessionCookieHeader(appBaseUrl) {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureSuffix(appBaseUrl)}`;
}

// Populates req.user from the session cookie. Does not enforce anything -
// see requireApproved/requireAdmin in middleware.js for gating.
export async function attachSession(req, _res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || !pool) return next();

  try {
    const tokenHash = hashToken(token);
    // gmail_refresh_token is deliberately NOT selected here: req.user is
    // returned verbatim by /api/me, so only the boolean + address are exposed.
    const result = await pool.query(
      `select u.id, u.email, u.display_name, u.avatar_url, u.role, u.status, u.company_name, u.client_code,
              (u.gmail_refresh_token is not null) as gmail_connected, u.gmail_address
       from portal.sessions s
       join portal.users u on u.id = s.user_id
       where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
      [tokenHash]
    );
    if (result.rows[0]) {
      req.user = result.rows[0];
      pool
        .query(`update portal.sessions set last_seen_at = now() where token_hash = $1`, [tokenHash])
        .catch((error) => console.error("session touch failed", error.message));
    }
  } catch (error) {
    console.error("attachSession failed", error.message);
  }
  next();
}

export async function revokeSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || !pool) return;
  await pool.query(`update portal.sessions set revoked_at = now() where token_hash = $1`, [hashToken(token)]);
}

// Código corto de cliente para la marca de agua (ej. CL-7K2Q9). Alfabeto sin
// caracteres ambiguos (0/O, 1/I). No es secreto: sólo identifica al cliente en
// el documento filtrado.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateClientCode() {
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return `CL-${s}`;
}

const USER_RETURNING = "id, email, display_name, avatar_url, role, status, company_name, client_code";

// New users always land as 'pending' - never auto-approved, never auto-admin.
// Matches by google_sub (stable) and keeps email/display_name in sync. Se les
// asigna un client_code al crearse (se conserva en logins posteriores).
//
// Excepción: un cliente puede existir de antemano sin google_sub (creado a
// mano desde el panel admin, ver POST /api/admin/users) - si no hay match por
// google_sub pero sí una ficha con ese email todavía sin vincular, se la
// "reclama" en vez de insertar una fila nueva (que además violaría el
// unique(email)), preservando su código de cliente, estado, datos fiscales y
// cotizaciones ya cargadas.
export async function findOrCreateUser({ googleSub, email, displayName, avatarUrl }) {
  return withTransaction(async (client) => {
    const bySub = await client.query(
      `update portal.users set email = $2, display_name = $3, avatar_url = $4, last_login_at = now(), updated_at = now()
       where google_sub = $1
       returning ${USER_RETURNING}`,
      [googleSub, email, displayName, avatarUrl || null]
    );
    if (bySub.rows[0]) return bySub.rows[0];

    const claimed = await client.query(
      `update portal.users set google_sub = $1,
              display_name = coalesce(nullif(display_name, ''), $3),
              avatar_url = coalesce(avatar_url, $4),
              last_login_at = now(), updated_at = now()
       where email = $2 and google_sub is null
       returning ${USER_RETURNING}`,
      [googleSub, email, displayName, avatarUrl || null]
    );
    if (claimed.rows[0]) return claimed.rows[0];

    const inserted = await client.query(
      `insert into portal.users (google_sub, email, display_name, avatar_url, last_login_at, client_code)
       values ($1, $2, $3, $4, now(), $5)
       returning ${USER_RETURNING}`,
      [googleSub, email, displayName, avatarUrl || null, generateClientCode()]
    );
    return inserted.rows[0];
  });
}
