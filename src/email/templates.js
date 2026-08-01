function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function templateVariables(value) {
  return [...String(value || "").matchAll(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g)].map((m) => m[1]);
}

export function renderString(template, variables = {}) {
  const missing = [...new Set(templateVariables(template).filter((key) => variables[key] === undefined || variables[key] === null))];
  if (missing.length) {
    throw Object.assign(new Error("template_variables_faltantes"), { statusCode: 400, missing });
  }
  return String(template || "").replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_all, key) => escapeHtml(variables[key]));
}

export function renderTemplate(template, variables = {}) {
  if (!template?.subject || !template?.body_html) {
    throw Object.assign(new Error("template_invalida"), { statusCode: 400 });
  }
  return {
    subject: renderString(template.subject, variables).replace(/[\r\n]+/g, " "),
    body: renderString(template.body_html, variables),
    text: template.body_text ? renderString(template.body_text, variables) : null
  };
}

export { escapeHtml };
