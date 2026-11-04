import { expect, test } from "@playwright/test";

/**
 * Feedback #27: a serial-tracked item with no scannable barcode can be picked
 * by hand on the Receive screen, its serial typed, and the delivery finished.
 */
test("receive a serial-tracked item by hand, typing its serial", async ({ browser }) => {
  const errors: string[] = [];
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await desk.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabel("Company name").fill("Serial Test Co");
  await page.getByLabel("State").fill("PA");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your name").fill("Ada Admin");
  await expect(page.getByRole("radio", { name: "Admin" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("radio", { name: "Try it with sample data" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "You're all set, Ada." })).toBeVisible();
  await page.getByRole("button", { name: "Open ProfitIndex" }).click();
  await expect(page.getByText("The books are sound")).toBeVisible();

  await page.goto("/receive");
  // With one warehouse the app skips straight to "Who is it from?".
  await expect(page.getByRole("combobox", { name: "Or pick the supplier" }).or(page.getByText("Main warehouse"))).toBeVisible();
  if (await page.getByText("Main warehouse").isVisible()) await page.getByText("Main warehouse").click();
  await page.getByRole("combobox", { name: "Or pick the supplier" }).click();
  await page.getByRole("option", { name: "Sample Supplier Co." }).click();
  await page.getByRole("button", { name: "Start scanning" }).click();

  const pick = page.getByRole("combobox", { name: "No barcode? Pick the item" });
  await pick.click();
  await pick.fill("Sample Robot");
  await page.getByRole("option", { name: /Sample Robot \(serial-tracked\)/ }).click();
  const serial = page.getByLabel(/Serial number for this/);
  await serial.fill("SN-9001");
  await page.getByRole("button", { name: "Add unit" }).click();
  await serial.fill("SN-9001");
  await expect(page.getByText("This serial is already on this delivery")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add unit" })).toBeDisabled();
  await serial.fill("SN-9002");
  await serial.press("Enter");

  const robot = page.locator(".mantine-Card-root").filter({ hasText: "SAMPLE-ROBOT" });
  await expect(robot.getByText(/SN-9001/)).toBeVisible();
  await expect(robot.getByText(/SN-9002/)).toBeVisible();
  await expect(robot.getByText("2", { exact: true })).toBeVisible();

  // Search by SKU also finds it.
  await pick.fill("SAMPLE-ROBOT");
  await expect(page.getByRole("option", { name: /Sample Robot/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Check & finish" }).click();
  await page.getByRole("button", { name: "Finish delivery" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Delivery received" })).toBeVisible();
  expect(errors).toEqual([]);
});
