import { postJson } from "/assets/api.js";

function summaryLines(summary, preview = false) {
  const lines = [
    `Productos publicados encontrados: ${summary.webProducts}`,
    `Nuevos para ${preview ? "crear" : "creados"}: ${summary.created}`,
    `Reactivados: ${summary.reactivated}`,
    `Que ${preview ? "se ocultarán" : "se ocultaron"} por no estar en la web: ${summary.deactivated}`,
    `Sin cambios: ${summary.unchanged}`
  ];
  if (summary.skippedNoSku) lines.push(`Omitidos por no tener SKU: ${summary.skippedNoSku}`);
  if (summary.duplicateWebSkus?.length) lines.push(`SKU duplicados en la web (omitidos): ${summary.duplicateWebSkus.join(", ")}`);
  return lines.join("\n");
}

function setButtonsBusy(busy, label = "Sincronizar con web") {
  document.querySelectorAll("[data-woo-sync]").forEach((button) => {
    button.disabled = busy;
    button.textContent = busy ? label : "↻ Sincronizar con web";
  });
}

async function runSync() {
  setButtonsBusy(true, "Analizando web...");
  try {
    const previewResponse = await postJson("/api/admin/catalog/sync-woocommerce", { apply: false });
    const summary = previewResponse.summary;
    const destructiveNote = summary.deactivated
      ? `\n\nATENCIÓN: ${summary.deactivated} producto(s) del portal se ocultarán porque su SKU no aparece entre los productos publicados de la web.`
      : "";
    const confirmed = window.confirm(
      `Sincronización con autodiagnostico.com.ar\n\n${summaryLines(summary, true)}${destructiveNote}\n\nLos precios mayoristas existentes no se modificarán. ¿Aplicar estos cambios?`
    );
    if (!confirmed) return;

    setButtonsBusy(true, "Sincronizando...");
    const result = await postJson("/api/admin/catalog/sync-woocommerce", { apply: true });
    window.alert(`Sincronización completada.\n\n${summaryLines(result.summary, false)}`);
    window.location.reload();
  } catch (error) {
    const detail = error?.body?.detail || error?.message || "Error inesperado";
    window.alert(`No se pudo sincronizar el catálogo.\n\n${detail}`);
  } finally {
    setButtonsBusy(false);
  }
}

function addButtonBefore(target) {
  if (!target || target.parentElement?.querySelector("[data-woo-sync]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-btn";
  button.dataset.wooSync = "true";
  button.textContent = "↻ Sincronizar con web";
  button.title = "Crea productos publicados que falten y oculta los que ya no estén publicados en autodiagnostico.com.ar";
  button.addEventListener("click", runSync);
  target.before(button);
}

function mount() {
  addButtonBefore(document.getElementById("catNewBtn"));
  addButtonBefore(document.getElementById("newProductBtn"));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
