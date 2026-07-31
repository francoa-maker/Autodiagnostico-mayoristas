import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const CLIENT_IDS = [
  "catalogPage", "productGrid", "brandCards", "searchInput", "filtersPanel", "cartBtn", "cartDrawer",
  "cartItems", "submitQuoteBtn", "profileForm", "requestsBody", "accountBody", "compareBody"
];
const ADMIN_IDS = [
  "adminNav", "section-dashboard", "section-catalog", "section-products", "section-clients", "section-quotes",
  "section-billing", "section-logistics", "section-settings", "catalogEditorGrid", "productsBody", "clientsBody",
  "quotesBody", "quoteDetailBody", "billingOrders", "billingDetailBody", "logiOrdersAdmin", "modalOverlay", "modalBox"
];

describe("UX v5 architecture", () => {
  it("keeps the functional DOM anchors", () => {
    const client = read("public/index.html");
    const admin = read("public/admin.html");
    for (const id of CLIENT_IDS) expect(client).toContain(`id=\"${id}\"`);
    for (const id of ADMIN_IDS) expect(admin).toContain(`id=\"${id}\"`);
  });

  it("loads the v5 shells after the legacy functional modules", () => {
    const client = read("public/index.html");
    const admin = read("public/admin.html");
    expect(client.indexOf("catalog.js")).toBeLessThan(client.indexOf("client-v5-shell.js"));
    expect(admin.indexOf("admin.js")).toBeLessThan(admin.indexOf("admin-v5-shell.js"));
  });

  it("keeps CSP-compatible external JavaScript", () => {
    const client = read("public/index.html");
    const admin = read("public/admin.html");
    expect(client).not.toMatch(/onclick\s*=/i);
    expect(admin).not.toMatch(/onclick\s*=/i);
  });

  it("the v5 modules parse with Node", () => {
    for (const path of ["public/assets/client-v5-shell.js", "public/assets/admin-v5-shell.js"]) {
      execFileSync(process.execPath, ["--check", new URL(`../${path}`, import.meta.url).pathname]);
    }
  });

  it("client shell does not expose exact stock", () => {
    const client = read("public/assets/client-v5-shell.js");
    expect(client).not.toMatch(/exactStock|exactQty|stockUpdatedAt/);
  });
});
