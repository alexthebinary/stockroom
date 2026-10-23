// Isolated UI verification with mocked API responses; no database or live service.
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests", testMatch: "help.spec.ts", workers: 1, reporter: "list",
  use: { baseURL: "http://127.0.0.1:4211", launchOptions: { executablePath: process.env.PW_CHROMIUM } },
  webServer: { command: "npm run preview -w @pi/web -- --host 127.0.0.1 --port 4211", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:4211", reuseExistingServer: false },
});
