import crypto from "node:crypto";
import { pool } from "./db.js";

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
    const result = await pool.query(
      `select u.id, u.email, u.display_name, u.avatar_url, u.role, u.status, u.company_name
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

// New users always land as 'pending' - never auto-approved, never auto-admin.
// Matches by google_sub (stable) and keeps email/display_name in sync.
export async function findOrCreateUser({ googleSub, email, displayName, avatarUrl }) {
  const result = await pool.query(
    `insert into portal.users (google_sub, email, display_name, avatar_url, last_login_at)
     values ($1, $2, $3, $4, now())
     on conflict (google_sub) do update
       set email = excluded.email,
           display_name = excluded.display_name,
           avatar_url = excluded.avatar_url,
           last_login_at = now(),
           updated_at = now()
     returning id, email, display_name, avatar_url, role, status, company_name`,
    [googleSub, email, displayName, avatarUrl || null]
  );
  return result.rows[0];
}
