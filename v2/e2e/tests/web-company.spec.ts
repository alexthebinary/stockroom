import { expect, test } from '@playwright/test';

// A local Vite server serves the real client. API responses are controlled so
// deletion and storage interleavings do not depend on a shared database.
test.beforeEach(async ({ context }) => {
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const company = route.request().headers()['x-company'] ?? 'main';
    if (path === '/api/companies') {
      return route.fulfill({ json: { enabled: true, current: company === 'co_deleted' ? 'main' : company, companies: [
        { id: 'main', name: 'Main company', test: false },
        { id: 'co_1', name: 'Company A', test: true },
        { id: 'co_2', name: 'Company B', test: true },
      ] } });
    }
    if (company === 'co_deleted') return route.fulfill({ status: 404, json: { error: 'That test company no longer exists.' } });
    if (path === '/api/setup') return route.fulfill({ json: { required: false, company: { name: company } } });
    if (path === '/api/profiles') return route.fulfill({ json: [{ id: 1, name: `Worker ${company}`, job: 'CLERK' }] });
    return route.fulfill({ json: [] });
  });
});

test('review #22: a deleted stored company returns to main with a visible notice', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('initialized')) {
      localStorage.setItem('pi.company', 'co_deleted');
      sessionStorage.setItem('initialized', 'yes');
    }
  });
  await page.goto('/');
  await expect(page.getByText(/no longer exists.*main company/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Worker main/ })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pi.company'))).toBeNull();
});

test('review #1: switching in one tab reloads the other and replaces cached company data', async ({ context, page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('pi.company', 'co_1'));
  await page.reload();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('button', { name: /Worker co_1/ })).toBeVisible();
  await page.getByRole('button', { name: /Test company Company A/ }).click();
  await page.getByRole('button', { name: 'Switch', exact: true }).last().click();
  await expect(page.getByRole('button', { name: /Worker co_2/ })).toBeVisible();
  await expect(other.getByRole('button', { name: /Worker co_2/ })).toBeVisible();
  await expect(other.getByRole('button', { name: /Worker co_1/ })).toHaveCount(0);
});
