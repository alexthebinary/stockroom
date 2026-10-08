import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

/** Anything the Content-Security-Policy blocks shows up as a console error; collect them all. */
const blocked: string[] = [];
const watch = (page: Page) =>
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) blocked.push(message.text());
  });

const shot = (page: Page, name: string) => page.screenshot({ path: resolve(import.meta.dirname, "../screenshots", `${name}.png`) });

/**
 * A brand-new company's first day, through the real UI:
 * setup wizard with sample data → the clerk scans a delivery on a phone with
 * the camera → accounting posts the draft bill with $100 freight → the
 * widgets land at $550 each (GAAP guide §I.4) → the bill is paid → the books
 * check passes.
 */
test("fresh install to a paid bill, with the books proved sound", async ({ browser }) => {
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await desk.newPage();
  watch(page);

  // ── First-run setup ──
  // The stage beside each question repeats names on purpose, so assertions look in <main>.
  const main = page.getByRole("main");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your stock and your books, in sync." })).toBeVisible();
  await shot(page, "01-setup-welcome");
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabel("Company name").fill("Newtown Robotics");
  await page.getByLabel("State").fill("PA");
  await page.getByRole("button", { name: "Continue" }).click();

  // The person doing setup is the first on the team, and becomes "you" on this device.
  await page.getByLabel("Your name").fill("Ada Admin");
  await expect(page.getByRole("radio", { name: "Admin" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Cal Clerk");
  await page.getByRole("button", { name: "Add Cal Clerk" }).click();
  await expect(main.getByText("Cal Clerk")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Ann Accountant");
  await page.getByRole("radio", { name: "Accounting" }).click();
  await page.getByRole("button", { name: "Add Ann Accountant" }).click();
  await expect(main.getByText("Ann Accountant")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Sample data is the recommended start, and with it the data screens are skipped.
  await expect(page.getByRole("radio", { name: "Try it with sample data" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "You're all set, Ada." })).toBeVisible();
  await shot(page, "02-setup-ready");
  await page.getByRole("button", { name: "Open ProfitIndex" }).click();
  await expect(page.getByText("The books are sound")).toBeVisible();
  await shot(page, "03-admin-home");

  // ── The clerk, on a phone at the dock ──
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const clerk = await phone.newPage();
  watch(clerk);
  await clerk.goto("/");
  await clerk.getByRole("button", { name: "Cal Clerk, Warehouse" }).click();
  await shot(clerk, "04-clerk-home");
  await clerk.getByRole("link", { name: "Receive a delivery" }).click();
  await clerk.getByText("Main warehouse").click();
  await clerk.getByRole("combobox", { name: "Or pick the supplier" }).click();
  await clerk.getByRole("option", { name: "Sample Supplier Co." }).click();
  await clerk.getByRole("button", { name: "Start scanning" }).click();
  await clerk.getByRole("button", { name: "Open scanner" }).click();
  // The camera is a video of the widget's UPC-A: wait for the decoder to read it.
  await expect(clerk.getByText("1 counted")).toBeVisible({ timeout: 30_000 });
  await shot(clerk, "05-clerk-scanning");
  await clerk.getByRole("button", { name: "Done scanning" }).click();
  // A second identical box: the +1 button, as a clerk would for a stack of the same thing.
  const line = clerk.getByText("Sample Widget", { exact: true });
  await expect(line).toBeVisible();
  const counts = clerk.locator(".mantine-Card-root").filter({ hasText: "SAMPLE-WIDGET" });
  const scanned = Number(await counts.getByText(/^\d+$/).first().textContent());
  if (scanned < 2) await clerk.getByRole("button", { name: "One more Sample Widget" }).click();
  if (scanned > 2) for (let i = scanned; i > 2; i--) await clerk.getByRole("button", { name: "One fewer Sample Widget" }).click();
  await expect(counts.getByText("2", { exact: true })).toBeVisible();
  await clerk.getByRole("button", { name: "Check & finish" }).click();
  await clerk.getByRole("button", { name: "Finish delivery" }).click();
  await expect(clerk.getByText("2 units are counted and waiting for accounting")).toBeVisible();
  await expect(clerk.getByRole("status").filter({ hasText: "Delivery received" })).toBeVisible();
  await expect(clerk.getByText("WH-IN-00001")).toBeVisible();
  await shot(clerk, "06-clerk-done");

  // ── Accounting, at a desk ──
  await page.getByRole("button", { name: "Who's working and settings" }).click();
  await page.getByRole("menuitem", { name: "Switch person" }).click();
  await page.getByRole("button", { name: "Ann Accountant, Accounting" }).click();
  await expect(page.getByText("Bills to review")).toBeVisible();
  await shot(page, "07-accounting-home");
  await page.getByRole("link", { name: /Review the next bill/ }).click();
  await page.getByLabel("Vendor's invoice number").fill("PS-1001");
  await page.getByLabel("Shipping charged by the vendor $").fill("100.00");
  await expect(page.getByText("$1,000.00 + $100.00 freight = $1,100.00")).toBeVisible();
  await expect(page.getByText("$550.00", { exact: true })).toBeVisible();
  await shot(page, "08-bill-review");
  // Money moves on a deliberate press-and-hold, not a tap.
  const postButton = page.getByRole("button", { name: "Hold to post bill" });
  await postButton.click({ trial: true });
  await postButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Record payment" }), "a short press must not post").toHaveCount(0);
  await postButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Record payment" })).toBeVisible();

  const valuation = await (await page.request.get("/api/reports/valuation")).json();
  expect(valuation.rows.find((r: { sku: string }) => r.sku === "SAMPLE-WIDGET")).toMatchObject({ onHand: 2, held: 0, valueCents: 110000, averageCents: 55000, varianceCents: 0 });

  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByLabel("Amount $")).toHaveValue("1100.00");
  await page.getByRole("dialog").getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
  await shot(page, "09-bill-paid");

  const books = await (await page.request.get("/api/books/check")).json();
  expect(books.problems).toEqual([]);
  const tb = await (await page.request.get("/api/reports/trial-balance")).json();
  const row = (code: string) => tb.rows.find((r: { code: string }) => r.code === code);
  expect(row("1200").debitCents, "Inventory Asset").toBe(110000);
  expect(row("1000").creditCents, "Bank paid out").toBe(110000);
  expect(row("2000").creditCents + row("2000").debitCents, "nothing owed").toBe(0);

  await page.goto("/reports");
  await expect(page.getByText("Debits equal credits")).toBeVisible();
  await shot(page, "10-books-check");

  // The same screens in dark mode, for the design inspection round.
  await phone.close();
  const night = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const dark = await night.newPage();
  watch(dark);
  await dark.goto("/");
  await dark.getByRole("button", { name: "Cal Clerk, Warehouse" }).click();
  await shot(dark, "11-clerk-home-dark");
  await dark.goto("/bills");
  await shot(dark, "12-bills-dark");

  // Test sheet: the barcode writer's WebAssembly must also run under the policy.
  await dark.goto("/test-sheet");
  await expect(dark.locator("svg").first()).toBeVisible();
  expect(blocked, "nothing blocked by the Content-Security-Policy").toEqual([]);
});
