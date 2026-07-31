import { test, expect } from "@playwright/test";

const CANONICAL_ROLES = [
  "superadmin",
  "sales_billing",
  "administration",
  "logistics",
  "client"
];

async function loginAs(playwright, baseURL, role) {
  const context = await playwright.request.newContext({ baseURL });
  const email = `e2e-${role}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const response = await context.post("/auth/dev-login", {
    data: { email, role, status: "approved" }
  });
  expect(response.status(), `dev-login para ${role}`).toBe(200);
  return context;
}

test.describe("caracterización por rol", () => {
  for (const role of CANONICAL_ROLES) {
    test(`${role}: dev-login conserva el rol y sirve la interfaz correcta`, async ({ playwright, baseURL }) => {
      const context = await loginAs(playwright, baseURL, role);

      const meResponse = await context.get("/api/me");
      expect(meResponse.status()).toBe(200);
      const { user } = await meResponse.json();
      expect(user.role).toBe(role);
      expect(user.status).toBe("approved");

      const homeResponse = await context.get("/");
      expect(homeResponse.status()).toBe(200);
      const html = await homeResponse.text();
      if (role === "client") {
        expect(html).toContain("Autodiagnóstico — Portal Distribuidores");
        expect(html).not.toContain("Autodiagnóstico - Panel administrador");
      } else {
        expect(html).toContain("Autodiagnóstico - Panel administrador");
      }

      await context.dispose();
    });
  }

  test("dev-login rechaza roles y estados desconocidos", async ({ playwright, baseURL }) => {
    const context = await playwright.request.newContext({ baseURL });

    const invalidRole = await context.post("/auth/dev-login", {
      data: { email: "invalid-role@example.com", role: "owner", status: "approved" }
    });
    expect(invalidRole.status()).toBe(400);
    expect((await invalidRole.json()).error).toBe("invalid_role");

    const invalidStatus = await context.post("/auth/dev-login", {
      data: { email: "invalid-status@example.com", role: "client", status: "active" }
    });
    expect(invalidStatus.status()).toBe(400);
    expect((await invalidStatus.json()).error).toBe("invalid_status");

    await context.dispose();
  });

  test("Gmail admite al personal del panel y lo niega a logística/cliente", async ({ playwright, baseURL }) => {
    for (const role of CANONICAL_ROLES) {
      const context = await loginAs(playwright, baseURL, role);
      const response = await context.get("/auth/google/gmail", { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      const location = response.headers().location;

      if (["superadmin", "sales_billing", "administration"].includes(role)) {
        expect(location).not.toBe("/login");
      } else {
        expect(location).toBe("/login");
      }
      await context.dispose();
    }
  });

  test("Drive queda reservado al superadmin", async ({ playwright, baseURL }) => {
    for (const role of CANONICAL_ROLES) {
      const context = await loginAs(playwright, baseURL, role);
      const response = await context.get("/auth/google/drive", { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      const location = response.headers().location;

      if (role === "superadmin") expect(location).not.toBe("/login");
      else expect(location).toBe("/login");
      await context.dispose();
    }
  });
});
