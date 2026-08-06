import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(new URL("../public/assets/sidebar-overflow-fix.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

describe("sidebar sin desborde horizontal", () => {
  it("oculta únicamente el desborde horizontal del panel y la página", () => {
    expect(source).toContain("overflow-x: hidden !important");
    expect(source).toContain("body.v5-admin .admin-sidebar");
    expect(source).toContain("body.v5-admin");
  });

  it("mantiene el ancho del drawer dentro del viewport", () => {
    expect(source).toContain("calc(100vw - 8px)");
    expect(source).toContain("max-width: 100vw");
  });

  it("evita que el correo empuje el enlace de salida", () => {
    expect(source).toContain("grid-template-columns: 32px minmax(0, 1fr) auto");
    expect(source).toContain("text-overflow: ellipsis");
    expect(source).toContain("white-space: nowrap");
  });

  it("carga el fix con versión anticaché", () => {
    expect(server).toContain('/assets/sidebar-overflow-fix.js?v=20260806-sidebar1');
  });
});
