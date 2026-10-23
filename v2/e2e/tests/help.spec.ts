import { expect, test, type Page } from "@playwright/test";

async function mockApp(page: Page, configured = true) {
  await page.addInitScript(() => {
    localStorage.setItem("pi.profile", JSON.stringify({ id: 1, name: "New User", job: "CLERK" }));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path === "/api/setup" ? { required: false, company: { feedbackEnabled: false } }
      : path === "/api/help/status" ? { configured }
      : path === "/api/items/facets" ? { brands: [], categories: [] }
      : path === "/api/reports/valuation" ? { rows: [] }
      : [];
    await route.fulfill({ json });
  });
}

test("help is hidden without a model", async ({ page }) => {
  await mockApp(page, false);
  await page.goto("/items");
  await expect(page.getByRole("heading", { name: "Items", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open help", exact: true })).toHaveCount(0);
});

for (const width of [390, 1280]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`help explains and navigates at ${width}px in ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await mockApp(page);
      const payloads: { route: string; messages: { role: string; content: string }[] }[] = [];
      await page.route("**/api/help/chat/stream", async (route) => {
        payloads.push(route.request().postDataJSON());
        const reply = "Open Receive. Choose the supplier, then Start scanning.";
        const result = { reply, unanswered: false, navigate: { to: "/receive", label: "Receive" } };
        await route.fulfill({ contentType: "application/x-ndjson", body: [
          { type: "status", text: "Reading the help pages…" },
          { type: "text", text: reply },
          { type: "done", result },
        ].map((line) => JSON.stringify(line)).join("\n") + "\n" });
      });
      await page.goto("/items");
      await page.getByRole("button", { name: "Open help", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("On Items", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "How do I receive a delivery?", exact: true }).click();
      await expect(dialog.getByText("Open Receive. Choose the supplier, then Start scanning.", { exact: true })).toBeVisible();
      expect(payloads[0]).toMatchObject({ route: "/items", messages: [{ role: "user", content: "How do I receive a delivery?" }] });
      const overflow = await dialog.evaluate((node) => node.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      await page.screenshot({ path: `screenshots/help-${width}-${colorScheme}.png` });
      await dialog.getByRole("link", { name: "Take me there · Receive", exact: true }).click();
      await expect(page).toHaveURL(/\/receive$/);
      await expect(dialog).not.toBeVisible();
      await page.getByRole("button", { name: "Open help", exact: true }).click();
      await expect(dialog.getByText("On Receive", { exact: true })).toBeVisible();
      await dialog.getByRole("textbox", { name: "Your help question" }).fill("What happens next?");
      await dialog.getByRole("button", { name: "Send question" }).click();
      await expect.poll(() => payloads.length).toBe(2);
      expect(payloads[1]?.route).toBe("/receive");
    });
  }
}

test("failed streaming requests preserve the question for retry", async ({ page }) => {
  await mockApp(page);
  await page.route("**/api/help/chat/stream", (route) => route.fulfill({ status: 429, json: { error: "Try again in a few minutes." } }));
  await page.goto("/items");
  await page.getByRole("button", { name: "Open help", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Your help question" }).fill("Where do I find bills?");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Try again in a few minutes.");
  await expect(dialog.getByRole("textbox", { name: "Your help question" })).toHaveValue("Where do I find bills?");
});
