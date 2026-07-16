export function requireApproved(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "login_required" });
  // Approval and admin-ness are separate axes - an admin whose status was
  // set to 'blocked'/'rejected' must not keep reaching customer-facing
  // catalog/quote routes just because role === 'admin'. requireAdmin below
  // already checks both role and status for admin-only routes.
  if (req.user.status !== "approved") {
    return res.status(403).json({ error: "account_not_approved", status: req.user.status });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "login_required" });
  if (req.user.role !== "admin" || req.user.status !== "approved") {
    return res.status(403).json({ error: "admin_required" });
  }
  next();
}
