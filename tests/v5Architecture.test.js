import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const CLIENT_IDS = [
  "catalogPage", "productGrid", "brandCards", "searchInput", "filtersPanel", "cartBtn", "cartDrawer",
  "cartItems", "submitQuoteBtn", "profileForm", "requestsBody", "accountBody"
];
const ADMIN_IDS = [
  "adminNav", "section-dashboard", "section-catalog", "section-products", "section-clients", "section-quotes",
  "section-billing", "section-logistics", "section-settings", "catalogEditorGrid", "productsBody", "clientsBody",
  "quotesBody", "quoteDetailBody", "billingOrders", "billingDetailBody", "logiOrdersAdmin", "modalOverlay", "modalBox"
];

function declaredIds(...sources) {
  const found = new Set();
  const re = /\bid=["']([^"']+)["']/g;
  for (const source of sources) {
    for (const match of source.matchAll(re)) found.add(match[1]);
  }
  return found;
}

function referencedLiteralIds(source) {
  const found = new Set();
  const patterns = [
    /getElementById\(["']([^"']+)["']\)/g,
    /querySelector(?:All)?\(["']#([A-Za-z][\w:-]*)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

function duplicateIds(html) {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  return ids.filter((id, index) => ids.indexOf(id) !== index);
}

describe("UX v5 architecture", () => {
  const clientHtml = read("public/index.html");
  const adminHtml = read("public/admin.html");
  const catalogJs = read("public/assets/catalog.js");
  const clientEnhancementsJs = read("public/assets/client-v4-enhancements.js");
  const adminJs = read("public/assets/admin.js");
  const logisticsJs = read("public/assets/logistics.js");

  it("keeps the critical functional DOM anchors", () => {
    for (const id of CLIENT_IDS) expect(clientHtml).toContain(`id=\"${id}\"`);
    for (const id of ADMIN_IDS) expect(adminHtml).toContain(`id=\"${id}\"`);
  });

  it("does not restore the removed product comparison UI", () => {
    expect(clientHtml).not.toMatch(/compareOverlay|compareBar|compareBody|Comparar productos/);
    expect(catalogJs).not.toMatch(/data-compare|compareOverlay|state\.compare/);
  });

  it("declares every literal ID referenced by the legacy client modules", () => {
    const declared = declaredIds(clientHtml, catalogJs, clientEnhancementsJs);
    const referenced = new Set([
      ...referencedLiteralIds(catalogJs),
      ...referencedLiteralIds(clientEnhancementsJs)
    ]);
    const missing = [...referenced].filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it("declares every literal ID referenced by the legacy admin modules", () => {
    const declared = declaredIds(adminHtml, adminJs, logisticsJs);
    const referenced = new Set([
      ...referencedLiteralIds(adminJs),
      ...referencedLiteralIds(logisticsJs)
    ]);
    const missing = [...referenced].filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it("does not duplicate IDs in either entry document", () => {
    expect(duplicateIds(clientHtml)).toEqual([]);
    expect(duplicateIds(adminHtml)).toEqual([]);
  });

  it("loads the v5 shells after the legacy functional modules", () => {
    expect(clientHtml.indexOf("catalog.js")).toBeLessThan(clientHtml.indexOf("client-v5-shell.js"));
    expect(adminHtml.indexOf("admin.js")).toBeLessThan(adminHtml.indexOf("admin-v5-shell.js"));
  });

  it("keeps CSP-compatible external JavaScript", () => {
    expect(clientHtml).not.toMatch(/onclick\s*=/i);
    expect(adminHtml).not.toMatch(/onclick\s*=/i);
  });

  it("the v5 modules parse with Node", () => {
    for (const path of ["public/assets/client-v5-shell.js", "public/assets/admin-v5-shell.js"]) {
      execFileSync(process.execPath, ["--check", new URL(`../${path}`, import.meta.url).pathname]);
    }
  });

  it("client shell does not expose exact stock", () => {
    const clientShell = read("public/assets/client-v5-shell.js");
    expect(clientShell).not.toMatch(/exactStock|exactQty|stockUpdatedAt/);
  });
});
