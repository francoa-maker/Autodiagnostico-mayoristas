// Botones de las hojas imprimibles (proforma, estado de cuenta). Fuera de línea
// para respetar la CSP (script-src 'self', sin onclick inline).
document.querySelectorAll("[data-action='print']").forEach((b) => b.addEventListener("click", () => window.print()));
document.querySelectorAll("[data-action='close']").forEach((b) => b.addEventListener("click", () => window.close()));
