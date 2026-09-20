/**
 * Push available stock to Shopify. OUTBOUND QUANTITY ONLY.
 *
 * 🔴 SHOPIFY NEVER WRITES OUR QUANTITY. Stockroom owns stock, because every
 * quantity here has a FIFO cost layer behind it and a Shopify payload does not.
 * Letting an inbound number set `InventoryBalance` would produce stock with no
 * cost trail — the same silent failure as receiving an unknown item at zero
 * cost. Orders come inbound as real SalesOrders through the normal path;
 * quantities only go out.
 *
 * COMPARE-AND-SET. `inventorySetQuantities` only applies when the quantity
 * currently persisted at Shopify matches the `compareQuantity` we send
 * (shopify.dev, GraphQL Admin). A mismatch means someone sold while we were
 * computing, so the mutation errors rather than clobbering the sale. That is
 * the same optimistic-concurrency idiom as consumeFifo's conditional update,
 * and it is what makes "never oversell" true rather than aspirational.
 *
 * SAFETY BUFFER. We publish available-minus-buffer, so the storefront runs out
 * slightly before the shelf does. Overselling costs a refund, an apology and a
 * marketplace metric; under-publishing costs one sale.
 */
import { badRequest } from "./errors";
import type { Prisma } from "@prisma/client";

export type Tx = Prisma.TransactionClient;

/** Pinned. Shopify deprecates on a schedule; an unpinned version breaks silently. */
export const SHOPIFY_API_VERSION = "2026-04";

export type ShopifyConfig = { shop: string; token: string; buffer: number };

export function shopifyConfig(): ShopifyConfig | null {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) return null;
  return { shop, token, buffer: Number(process.env.SHOPIFY_SAFETY_BUFFER ?? 1) };
}

const SET_QUANTITIES = `
mutation SetOnHand($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup { createdAt reason }
    userErrors { field message code }
  }
}`;

export type GraphQLFetch = (query: string, variables: unknown) => Promise<any>;

/** Injected so tests exercise the retry logic without a network. */
export function makeClient(cfg: ShopifyConfig): GraphQLFetch {
  return async (query, variables) => {
    const res = await fetch(
      `https://${cfg.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": cfg.token,
        },
        body: JSON.stringify({ query, variables }),
      }
    );
    return res.json();
  };
}

export type PushOutcome =
  | { status: "pushed"; quantity: number; attempts: number }
  | { status: "unlinked"; reason: string }
  | { status: "conflict"; reason: string; attempts: number }
  | { status: "failed"; reason: string; attempts: number };

/**
 * Publish one product's availability at one warehouse.
 *
 * ⚠️ NOT called inside a $transaction, deliberately. SQLite serialises writers,
 * so a transaction left open across a network call to Shopify stalls every
 * other write in the app. Post the ledger first, publish afterwards.
 */
export async function pushAvailability(
  db: Tx,
  gql: GraphQLFetch,
  input: { productId: number; warehouseId: number; buffer: number; maxAttempts?: number }
): Promise<PushOutcome> {
  const maxAttempts = input.maxAttempts ?? 3;

  const link = await db.shopifyLink.findUnique({ where: { productId: input.productId } });
  if (!link) return { status: "unlinked", reason: "product is not linked to a Shopify variant" };
  const loc = await db.shopifyLocation.findUnique({ where: { warehouseId: input.warehouseId } });
  if (!loc) return { status: "unlinked", reason: "warehouse is not mapped to a Shopify location" };

  const balance = await db.inventoryBalance.findFirst({
    where: { productId: input.productId, warehouseId: input.warehouseId },
  });
  const available = Math.max(0, (balance?.onHandQty ?? 0) - (balance?.reservedQty ?? 0));
  const publish = Math.max(0, available - input.buffer);

  let compare = link.lastPushedQty;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await gql(SET_QUANTITIES, {
      input: {
        name: "available",
        reason: "correction",
        // First push has nothing to compare against — Shopify accepts the
        // absolute set, and every push after this one is guarded.
        ignoreCompareQuantity: compare === null || compare === undefined,
        quantities: [
          {
            inventoryItemId: link.inventoryItemId,
            locationId: loc.locationId,
            quantity: publish,
            ...(compare === null || compare === undefined ? {} : { compareQuantity: compare }),
          },
        ],
      },
    });

    const errors = res?.data?.inventorySetQuantities?.userErrors ?? [];
    const transport = res?.errors ?? [];

    if (!errors.length && !transport.length) {
      await db.shopifyLink.update({
        where: { id: link.id },
        data: { lastPushedQty: publish, lastPushedAt: new Date() },
      });
      return { status: "pushed", quantity: publish, attempts: attempt };
    }

    const all = [...errors, ...transport];
    lastError = all.map((e: any) => e.message).join("; ");
    const stale = all.some(
      (e: any) => e.code === "STALE_QUANTITY" || /compare/i.test(String(e.message))
    );

    if (!stale) return { status: "failed", reason: lastError, attempts: attempt };

    // Someone sold while we were computing. That is exactly what compare-and-set
    // exists to catch: re-read what Shopify holds now and try again against it,
    // rather than overwriting a real sale with a stale number.
    const live = await readLiveQuantity(gql, link.inventoryItemId, loc.locationId);
    if (live === null) return { status: "failed", reason: `${lastError} (could not re-read)`, attempts: attempt };
    compare = live;
  }

  return { status: "conflict", reason: lastError, attempts: maxAttempts };
}

const READ_LEVEL = `
query Level($id: ID!) {
  inventoryItem(id: $id) {
    inventoryLevels(first: 20) {
      nodes { location { id } quantities(names: ["available"]) { name quantity } }
    }
  }
}`;

export async function readLiveQuantity(
  gql: GraphQLFetch,
  inventoryItemId: string,
  locationId: string
): Promise<number | null> {
  const res = await gql(READ_LEVEL, { id: inventoryItemId });
  const nodes = res?.data?.inventoryItem?.inventoryLevels?.nodes ?? [];
  const node = nodes.find((n: any) => n?.location?.id === locationId);
  const q = node?.quantities?.find((x: any) => x.name === "available");
  return typeof q?.quantity === "number" ? q.quantity : null;
}

export function assertLinkable(sku: string, variantId?: string, inventoryItemId?: string) {
  if (!variantId || !inventoryItemId) {
    throw badRequest(`${sku}: a Shopify link needs both a variant id and an inventory item id`);
  }
}
