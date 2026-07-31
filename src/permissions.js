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

// Capabilities por rol. superadmin = "*" (todo).
const ROLE_CAPABILITIES = {
  superadmin: ["*"],
  sales_billing: [
    "quotes.manage", "orders.manage", "orders.view", "orders.authorize", "orders.release_logistics",
    "invoices.manage", "invoices.view", "payments.register", "payments.confirm", "payments.apply",
    "payments.reverse", "payments.view", "account.manage", "account.view", "echeq.manage", "echeq.view",
    "documents.upload", "documents.view", "financial.reports.view", "clients.view", "clients.manage",
    "catalog.manage", "sales.serial_numbers.view",
    // Ventas también opera Depósito/Logística (preparar + números de serie).
    "logistics.prepare", "logistics.serial_numbers.view", "logistics.serial_numbers.create",
    "logistics.serial_numbers.update", "logistics.serial_numbers.remove"
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

// Lista efectiva para la UI y otros consumidores. Considera rol, legacy y
// grants por usuario. Superadmin conserva el wildcard para no tener que
// enumerar capacidades futuras.
export function capabilitiesFor(user) {
  if (!user) return [];
  const role = normalizeRole(user.role);
  const base = ROLE_CAPABILITIES[role] || [];
  if (base.includes("*")) return ["*"];

  const granted = [];
  const extra = user.extra_permissions;
  if (extra && typeof extra === "object") {
    for (const [capability, enabled] of Object.entries(extra)) {
      if (capability !== "grant" && enabled === true) granted.push(capability);
    }
    if (Array.isArray(extra.grant)) granted.push(...extra.grant.filter((item) => typeof item === "string"));
  }
  return [...new Set([...base, ...granted])].sort();
}

// ¿El usuario tiene esta capability? Considera el rol + grants por usuario.
export function can(user, capability) {
  const caps = capabilitiesFor(user);
  return caps.includes("*") || caps.includes(capability);
}

// Todo lo que no es cliente (personal interno).
export function isStaff(role) {
  return normalizeRole(role) !== "client";
}
// Personal con acceso al PANEL admin. Logística usa el mismo panel unificado,
// pero sus rutas continúan protegidas por capabilities.
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
