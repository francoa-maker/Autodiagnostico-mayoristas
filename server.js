import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { attachSession } from "./src/auth.js";
import authRouter from "./src/routes/auth.js";
import catalogRouter from "./src/routes/catalog.js";
import quotesRouter from "./src/routes/quotes.js";
import adminRouter from "./src/routes/admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json());
app.use(attachSession);

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// authRouter mounts /auth/* and /api/me at root (no /api prefix, matching
// the ninots convention of keeping auth outside the requireUser-gated tree).
app.use(authRouter);
app.use("/api", catalogRouter);
app.use("/api", quotesRouter);
app.use("/api", adminRouter);

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
  res.sendFile(path.join(publicDir, req.user.role === "admin" ? "admin.html" : "index.html"));
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
