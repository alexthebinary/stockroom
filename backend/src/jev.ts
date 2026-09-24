/**
 * The assistant's front door: TypeSafe Jev sorts a text message in ~0.4 s.
 *
 * Measured 2026-09-24 on 30 realistic messages against the full assistant:
 *   Jev   28/30 sorted right, median 0.37 s, ~1.4k Jev tokens
 *   LLM   29/30 handled right, median 6.5–12 s, ~3–6k model tokens
 * Both Jev misses sent the message to the full assistant (slower, not wrong),
 * and none of the 12 data/change requests was ever cut short.
 *
 * So Jev only ever chooses a CHEAPER, READ-ONLY answer — a link to a screen,
 * or a wiki page — and only when it is sure enough to pick one; anything about
 * data, any change, any photo, any error goes to the full assistant. It never
 * proposes an action and never reads the user's data. Its confidence is logged,
 * never used to decide: it was measured overconfident on this box.
 */

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// api.typesafe.ai's Cloudflare answers stock client User-Agents with 403 1010.
const JEV_UA = "stockroom/1.0 (+https://stockroom-axlo.onrender.com)";

export type JevRoute = {
  kind: "navigate" | "howto" | "assistant";
  screen?: string;
  page?: string;
  /** Which data would answer it (a DATA_GLOSS key), for the server to read up front. */
  data?: string;
  confidence?: number;
  ms: number;
};

export type JevFn = (message: string, route: string) => Promise<JevRoute | null>;

let jevOverride: JevFn | null | undefined;
export function setJevForTests(fn: JevFn | null | undefined) {
  jevOverride = fn;
}

export const SCREENS: Record<string, string> = {
  "/": "Home",
  "/showroom": "Store",
  "/receive": "Receive",
  "/inventory": "Stock on hand",
  "/products": "Products",
  "/warehouses": "Warehouses",
  "/transfers": "Transfers",
  "/adjustments": "Adjustments",
  "/sales-orders": "Sales orders",
  "/invoices": "Invoices",
  "/deliveries": "Shipped",
  "/sales-payments": "Payments received",
  "/purchase-payments": "Payments made",
  "/catalogs/customers": "Customers",
  "/purchase-orders": "Purchase orders",
  "/bills": "Bills",
  "/receipts": "Receipts",
  "/catalogs/vendors": "Vendors",
  "/close": "Month-end close",
  "/ledger": "Accounting",
  "/reports": "Reports",
};

const SCREEN_GLOSS: Record<string, string> = {
  "/": "Home: what needs attention today",
  "/showroom": "Store: selling to a walk-in client at the showroom counter (showroom sale)",
  "/receive": "Receive: scanning boxes of an arriving delivery",
  "/inventory": "Stock on hand: stock levels per product and warehouse",
  "/products": "Products: the product catalogue",
  "/warehouses": "Warehouses: locations",
  "/transfers": "Transfers: moving stock between warehouses",
  "/adjustments": "Adjustments: stock corrections",
  "/sales-orders": "Sales orders",
  "/invoices": "Invoices: customer invoices, paid and unpaid",
  "/deliveries": "Shipped: shipments sent to customers, tracking and delivery",
  "/sales-payments": "Payments received: customer payments, register a payment from a customer",
  "/purchase-payments": "Payments made: supplier payments, register a payment to a vendor",
  "/catalogs/customers": "Customers list",
  "/purchase-orders": "Purchase orders to suppliers",
  "/bills": "Bills: vendor/supplier bills to pay",
  "/receipts": "Receipts: goods received notes",
  "/catalogs/vendors": "Vendors list",
  "/close": "Month-end close: checks and locking a month",
  "/ledger": "Accounting: the general ledger, journal and trial balance",
  "/reports": "Reports: sales, purchases, stock, valuation",
};

const WIKI_GLOSS: Record<string, string> = {
  "getting-started": "signing in, the menu, Live Audit status, the assistant, roles",
  receiving: "goods arriving: receive screen, receiving on a purchase order, short shipments, serials",
  purchasing: "purchase orders, vendor bills, paying suppliers",
  "sales-orders": "sales orders, channels and payment terms, pack, ship, invoices, delivery",
  showroom: "selling to a walk-in showroom client at the counter",
  returns: "customer returns, restock or write off, credit and refund",
  inventory: "stock levels, products, warehouses, transfers, adjustments for found or damaged stock",
  "month-end-close": "month-end checks, closing a month, locking a finished month so nobody can change it",
  accounting: "ledger, journal entries, posting rules, trial balance, reports",
  settings: "categories, managers, users and roles",
};

/**
 * The data that answers a question, so the server can read it BEFORE the first
 * model call instead of the model spending a round deciding to. Read-only, as
 * the user; a wrong pick costs one extra model round, never a wrong answer.
 */
export const DATA_GLOSS: Record<string, string> = {
  attention: "what needs doing today: urgent receipts, shortages, low stock, bills to pay, orders to pack or ship",
  bills: "vendor / supplier bills: what we owe suppliers, unpaid or paid bills",
  invoices: "customer invoices: what customers owe us, unpaid or overdue invoices, receivables",
  stock_value: "the total value of the stock on hand, inventory valuation",
  stock_totals: "overall stock numbers: how many units or SKUs we hold, reserved, incoming, which products are low",
  purchase_orders: "the list of purchase orders to suppliers and their status (open, waiting on goods, received)",
  sales_orders: "the list of customer sales orders and their status (to pack, to ship, paid)",
  month_close: "this month's month-end checks: whether the month passes, what blocks closing it",
  balances: "account balances in the ledger: cash in the bank, revenue, cost of goods sold, trial balance",
  none: "none of these: a specific record by number or SKU, a how-to question, navigation, or a request to change something",
};

const KIND_GLOSS = {
  navigate: "the person wants to GO TO or OPEN a screen / page / list in the app",
  howto: "the person asks HOW to do something or what a feature means, and wants instructions",
  assistant:
    "the person asks about specific data (a quantity, an order, an amount, a status) or asks for a specific change to be made (pack, ship, receive, adjust, write off)",
};

/** The WAF 403s request bodies containing shell-looking text; strip code spans. */
function wafSafe(text: string) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`([^`\n]*)`/g, (m, inner) => (/[\s|/$;&<>]/.test(inner) ? " " : m));
}

const liveJev: JevFn = async (message, route) => {
  const key = process.env.TYPESAFE_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": JEV_UA },
      body: JSON.stringify({
        model: "jev-latest",
        state: { message: wafSafe(message).slice(0, 2000), current_page: route },
        questions: {
          kind: { type: "choice", instructions: "What kind of request is this message to an inventory app's assistant?", criteria: KIND_GLOSS },
          screen: { type: "choice", instructions: "Which screen of the app would this person need?", criteria: SCREEN_GLOSS },
          page: { type: "choice", instructions: "Which help page answers this?", criteria: WIKI_GLOSS },
          data: { type: "choice", instructions: "Which data in the app would answer this message?", criteria: DATA_GLOSS },
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.warn(`[jev] ${res.status} — falling through to the assistant`);
      return null;
    }
    const d = await res.json();
    const a = d.answers ?? {};
    const kind = a.kind?.choice;
    if (kind !== "navigate" && kind !== "howto" && kind !== "assistant") return null;
    return {
      kind,
      screen: a.screen?.choice,
      page: a.page?.choice,
      data: a.data?.choice,
      confidence: a.kind?.confidence,
      ms: Date.now() - t0,
    };
  } catch (e) {
    console.warn(`[jev] ${(e as Error).message} — falling through to the assistant`);
    return null;
  }
};

export async function routeWithJev(message: string, route: string): Promise<JevRoute | null> {
  if (jevOverride === null) return null;
  const fn = jevOverride ?? liveJev;
  const r = await fn(message, route);
  // One line per decision, so the beta's real routing can be re-scored later.
  if (r) console.log(JSON.stringify({ jev: r.kind, screen: r.screen, page: r.page, data: r.data, conf: r.confidence, ms: r.ms, route, msg: message.slice(0, 120) }));
  return r;
}

export function jevConfigured() {
  return Boolean(jevOverride || process.env.TYPESAFE_KEY);
}
