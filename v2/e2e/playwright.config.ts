import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const video = resolve(import.meta.dirname, "fixtures/widget.y4m");
const port = 4200;
const database = process.env.E2E_DATABASE_URL ?? "postgresql://profitindex:profitindex@localhost:5432/profitindex_e2e";

/**
 * The whole app, built for production, against a fresh database — exactly a
 * new company's first day. Chromium's camera is a looping video of the
 * sample widget's barcode, so the scanner is exercised for real.
 */
export default defineConfig({
  testDir: "tests",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    permissions: ["camera"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium",
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`],
    },
  },
  webServer: {
    command: "npm run build -w @pi/web && npm run build -w @pi/api && npm run fresh -w @pi/api && node apps/api/dist/server.js",
    cwd: resolve(import.meta.dirname, ".."),
    url: `http://localhost:${port}/api/health`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: { DATABASE_URL: database, PORT: String(port), ANTHROPIC_API_KEY: "" },
  },
});
