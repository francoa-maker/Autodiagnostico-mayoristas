import { defineConfig } from "@playwright/test";

// Not yet run in this environment (no local Postgres, browsers not
// installed here) - see tests/e2e/README.md before trusting a green run.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  use: {
    baseURL: process.env.APP_BASE_URL || "http://localhost:3000",
    trace: "on-first-retry"
  },
  webServer: {
    command: "node server.js",
    url: "http://localhost:3000/health",
    reuseExistingServer: true,
    env: { NODE_ENV: "test" }
  }
});
