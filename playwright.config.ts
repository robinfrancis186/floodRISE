import { defineConfig, devices } from "@playwright/test";

const apiUrl = "http://127.0.0.1:8787";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["**/._*"],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 6_000 },
  outputDir: "artifacts/playwright",
  reporter: process.env.CI ? [["html", { outputFolder: "artifacts/playwright-report", open: "never" }], ["list"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "FLOODRISE_DATABASE_URL=sqlite:///./services/backend/floodrise-e2e.db uv run --project services/backend uvicorn app.main:app --app-dir services/backend --host 127.0.0.1 --port 8787",
      url: `${apiUrl}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @floodrise/ops-web exec vite --host 127.0.0.1 --port 55173 --strictPort",
      url: "http://127.0.0.1:55173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "VITE_DEMO_MODE=true pnpm --filter @floodrise/field-web exec vite --host 127.0.0.1 --port 55174 --strictPort",
      url: "http://127.0.0.1:55174",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
