// Feature flags del módulo financiero/logístico. Por defecto APAGADOS: cada uno
// se prende (env=true) recién tras migrar, validar cálculos, probar aislamiento
// y reversión, y hacer backup de producción. Las tandas siguientes gatean sus
// rutas/UI con estos flags.
function on(name) {
  return String(process.env[name] || "").toLowerCase() === "true";
}

export const flags = {
  get financial() { return on("ENABLE_FINANCIAL_MODULE"); },
  get currentAccount() { return on("ENABLE_CURRENT_ACCOUNT_MODULE"); },
  get echeq() { return on("ENABLE_ECHEQ_MODULE"); },
  get serialNumbers() { return on("ENABLE_SERIAL_NUMBERS_MODULE"); }
};

// Middleware helper: 404 si el flag está apagado (no revela la ruta).
export function requireFlag(flagName) {
  return (req, res, next) => {
    if (flags[flagName]) return next();
    return res.status(404).json({ error: "not_found" });
  };
}
