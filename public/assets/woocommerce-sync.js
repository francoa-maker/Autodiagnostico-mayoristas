import { postJson } from "/assets/api.js";

function commonLines(summary) {
  const lines = [];
  if (summary.skippedNoSku) lines.push(`Omitidos por no tener SKU: ${summary.skippedNoSku}`);
  if (summary.duplicateWebSkus?.length) lines.push(`SKU duplicados en la web (omitidos): ${summary.duplicateWebSkus.join(", ")}`);
  return lines;
}

function summaryLines(summary, preview = false) {
  const lines = [
    `Productos publicados encontrados: ${summary.webProducts}`,
    `Nuevos para ${preview ? "crear" : "creados"}: ${summary.created}`,
    `Reactivados: ${summary.reactivated}`,
    `Que ${preview ? "se ocultarán" : "se ocultaron"} por no estar en la web: ${summary.deactivated}`,
    `Sin cambios: ${summary.unchanged}`
  ];
  return lines.concat(commonLines(summary)).join("\n");
}

function addNewLines(summary, preview = false) {
  const lines = [
    `Productos publicados en la web: ${summary.webProducts}`,
    `Productos nuevos ${preview ? "para agregar" : "agregados"}: ${summary.created}`,
    `Ya estaban en el catálogo: ${summary.unchanged}`
  ];
  if (summary.inactiveInPortal) {
    lines.push(`Publicados en la web pero desactivados en el portal: ${summary.inactiveInPortal} (no se tocan)`);
  }
  if (summary.missingFromWeb) {
    lines.push(`Productos del portal que no están publicados en la web: ${summary.missingFromWeb} (no se tocan)`);
  }
  return lines.concat(commonLines(summary)).join("\n");
}

// Los dos botones se deshabilitan juntos: comparten endpoint y catálogo, y
// dejar uno activo permitiría disparar ambas operaciones en paralelo.
function setButtonsBusy(busy, label = "") {
  document.querySelectorAll("[data-woo-sync], [data-woo-add-new]").forEach((button) => {
    button.disabled = busy;
    button.textContent = busy ? label : button.dataset.idleLabel;
  });
}

async function runAddNew() {
  setButtonsBusy(true, "Buscando productos...");
  try {
    const previewResponse = await postJson("/api/admin/catalog/sync-woocommerce", { apply: false, mode: "add-new" });
    const summary = previewResponse.summary;
    if (!summary.created) {
      window.alert(`No hay productos nuevos para agregar.\n\n${addNewLines(summary, true)}`);
      return;
    }
    const sample = summary.newSkus.slice(0, 20).join(", ");
    const confirmed = window.confirm(
      `Agregar productos nuevos de autodiagnostico.com.ar\n\n${addNewLines(summary, true)}\n\nSKU nuevos: ${sample}${summary.created > 20 ? ", ..." : ""}\n\nNo se oculta ni se modifica ningún producto existente.\n\n¿Agregar ${summary.created} producto(s)?`
    );
    if (!confirmed) return;

    setButtonsBusy(true, "Agregando...");
    const result = await postJson("/api/admin/catalog/sync-woocommerce", { apply: true, mode: "add-new" });
    window.alert(`Listo.\n\n${addNewLines(result.summary, false)}\n\nRevisá los precios mayoristas de los productos nuevos.`);
    window.location.reload();
  } catch (error) {
    const detail = error?.body?.detail || error?.message || "Error inesperado";
    window.alert(`No se pudieron agregar los productos nuevos.\n\n${detail}`);
  } finally {
    setButtonsBusy(false);
  }
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

function makeButton({ flag, label, title, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-btn";
  button.dataset[flag] = "true";
  button.dataset.idleLabel = label;
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

function addButtonsBefore(target) {
  if (!target || target.parentElement?.querySelector("[data-woo-add-new]")) return;
  target.before(
    makeButton({
      flag: "wooAddNew",
      label: "+ Agregar productos nuevos",
      title: "Busca en autodiagnostico.com.ar los productos publicados que todavía no están en el catálogo mayorista y los agrega. No oculta ni modifica nada existente.",
      onClick: runAddNew
    })
  );
  target.before(
    makeButton({
      flag: "wooSync",
      label: "↻ Sincronizar con web",
      title: "Crea productos publicados que falten y oculta los que ya no estén publicados en autodiagnostico.com.ar",
      onClick: runSync
    })
  );
}

function mount() {
  addButtonsBefore(document.getElementById("catNewBtn"));
  addButtonsBefore(document.getElementById("newProductBtn"));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
