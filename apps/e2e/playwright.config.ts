import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * Local-only browser smoke test (never wired into CI). Uses the installed Google Chrome when
 * there is one, else Playwright's own chromium (`pnpm --filter @tide/e2e exec playwright install chromium`).
 */
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const useChrome = process.env["TIDE_E2E_CHROMIUM"] !== "1" && existsSync(SYSTEM_CHROME);

export default defineConfig({
  testDir: "specs",
  testMatch: "**/*.e2e.ts",
  // devices and quota build on the project and threads the smoke walk leaves behind
  projects: [
    { name: "smoke", testMatch: "smoke.e2e.ts" },
    { name: "devices", testMatch: "devices.e2e.ts", dependencies: ["smoke"] },
    // after devices: a project quota would hold the turns devices sends
    { name: "quota", testMatch: "quota.e2e.ts", dependencies: ["devices"] },
    // after quota: its cap is removed by then, so the long turns are not held
    { name: "stream", testMatch: "stream.e2e.ts", dependencies: ["quota"] },
  ],
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    ...(useChrome ? { channel: "chrome" } : {}),
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
