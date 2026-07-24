// Cabeceras de seguridad y rate limiting, sin dependencias externas (en línea
// con el estilo del proyecto: fetch crudo, sin librerías). Defensa en
// profundidad: la app ya escapa la salida (esc) y parametriza queries; esto
// suma una capa más.

// CSP pensada para NO romper la app:
// - script-src 'self': todos los scripts son del propio origen (se sacaron los
//   inline de login.html/pending.html y los onclick de las hojas imprimibles).
// - style-src 'unsafe-inline': hay muchos style="" y bloques <style> (proforma,
//   estado de cuenta); sacarlos sería un refactor grande sin ganancia real.
// - img-src https:/data:: logos de marca, fotos de producto y avatars vienen de
//   hosts https externos (autodiagnostico.com.ar, CDN, googleusercontent).
// - connect-src 'self': el front sólo hace fetch al mismo origen.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'"
].join("; ");

const IS_HTTPS = String(process.env.APP_BASE_URL || "").startsWith("https://");

export function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  // HSTS sólo tiene sentido sobre https (el browser lo ignora sobre http).
  if (IS_HTTPS) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

// Rate limiter de ventana fija en memoria. Suficiente para 1 instancia (Render
// starter). Si algún día hay múltiples instancias, migrar a un store compartido
// (Redis). El sweep perezoso evita que el Map crezca sin límite.
export function createRateLimiter({ windowMs, max, keyPrefix = "rl" }) {
  const hits = new Map();
  function sweep(now) {
    for (const [k, e] of hits) if (now >= e.reset) hits.delete(k);
  }
  return function rateLimiter(req, res, next) {
    const now = Date.now();
    if (hits.size > 10000) sweep(now);
    const key = `${keyPrefix}:${req.ip || req.socket?.remoteAddress || "unknown"}`;
    let entry = hits.get(key);
    if (!entry || now >= entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.reset - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "rate_limited", retryAfterSeconds: retryAfter });
    }
    next();
  };
}
