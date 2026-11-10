import { expect, test } from "@playwright/test";

/** Feedback #20: create a bundle on the Items page, see what can be made, ship one. */
test("create a bundle from components and ship it", async ({ browser }) => {
  const errors: string[] = [];
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await desk.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabel("Company name").fill("Bundle Test Co");
  await page.getByLabel("State").fill("PA");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your name").fill("Ada Admin");
  await expect(page.getByRole("radio", { name: "Admin" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("radio", { name: "Try it with sample data" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Open ProfitIndex" }).click();
  await expect(page.getByText("The books are sound")).toBeVisible();

  // Stock 6 widgets through the API (a found-stock adjustment), as the admin.
  const profiles = await (await page.request.get("/api/profiles")).json();
  const ada = profiles.find((p: { name: string }) => p.name === "Ada Admin");
  const items = await (await page.request.get("/api/items")).json();
  const widget = items.find((i: { sku: string }) => i.sku === "SAMPLE-WIDGET");
  const warehouses = await (await page.request.get("/api/warehouses")).json();
  const headers = { "x-profile": String(ada.id) };
  const adj = await page.request.post("/api/adjustments", { headers, data: { itemId: widget.id, warehouseId: warehouses[0].id, qty: 6, unitCostCents: 50000, reason: "e2e stock" } });
  expect(adj.ok(), await adj.text()).toBeTruthy();

  await page.goto("/items");
  await page.getByRole("button", { name: "Create bundle" }).click();
  const dialog = page.getByRole("dialog", { name: "Create bundle" });
  await dialog.getByLabel("SKU").fill("KIT-PAIR");
  await dialog.getByLabel("Name").fill("Widget pair");
  await dialog.getByRole("combobox", { name: "Component 1" }).click();
  await page.getByRole("option", { name: /Sample Widget/ }).first().click();
  await dialog.getByRole("textbox", { name: "Quantity 1" }).fill("2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const row = page.locator("tr, .mantine-Card-root, .ruled-row").filter({ hasText: "KIT-PAIR" }).first();
  await expect(row.getByText("Bundle")).toBeVisible();
  await row.getByRole("button", { name: "Ship Widget pair" }).click();
  const ship = page.getByRole("dialog", { name: "Ship Widget pair" });
  await expect(ship.getByText("Can make 3 here")).toBeVisible();
  await ship.getByLabel("How many").fill("2");
  await ship.getByLabel("Reference").fill("SO-TEST-1");
  await ship.getByRole("button", { name: "Ship" }).click();
  await expect(ship).toBeHidden();

  await page.goto("/");
  await expect(page.getByText("The books are sound")).toBeVisible();
  const after = await (await page.request.get("/api/items")).json();
  expect(after.find((i: { sku: string }) => i.sku === "KIT-PAIR").available).toBe(1);
  expect(errors).toEqual([]);
});
