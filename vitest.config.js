import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit tests below are pure functions and don't need DATABASE_URL.
    // Integration tests that do (applySnapshot, stockRepository against a
    // real table) are added once a local/staging Postgres is available -
    // see migrations/README.md.
    testTimeout: 15000,
    hookTimeout: 30000,
    reporters: ["verbose"],
    // tests/e2e/*.spec.js are Playwright specs, run via `npm run test:e2e`,
    // not vitest's own *.spec.js glob.
    exclude: ["**/node_modules/**", "tests/e2e/**"]
  }
});
