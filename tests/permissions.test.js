import { describe, it, expect } from "vitest";
import { can, normalizeRole, isAdminStaff, isSuperadmin, isStaff, isClient } from "../src/permissions.js";

describe("permissions - normalizeRole (legacy)", () => {
  it("mapea legacy a canónico", () => {
    expect(normalizeRole("admin")).toBe("superadmin");
    expect(normalizeRole("customer")).toBe("client");
    expect(normalizeRole("sales_billing")).toBe("sales_billing");
    expect(normalizeRole(null)).toBe("client");
  });
});

describe("permissions - matriz de capabilities", () => {
  const su = { role: "superadmin" };
  const sales = { role: "sales_billing" };
  const admin = { role: "administration" };
  const logi = { role: "logistics" };
  const cli = { role: "client" };

  it("superadmin puede todo", () => {
    expect(can(su, "payments.confirm")).toBe(true);
    expect(can(su, "logistics.serial_numbers.remove")).toBe(true);
    expect(can(su, "cualquier.cosa.nueva")).toBe(true);
  });
  it("sales_billing maneja finanzas y autoriza", () => {
    expect(can(sales, "payments.confirm")).toBe(true);
    expect(can(sales, "orders.authorize")).toBe(true);
    expect(can(sales, "invoices.manage")).toBe(true);
  });
  it("administration confirma pagos pero NO autoriza salvo grant por usuario", () => {
    expect(can(admin, "payments.confirm")).toBe(true);
    expect(can(admin, "orders.authorize")).toBe(false);
    const granted = { role: "administration", extra_permissions: { "orders.authorize": true } };
    expect(can(granted, "orders.authorize")).toBe(true);
    const grantedArr = { role: "administration", extra_permissions: { grant: ["orders.authorize"] } };
    expect(can(grantedArr, "orders.authorize")).toBe(true);
  });
  it("logística NO ve nada financiero", () => {
    expect(can(logi, "payments.view")).toBe(false);
    expect(can(logi, "invoices.view")).toBe(false);
    expect(can(logi, "account.view")).toBe(false);
    expect(can(logi, "echeq.view")).toBe(false);
    expect(can(logi, "logistics.serial_numbers.create")).toBe(true);
  });
  it("cliente solo lo propio, nunca confirma/aplica", () => {
    expect(can(cli, "payments.confirm")).toBe(false);
    expect(can(cli, "payments.apply")).toBe(false);
    expect(can(cli, "account.manage")).toBe(false);
    expect(can(cli, "self.view")).toBe(true);
    expect(can(cli, "payments.inform")).toBe(true);
  });
  it("roles legacy se comportan como su canónico", () => {
    expect(can({ role: "admin" }, "payments.confirm")).toBe(true);
    expect(can({ role: "customer" }, "payments.confirm")).toBe(false);
  });
  it("sin usuario => false", () => {
    expect(can(null, "self.view")).toBe(false);
  });
});

describe("permissions - helpers de rol", () => {
  it("isAdminStaff / isSuperadmin / isStaff / isClient", () => {
    expect(isAdminStaff("administration")).toBe(true);
    expect(isAdminStaff("logistics")).toBe(false);
    expect(isAdminStaff("admin")).toBe(true); // legacy
    expect(isAdminStaff("client")).toBe(false);
    expect(isSuperadmin("admin")).toBe(true);
    expect(isSuperadmin("administration")).toBe(false);
    expect(isStaff("logistics")).toBe(true);
    expect(isStaff("client")).toBe(false);
    expect(isClient("customer")).toBe(true);
  });
});
