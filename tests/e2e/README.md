# E2E (Playwright)

Not yet run in this environment - no local Postgres and no Playwright
browsers installed here. Before trusting a green run:

```bash
npm install --save-dev @playwright/test
npx playwright install --with-deps chromium
DATABASE_URL=postgres://...local-test-db... npm run db:migrate
npm run test:e2e
```

`portal.spec.js` drives the full login -> pending -> approve -> catalog ->
quote flow using `POST /auth/dev-login` (see `src/routes/auth.js`), which is
disabled whenever `NODE_ENV === "production"`. It does not exercise the real
Google OAuth consent screen - that needs one manual smoke test after the
real OAuth client (see the plan's "manual actions" list) exists, since
automating Google's real login screen in CI is brittle and not worth
building.
