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
  revokeSession
} from "../auth.js";
import { pool } from "../db.js";

const router = express.Router();

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
    const role = req.body?.role === "admin" ? "admin" : "customer";
    const status = req.body?.status || "approved";

    const user = await findOrCreateUser({ googleSub: `dev:${email}`, email, displayName: req.body?.name || email });
    await pool.query(`update portal.users set role = $2, status = $3 where id = $1`, [user.id, role, status]);

    const { token } = await createSession(user.id, { userAgent: "dev-login" });
    res.setHeader("set-cookie", sessionCookieHeader(token, appBaseUrl()));
    res.json({ ok: true, userId: user.id, role, status });
  });
}

export default router;
