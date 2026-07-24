import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { attachSession } from "./src/auth.js";
import { isAdminStaff } from "./src/permissions.js";
import authRouter from "./src/routes/auth.js";
import catalogRouter from "./src/routes/catalog.js";
import quotesRouter from "./src/routes/quotes.js";
import adminRouter from "./src/routes/admin.js";
import profileRouter from "./src/routes/profile.js";
import documentsRouter from "./src/routes/documents.js";
import financeRouter from "./src/routes/finance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

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
app.use(express.json());
app.use(attachSession);

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// authRouter mounts /auth/* and /api/me at root (no /api prefix, matching
// the ninots convention of keeping auth outside the requireUser-gated tree).
app.use(wrapRouterErrors(authRouter));
app.use("/api", wrapRouterErrors(profileRouter));
app.use("/api", wrapRouterErrors(catalogRouter));
app.use("/api", wrapRouterErrors(quotesRouter));
app.use("/api", wrapRouterErrors(documentsRouter));
app.use("/api", wrapRouterErrors(financeRouter));
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
  res.sendFile(path.join(publicDir, isAdminStaff(req.user.role) ? "admin.html" : "index.html"));
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
  res.status(statusCode).json({ error: error.message || "server_error" });
});

app.listen(port, () => {
  console.log(`Portal Autodiagnóstico corriendo en ${process.env.APP_BASE_URL || `http://localhost:${port}`}`);
});
