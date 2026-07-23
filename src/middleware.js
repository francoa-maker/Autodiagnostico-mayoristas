import { can, isAdminStaff, isStaff } from "./permissions.js";

export function requireApproved(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "login_required" });
  // Approval and role are separate axes - an admin whose status was set to
  // 'blocked'/'rejected' must not keep reaching customer-facing routes.
  if (req.user.status !== "approved") {
    return res.status(403).json({ error: "account_not_approved", status: req.user.status });
  }
  next();
}

// Acceso al panel admin general: personal admin (superadmin/sales_billing/
// administration; normaliza el legacy 'admin'->superadmin). Logística tendrá su
// propia vista en una etapa posterior; cliente nunca.
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "login_required" });
  if (!isAdminStaff(req.user.role) || req.user.status !== "approved") {
    return res.status(403).json({ error: "admin_required" });
  }
  next();
}

// Cualquier rol de personal interno (incluye logística), aprobado.
export function requireStaff(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "login_required" });
  if (!isStaff(req.user.role) || req.user.status !== "approved") {
    return res.status(403).json({ error: "staff_required" });
  }
  next();
}

// Gate por capability puntual (para las rutas financieras/logísticas nuevas).
export function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "login_required" });
    if (req.user.status !== "approved") return res.status(403).json({ error: "account_not_approved", status: req.user.status });
    if (!can(req.user, capability)) return res.status(403).json({ error: "forbidden", capability });
    next();
  };
}
