import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { attachSession } from "./src/auth.js";
import { isAdminStaff, normalizeRole } from "./src/permissions.js";
import { securityHeaders, createRateLimiter } from "./src/securityHeaders.js";
import authRouter from "./src/routes/auth.js";
import catalogRouter from "./src/routes/catalog.js";
import quotesRouter from "./src/routes/quotes.js";
import adminRouter from "./src/routes/admin.js";
import salesManagementRouter from "./src/routes/salesManagement.js";
import profileRouter from "./src/routes/profile.js";
import documentsRouter from "./src/routes/documents.js";
import financeRouter from "./src/routes/finance.js";
import logisticsRouter from "./src/routes/logistics.js";
import { startEmailWorker } from "./src/email/worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const adminHtml = fs
  .readFileSync(path.join(publicDir, "admin.html"), "utf8")
  .replace(
    "</body>",
    '<script type="module" src="/assets/sales-management.js?v=20260804-sales1"></script>\n</body>'
  );

// Express 4 does not forward rejected promises from async route handlers to
// the error middleware, so a single failing query (e.g. a misconfigured
// STOCK_TABLE) would become an unhandledRejection and could take down the
// whole process. Wrapping every route handler in Promise.resolve().catch(next)
// routes those failures to the error handler as a clean 500 instead. Done once
// at mount time so individual routes don't each need a try/catch.
function wrapRouterErrors(router) {
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const routeLayer of layer.route.stack) {
      const original = routeLayer.handle;
      if (typeof original !== "function" || original.length >= 4) continue; // skip error handlers
      routeLayer.handle = function wrapped(req, res, next) {
        Promise.resolve(original(req, res, next)).catch(next);
      };
    }
  }
  return router;
}

// Last-resort backstops: log instead of letting an unexpected rejection or
// exception crash the service. The wrapper above should catch route errors
// first; these only fire for anything outside the request/response cycle.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("uncaughtException:", error);
});

const app = express();
// Detrás del proxy de Render (un solo hop): que req.ip refleje el X-Forwarded-For
// real del cliente (necesario para el rate limiting por IP).
app.set("trust proxy", 1);
app.use(securityHeaders);
app.use(express.json());
app.use(attachSession);

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Rate limiting por IP (ventana fija, en memoria). Límites holgados: cortan
// abuso/fuerza bruta sin molestar el uso normal (incluye varias personas
// detrás de la misma IP de oficina). /auth es más estricto (login).
app.use("/api", createRateLimiter({ windowMs: 60 * 1000, max: 600, keyPrefix: "api" }));
app.use("/auth", createRateLimiter({ windowMs: 15 * 60 * 1000, max: 80, keyPrefix: "auth" }));

// authRouter mounts /auth/* and /api/me at root (no /api prefix, matching
// the ninots convention of keeping auth outside the requireUser-gated tree).
app.use(wrapRouterErrors(authRouter));
app.use("/api", wrapRouterErrors(profileRouter));
app.use("/api", wrapRouterErrors(catalogRouter));
app.use("/api", wrapRouterErrors(quotesRouter));
app.use("/api", wrapRouterErrors(documentsRouter));
app.use("/api", wrapRouterErrors(financeRouter));
app.use("/api", wrapRouterErrors(logisticsRouter));
app.use("/api", wrapRouterErrors(salesManagementRouter));
// adminRouter va ÚLTIMO: usa router.use(requireAdmin) global, así que si se
// montara antes interceptaría (con 403 admin_required) cualquier ruta /api/*
// de cliente no resuelta por un router previo (documentos, facturas, etc.).
app.use("/api", wrapRouterErrors(adminRouter));

app.use("/assets", express.static(path.join(publicDir, "assets")));

app.get("/login", (req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

app.get("/pending", (req, res) => {
  if (!req.user) return res.redirect("/login");
  res.sendFile(path.join(publicDir, "pending.html"));
});

app.get("/", (req, res) => {
  if (!req.user) return res.redirect("/login");
  if (req.user.status !== "approved") return res.redirect("/pending");
  // Personal interno (incluida logística) usa el panel unificado; el panel
  // muestra sólo las pestañas del rol. El cliente ve el catálogo.
  const role = normalizeRole(req.user.role);
  const staff = isAdminStaff(req.user.role) || role === "logistics";
  if (staff) {
    res.setHeader("Cache-Control", "no-store");
    return res.type("html").send(adminHtml);
  }
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "not_found" });
  }
  if (!req.user) return res.redirect("/login");
  res.status(404).sendFile(path.join(publicDir, "index.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  console.error(error);
  const statusCode = error.statusCode || error.status || 500;
  // Los 4xx llevan mensajes intencionales y seguros (ej. "invalid_id"); los 5xx
  // no deben filtrar detalles internos (stack, nombres de tablas, etc.).
  const body = statusCode >= 500 ? { error: "server_error" } : { error: error.message || "request_failed" };
  res.status(statusCode).json(body);
});

app.listen(port, () => {
  console.log(`Portal Autodiagnóstico corriendo en ${process.env.APP_BASE_URL || `http://localhost:${port}`}`);
  startEmailWorker().catch((error) => console.error("email_worker_start_failed", error.message));
});
