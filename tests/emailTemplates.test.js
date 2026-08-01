import { describe, expect, it } from "vitest";
import { renderString, renderTemplate } from "../src/email/templates.js";

describe("plantillas de correo", () => {
  it("reemplaza variables y escapa HTML", () => {
    expect(renderString("Hola {{nombre}}", { nombre: "<Franco>" })).toBe("Hola &lt;Franco&gt;");
  });
  it("rechaza variables faltantes", () => {
    expect(() => renderString("Total {{total}}", {})).toThrow("template_variables_faltantes");
  });
  it("impide saltos de línea en el asunto", () => {
    const result = renderTemplate({ subject: "Pedido {{codigo}}", body_html: "<p>{{codigo}}</p>" }, { codigo: "CL-1\nBcc: x@y.com" });
    expect(result.subject).not.toContain("\n");
  });
});
