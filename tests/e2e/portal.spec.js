import { test, expect } from "@playwright/test";

// See tests/e2e/README.md - requires a local Postgres with migrations
// applied, and NODE_ENV !== 'production' for /auth/dev-login to exist.

test("login -> pending -> approve -> catalog -> quote", async ({ page, playwright, baseURL }) => {
  const email = `e2e-${Date.now()}@example.com`;

  // 1. Dev-login lands as approved=false first to exercise the pending gate,
  // then we flip it via the admin API using a second, pre-approved admin session.
  await page.request.post(`${baseURL}/auth/dev-login`, { data: { email, role: "client", status: "pending" } });
  await page.goto("/");
  await expect(page).toHaveURL(/\/pending$/);
  await expect(page.locator("#pendingEmail")).toHaveText(email);

  const adminEmail = `e2e-admin-${Date.now()}@example.com`;
  const adminContext = await playwright.request.newContext({ baseURL });
  await adminContext.post("/auth/dev-login", { data: { email: adminEmail, role: "superadmin", status: "approved" } });

  // Look up the pending user's id via the admin API and approve it.
  const usersResponse = await adminContext.get("/api/admin/users?status=pending");
  const { users } = await usersResponse.json();
  const target = users.find((u) => u.email === email);
  expect(target).toBeTruthy();
  await adminContext.patch(`/api/admin/users/${target.id}`, { data: { status: "approved" } });

  // 2. Back on the customer session: catalog should now load.
  await page.reload();
  await expect(page).toHaveURL(baseURL + "/");
  await expect(page.locator(".hub-hdr h1")).toHaveText("Catálogo Distribuidor");

  // 3. Add the first product in the first brand to the cart and submit a quote.
  await page.locator(".brand-card").first().click();
  await page.locator(".add-btn").first().click();
  await page.locator("#cartBtn").click();
  await page.locator("#submitQuoteBtn").click();
  await expect(page.locator(".cart-success")).toBeVisible();
  await adminContext.dispose();
});
