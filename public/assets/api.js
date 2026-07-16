export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  if (response.status === 401) {
    window.location.href = "/login";
    return new Promise(() => {}); // never resolves - navigation is already underway
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || "request_failed"), { status: response.status, body });
  return body;
}

export function postJson(url, data) {
  return fetchJson(url, { method: "POST", body: JSON.stringify(data) });
}

export function patchJson(url, data) {
  return fetchJson(url, { method: "PATCH", body: JSON.stringify(data) });
}

export function putJson(url, data) {
  return fetchJson(url, { method: "PUT", body: JSON.stringify(data) });
}

export function money(amount, currency) {
  if (amount === null || amount === undefined) return "-";
  const prefix = currency === "USD" ? "US$ " : "$ ";
  return prefix + Number(amount).toLocaleString("es-AR");
}

export const STOCK_LABEL = { in_stock: "Hay stock", low_stock: "Últimos en stock", out_of_stock: "Sin stock" };
