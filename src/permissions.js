// Capa de permisos por *capabilities*. El resto del sistema pregunta
// can(user, "algo.puntual") en vez de chequear el rol directamente. Los roles
// legacy (admin/customer) se normalizan a los nuevos, así nada se rompe aunque
// los datos todavía no estén migrados.

export const ROLES = ["superadmin", "sales_billing", "administration", "logistics", "client"];

export const ROLE_LABEL = {
  superadmin: "Superadmin",
  sales_billing: "Ventas/Facturación",
  administration: "Administración",
  logistics: "Logística",
  client: "Cliente"
};

// Legacy -> canónico.
export function normalizeRole(role) {
  if (role === "admin") return "superadmin";
  if (role === "customer") return "client";
  return role || "client";
}

// Capabilities por rol. superadmin = "*" (todo). Estas capabilities todavía no
// se consumen por rutas financieras (no existen aún); se definen acá para que
// las tandas siguientes las usen. En Tanda 0 lo que manda es isAdminStaff (abajo).
const ROLE_CAPABILITIES = {
  superadmin: ["*"],
  sales_billing: [
    "quotes.manage", "orders.manage", "orders.view", "orders.authorize", "orders.release_logistics",
    "invoices.manage", "invoices.view", "payments.register", "payments.confirm", "payments.apply",
    "payments.reverse", "payments.view", "account.manage", "account.view", "echeq.manage", "echeq.view",
    "documents.upload", "documents.view", "financial.reports.view", "clients.view", "clients.manage",
    "catalog.manage", "sales.serial_numbers.view"
  ],
  administration: [
    "orders.view", "invoices.manage", "invoices.view", "payments.register", "payments.confirm",
    "payments.apply", "payments.reverse", "payments.view", "account.manage", "account.view",
    "echeq.manage", "echeq.view", "documents.upload", "documents.view", "financial.reports.view",
    "clients.view"
    // orders.authorize se concede por usuario vía extra_permissions
  ],
  logistics: [
    "logistics.prepare", "logistics.serial_numbers.view", "logistics.serial_numbers.create",
    "logistics.serial_numbers.update", "logistics.serial_numbers.remove", "documents.view.logistics"
  ],
  client: [
    "self.view", "payments.inform", "documents.upload.own", "documents.download.visible"
  ]
};

// ¿El usuario tiene esta capability? Considera el rol + grants por usuario
// (users.extra_permissions, ej. {"orders.authorize": true} o {"grant": [...]}).
export function can(user, capability) {
  if (!user) return false;
  const role = normalizeRole(user.role);
  const caps = ROLE_CAPABILITIES[role] || [];
  if (caps.includes("*")) return true;
  if (caps.includes(capability)) return true;
  const extra = user.extra_permissions;
  if (extra && typeof extra === "object") {
    if (extra[capability] === true) return true;
    if (Array.isArray(extra.grant) && extra.grant.includes(capability)) return true;
  }
  return false;
}

// Todo lo que no es cliente (personal interno).
export function isStaff(role) {
  return normalizeRole(role) !== "client";
}
// Personal con acceso al PANEL admin. Logística tendrá su propia vista más
// adelante (Tanda 8); por ahora no entra al panel general.
export function isAdminStaff(role) {
  const r = normalizeRole(role);
  return r === "superadmin" || r === "sales_billing" || r === "administration";
}
export function isSuperadmin(role) {
  return normalizeRole(role) === "superadmin";
}
export function isClient(role) {
  return normalizeRole(role) === "client";
}
