import fs from "node:fs";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(new URL("../public/assets/client-v5.css", import.meta.url), "utf8");

describe("panel de solicitud del cliente", () => {
  it("se abre como drawer lateral también en escritorio ancho", () => {
    expect(css).toContain("V5 desktop cart drawer fix");
    expect(css).toMatch(/@media \(min-width:1201px\)/);
    expect(css).toMatch(/body\.v5-client \.cart-drawer\{[^}]*position:fixed/);
    expect(css).toMatch(/body\.v5-client \.cart-drawer\.open\{[^}]*translateX\(0\)/);
    expect(css).toMatch(/body\.v5-client \.cart-overlay\.open\{[^}]*pointer-events:auto/);
  });
});
