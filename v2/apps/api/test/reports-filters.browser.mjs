/** Browser regression checks against a local web preview with deterministic API responses.
 * Run from v2: npm exec -w @pi/web -- vite preview --host 127.0.0.1 --port 4317
 * Then: node apps/api/test/reports-filters.browser.mjs
 * No database or external services are accessed by this script.
 */
import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({
  ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('pi.profile', JSON.stringify({ id: 1, name: 'Test', job: 'ADMIN' })));
  const item = (sku, name) => ({ sku, name });
  const stock = [
    { itemId: 1, sku: 'WIDGET', name: 'Widget', onHand: 5, held: 0, valueCents: 500, glCents: 500, averageCents: 100, varianceCents: 0 },
    { itemId: 2, sku: 'ROBOT', name: 'Robot', onHand: 0, held: 0, valueCents: 0, glCents: 0, averageCents: 0, varianceCents: 0 },
    { itemId: 3, sku: 'HELD', name: 'Held only', onHand: 0, held: 2, valueCents: 0, glCents: 0, averageCents: 0, varianceCents: 0 },
  ];
  const held = ['Widget', 'Robot'].map((name, i) => ({ poId: i + 1, poNumber: `PO-${i + 1}`, vendor: { name: i ? 'Beta' : 'Alpha' }, item: item(name.toUpperCase(), name), qtyHeld: 2, estimateCents: 200, receivedAt: '2026-02-01', days: 1 }));
  const orders = ['Widget', 'Robot'].map((name, i) => ({ poId: i + 1, poNumber: `PO-${i + 1}`, billingStatus: 'NOT_BILLED', vendor: { name: i ? 'Beta' : 'Alpha' }, warehouse: { id: i + 1, code: i ? 'B' : 'A', name: 'Depot' }, days: 1, units: 2, valueCents: 200, lines: [{ lineId: i + 1, item: item(name.toUpperCase(), name), ordered: 2, received: 0, outstanding: 2, billed: false }] }));
  const movements = [
    { id: 1, itemId: 1, transactionDate: '2026-02-01', sku: 'WIDGET', name: 'Widget', brand: 'Acme', category: 'Parts', inboundQty: 4, outboundQty: 0, endingBalance: 12 },
    { id: 2, itemId: 1, transactionDate: '2026-02-02', sku: 'WIDGET', name: 'Widget', brand: 'Acme', category: 'Parts', inboundQty: 0, outboundQty: 3, endingBalance: 9 },
    { id: 3, itemId: 2, transactionDate: '2026-02-02', sku: 'ROBOT', name: 'Robot', brand: 'Other', category: 'Tools', inboundQty: 2, outboundQty: 0, endingBalance: 2 },
  ];
  const journal = Array.from({ length: 505 }, (_, i) => ({ id: i + 1, number: `JE-${i + 1}`, date: '2026-02-01', actor: 'Ada', memo: 'Freight', event: 'BILL_POSTED', sourceType: 'TEST', sourceId: 1, lines: ['DEBIT', 'CREDIT'].map((side, j) => ({ id: 2 * i + j, side, amountCents: 100, role: 'test', account: { code: '1200', name: 'Inventory' } })) }));
  const journalRequests = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let body = {};
    switch (url.pathname) {
      case '/api/setup': body = { required: false, company: { name: 'Test', feedbackEnabled: false } }; break;
      case '/api/books/check': body = { sound: true, problems: [], figures: {} }; break;
      case '/api/reports/trial-balance': body = { rows: [], totalDebitCents: 0, totalCreditCents: 0 }; break;
      case '/api/reports/valuation': body = { rows: stock, totalValueCents: 500, totalGlCents: 500 }; break;
      case '/api/reports/held': body = held; break;
      case '/api/reports/to-receive': body = { orders, totalUnits: 4, totalValueCents: 400 }; break;
      case '/api/reports/inventory-movement': body = { rows: movements }; break;
      case '/api/journal': {
        journalRequests.push(Object.fromEntries(url.searchParams));
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const filtered = journal.filter((entry) => `${entry.number} ${entry.memo} ${entry.actor} Inventory 1200`.toLowerCase().includes(q));
        const skip = Number(url.searchParams.get('skip') || 0);
        body = filtered.slice(skip, skip + Number(url.searchParams.get('take') || 50));
        break;
      }
    }
    await route.fulfill({ json: body });
  });
  const panel = () => page.getByRole('tabpanel');
  const count = async (text) => {
    try { await expect(panel().getByRole('status')).toHaveText(text); }
    catch (error) { console.error({ errors, url: page.url(), body: await page.locator('body').innerText() }); throw error; }
  };
  const clear = () => panel().getByRole('button', { name: 'Clear filters' }).click();
  const nothing = () => expect(panel().getByText('Nothing matches these filters.', { exact: true })).toBeVisible();
  const choose = async (label, option) => {
    await panel().getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  const wraps = async () => {
    const fields = panel().locator('input:visible');
    const boxes = await fields.evaluateAll((inputs) => inputs.map((input) => { const r = input.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; }));
    expect(boxes.every((box) => box.left >= 0 && box.right <= 375)).toBe(true);
    if (boxes.length > 1) expect(new Set(boxes.map((box) => box.top)).size).toBeGreaterThan(1);
  };

  await page.goto('http://127.0.0.1:4317/reports?cat=inventory&tab=stock');
  await count('3 items shown');
  // The checked state follows the router's asynchronous URL update.
  await panel().getByRole('checkbox', { name: 'Hide zero stock' }).click();
  await expect(panel().getByRole('checkbox', { name: 'Hide zero stock' })).toBeChecked();
  await count('2 items shown'); // Awaiting-bill stock is still physical stock.
  await panel().getByLabel('Search items').fill('widget');
  await count('1 item shown');
  await expect(panel().getByRole('row').last()).toHaveText('Total$5.00$5.00');
  await page.reload();
  await count('1 item shown');
  await expect(panel().getByLabel('Search items')).toHaveValue('widget');
  await panel().getByLabel('Search items').fill('missing'); await nothing();
  await clear(); await count('3 items shown');
  expect(new URL(page.url()).search).toBe('?cat=inventory&tab=stock');

  await page.getByRole('tab', { name: 'Inventory movement', exact: true }).click();
  await panel().getByLabel('Start date').fill('2026-02-01');
  await panel().getByLabel('End date').fill('2026-02-28');
  await choose('Brand', 'Acme'); await count('2 movements shown');
  expect(await panel().locator('tbody tr td:last-child').allTextContents()).toEqual(['12', '9']);
  await choose('Category', 'Tools'); await nothing();
  await clear(); await count('3 movements shown');
  await panel().getByLabel('Search items').fill('widget');
  await count('2 movements shown'); await wraps();
  await page.reload(); await count('2 movements shown');
  expect(await panel().locator('tbody tr td:last-child').allTextContents()).toEqual(['12', '9']);

  await page.goto('http://127.0.0.1:4317/reports?cat=purchases&tab=held');
  await panel().getByLabel('Search awaiting bill').fill('Alpha'); await count('1 line shown');
  await panel().getByLabel('Search awaiting bill').fill('PO-2'); await count('1 line shown');
  await panel().getByLabel('Search awaiting bill').fill('ROBOT'); await count('1 line shown');
  await panel().getByLabel('Search awaiting bill').fill('missing'); await nothing();
  await clear(); await count('2 lines shown');
  await panel().getByLabel('Search awaiting bill').fill('Alpha');
  await page.getByRole('tab', { name: 'To receive', exact: true }).click();
  await choose('Warehouse', 'Depot (B)'); await count('1 order shown');
  await expect(panel().getByText('PO-2 · Beta')).toBeVisible();
  await panel().getByLabel('Search orders').fill('Widget'); await nothing();
  await clear(); await count('2 orders shown');
  await panel().getByLabel('Search orders').fill('Robot'); await count('1 order shown');
  await wraps();
  await page.reload(); await count('1 order shown');
  await page.getByRole('tab', { name: 'Awaiting bill', exact: true }).click();
  await expect(panel().getByLabel('Search awaiting bill')).toHaveValue('Alpha');

  await page.goto('http://127.0.0.1:4317/reports?cat=accounting&tab=journal&journal_q=Freight&journal_from=2026-02-01&journal_to=2026-02-28&journal_event=BILL_POSTED');
  await count('50 entries shown'); await wraps();
  await panel().getByRole('button', { name: 'Show 50 more' }).click(); await count('100 entries shown');
  expect(journalRequests.at(-1)).toEqual({ take: '50', skip: '50', event: 'BILL_POSTED', q: 'Freight', from: '2026-02-01', to: '2026-02-28' });
  for (let loaded = 150; loaded <= 500; loaded += 50) {
    await panel().getByRole('button', { name: 'Show 50 more' }).click(); await count(`${loaded} entries shown`);
  }
  await panel().getByRole('button', { name: 'Show 50 more' }).click(); await count('505 entries shown');
  expect(journalRequests.at(-1).skip).toBe('500');
  await expect(panel().getByRole('row').last()).toHaveText('Total shown$505.00$505.00');
  await panel().getByLabel('Search entries').fill('JE-505'); await count('1 entry shown');
  expect(journalRequests.at(-1).skip).toBe('0');
  await expect(panel().getByRole('row').last()).toHaveText('Total shown$1.00$1.00');
  await page.reload(); await count('1 entry shown');
  await expect(panel().getByLabel('From (UTC)')).toHaveValue('2026-02-01');
  await panel().getByLabel('Search entries').fill('missing'); await nothing();
  await clear(); await count('50 entries shown');
  expect(new URL(page.url()).search).toBe('?cat=accounting&tab=journal');
  await page.getByRole('tab', { name: 'Trial balance', exact: true }).click();
  await page.goBack(); await count('50 entries shown');
  expect(errors).toEqual([]);
  console.log('PASS: all five report filters, URL reload/tab/back navigation, journal params/paging past 500/totals, movement balances, distinct empty states, clear, and 375px control wrapping');
} finally {
  await browser.close();
}
