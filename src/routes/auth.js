import express from "express";
import crypto from "node:crypto";
import {
  oauthStateCookieHeader,
  clearOauthStateCookieHeader,
  readOauthState,
  createSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  findOrCreateUser,
  revokeSession,
  parseCookies
} from "../auth.js";
import { pool } from "../db.js";
import { ROLES, isAdminStaff, isSuperadmin } from "../permissions.js";

const router = express.Router();
const DEV_LOGIN_ROLES = new Set([...ROLES, "admin", "customer"]);
const DEV_LOGIN_STATUSES = new Set(["pending", "approved", "rejected", "blocked"]);

function appBaseUrl() {
  return process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// No `hd` (hosted-domain) restriction here on purpose - unlike an internal
// Workspace-only login, distributors are external Google accounts.
router.get("/auth/google", (req, res) => {
  if (!googleConfigured()) return res.redirect("/login?error=google_not_configured");
  const state = crypto.randomBytes(24).toString("base64url");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${appBaseUrl()}/auth/google/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("state", state);
  res.setHeader("set-cookie", oauthStateCookieHeader(state, appBaseUrl()));
  res.redirect(authUrl.toString());
});

router.get("/auth/google/callback", async (req, res) => {
  if (!googleConfigured()) return res.redirect("/login?error=google_not_configured");
  const { code, state } = req.query;
  if (!state || state !== readOauthState(req)) return res.redirect("/login?error=invalid_state");
  if (!code) return res.redirect("/login?error=missing_code");

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${appBaseUrl()}/auth/google/callback`,
        grant_type: "authorization_code"
      })
    });
    if (!tokenResponse.ok) return res.redirect("/login?error=token_failed");
    const token = await tokenResponse.json();

    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    if (!profileResponse.ok) return res.redirect("/login?error=profile_failed");
    const profile = await profileResponse.json();

    const email = String(profile.email || "").toLowerCase();
    if (!email || !profile.sub) return res.redirect("/login?error=profile_failed");

    // findOrCreateUser always lands new accounts as pending/customer -
    // there is no domain check here that would auto-approve anyone.
    const user = await findOrCreateUser({
      googleSub: profile.sub,
      email,
      displayName: profile.name || email,
      avatarUrl: profile.picture || ""
    });
    const { token: sessionToken } = await createSession(user.id, { userAgent: req.headers["user-agent"] });

    res.setHeader("set-cookie", [sessionCookieHeader(sessionToken, appBaseUrl()), clearOauthStateCookieHeader(appBaseUrl())]);
    res.redirect("/");
  } catch (error) {
    console.error(error);
    res.redirect("/login?error=token_failed");
  }
});

// --- Autorización incremental de Gmail (solo admin/vendedor) --------------
// Separada del login para no tocar su camino: pide el scope gmail.send con
// access_type=offline para obtener un refresh_token que permita enviar la
// proforma "desde la casilla del vendedor". El refresh_token se guarda en
// portal.users y nunca se expone por la API.
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_STATE_COOKIE = "portal_gmail_state";

function gmailSecure() {
  return appBaseUrl().startsWith("https://") ? "; Secure" : "";
}

router.get("/auth/google/gmail", (req, res) => {
  if (!req.user || !isAdminStaff(req.user.role)) return res.redirect("/login");
  if (!googleConfigured()) return res.redirect("/?gmail=not_configured");
  const state = crypto.randomBytes(24).toString("base64url");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${appBaseUrl()}/auth/google/gmail/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GMAIL_SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("login_hint", req.user.email);
  authUrl.searchParams.set("state", state);
  res.setHeader("set-cookie", `${GMAIL_STATE_COOKIE}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${gmailSecure()}`);
  res.redirect(authUrl.toString());
});

router.get("/auth/google/gmail/callback", async (req, res) => {
  if (!req.user || !isAdminStaff(req.user.role)) return res.redirect("/login");
  const { code, state } = req.query;
  const cookieState = parseCookies(req.headers.cookie)[GMAIL_STATE_COOKIE];
  if (!state || state !== cookieState) return res.redirect("/?gmail=invalid_state");
  if (!code) return res.redirect("/?gmail=missing_code");
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${appBaseUrl()}/auth/google/gmail/callback`,
        grant_type: "authorization_code"
      })
    });
    if (!tokenResponse.ok) return res.redirect("/?gmail=token_failed");
    const token = await tokenResponse.json();
    if (!token.refresh_token) {
      // Google only returns a refresh_token with prompt=consent; if the user
      // had already granted it and Google skipped it, ask them to reconnect.
      return res.redirect("/?gmail=no_refresh_token");
    }
    let gmailAddress = req.user.email;
    try {
      const prof = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: `Bearer ${token.access_token}` } });
      if (prof.ok) gmailAddress = (await prof.json()).email || gmailAddress;
    } catch { /* keep session email */ }

    await pool.query(
      `update portal.users set gmail_refresh_token = $2, gmail_address = $3, gmail_connected_at = now(), updated_at = now() where id = $1`,
      [req.user.id, token.refresh_token, gmailAddress]
    );
    res.setHeader("set-cookie", `${GMAIL_STATE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${gmailSecure()}`);
    res.redirect("/?gmail=connected");
  } catch (error) {
    console.error(error);
    res.redirect("/?gmail=token_failed");
  }
});

// --- Autorización de Google Drive (solo admin) ----------------------------
// Pide el scope drive.file (la app SOLO ve/crea sus propios archivos) con
// access_type=offline para obtener un refresh_token. El token NO se guarda en
// la base: se muestra una única vez para que se pegue en la variable de entorno
// GOOGLE_DRIVE_REFRESH_TOKEN de Render (las credenciales van solo en el entorno).
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_STATE_COOKIE = "portal_drive_state";

router.get("/auth/google/drive", (req, res) => {
  if (!req.user || !isSuperadmin(req.user.role)) return res.redirect("/login");
  if (!googleConfigured()) return res.redirect("/?drive=not_configured");
  const state = crypto.randomBytes(24).toString("base64url");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${appBaseUrl()}/auth/google/drive/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", DRIVE_SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("login_hint", req.user.email);
  authUrl.searchParams.set("state", state);
  const secure = appBaseUrl().startsWith("https://") ? "; Secure" : "";
  res.setHeader("set-cookie", `${DRIVE_STATE_COOKIE}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secure}`);
  res.redirect(authUrl.toString());
});

router.get("/auth/google/drive/callback", async (req, res) => {
  if (!req.user || !isSuperadmin(req.user.role)) return res.redirect("/login");
  const { code, state } = req.query;
  const cookieState = parseCookies(req.headers.cookie)[DRIVE_STATE_COOKIE];
  const secure = appBaseUrl().startsWith("https://") ? "; Secure" : "";
  const clear = `${DRIVE_STATE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
  if (!state || state !== cookieState) return res.redirect("/?drive=invalid_state");
  if (!code) return res.redirect("/?drive=missing_code");
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${appBaseUrl()}/auth/google/drive/callback`,
        grant_type: "authorization_code"
      })
    });
    if (!tokenResponse.ok) return res.redirect("/?drive=token_failed");
    const token = await tokenResponse.json();
    if (!token.refresh_token) return res.redirect("/?drive=no_refresh_token");

    // Se muestra una sola vez para copiarlo a la env var. No se persiste.
    const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
    res.setHeader("set-cookie", clear);
    res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html><meta charset="utf-8">
      <body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px;color:#1a1a1a">
      <h2>Google Drive conectado ✓</h2>
      <p>Copiá este <b>refresh token</b> y pegalo en Render como la variable de entorno
      <code>GOOGLE_DRIVE_REFRESH_TOKEN</code>. También seteá <code>STORAGE_PROVIDER=google</code>
      (y opcionalmente <code>GOOGLE_DRIVE_ROOT_FOLDER_NAME=AUTODIAGNOSTICO ERP</code>). Después, redeploy.</p>
      <textarea readonly style="width:100%;height:90px;font-family:monospace;font-size:13px;padding:10px;border:1px solid #ccc;border-radius:8px">${esc(token.refresh_token)}</textarea>
      <p style="color:#c8102e;font-size:13px">⚠ Este valor es secreto y se muestra una sola vez. No lo compartas. Cerrá esta pestaña cuando lo hayas guardado.</p>
      <p><a href="/">Volver al panel</a></p></body>`);
  } catch (error) {
    console.error(error);
    res.setHeader("set-cookie", clear);
    res.redirect("/?drive=token_failed");
  }
});

router.get("/auth/logout", async (req, res) => {
  await revokeSession(req);
  res.setHeader("set-cookie", clearSessionCookieHeader(appBaseUrl()));
  res.redirect("/login");
});

// No gating - a pending user must be able to see their own status.
router.get("/api/me", (req, res) => {
  res.json({ user: req.user, googleConfigured: googleConfigured() });
});

// Local-only shortcut so the full login -> pending -> approve -> catalog ->
// quote flow can be built and tested (including Playwright) before a real
// Google OAuth client exists. Never mounted in production.
if (process.env.NODE_ENV !== "production") {
  router.post("/auth/dev-login", async (req, res) => {
    if (!pool) return res.status(503).json({ error: "db_unavailable" });
    const email = String(req.body?.email || "dev@example.com").toLowerCase();
    const role = String(req.body?.role ?? "client");
    const status = String(req.body?.status ?? "approved");

    if (!DEV_LOGIN_ROLES.has(role)) {
      return res.status(400).json({
        error: "invalid_role",
        allowedRoles: [...DEV_LOGIN_ROLES]
      });
    }
    if (!DEV_LOGIN_STATUSES.has(status)) {
      return res.status(400).json({
        error: "invalid_status",
        allowedStatuses: [...DEV_LOGIN_STATUSES]
      });
    }

    const user = await findOrCreateUser({ googleSub: `dev:${email}`, email, displayName: req.body?.name || email });
    await pool.query(`update portal.users set role = $2, status = $3 where id = $1`, [user.id, role, status]);

    const { token } = await createSession(user.id, { userAgent: "dev-login" });
    res.setHeader("set-cookie", sessionCookieHeader(token, appBaseUrl()));
    res.json({ ok: true, userId: user.id, role, status });
  });
}

export default router;
