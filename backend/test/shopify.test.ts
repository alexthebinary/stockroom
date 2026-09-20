/**
 * The Shopify push, and specifically the compare-and-set behaviour that makes
 * "never oversell" real rather than aspirational.
 *
 * No network: the GraphQL client is injected, so the retry ladder is exercised
 * exactly. A test that mocked at a higher level would prove nothing about the
 * one thing that matters here — what we do when Shopify says our number is stale.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { boot, prisma } from "./helpers";
import { pushAvailability, SHOPIFY_API_VERSION } from "../src/shopify";
import { applyBalanceDelta } from "../src/inventory";

let warehouseId: number;

beforeAll(async () => {
  await boot();
  warehouseId = (await prisma.warehouse.create({ data: { name: "Shop WH", code: "SHOP" } })).id;
  await prisma.shopifyLocation.create({ data: { warehouseId, locationId: "gid://shopify/Location/1" } });
});

async function linkedProduct(sku: string, onHand: number, reserved = 0) {
  const p = await prisma.product.create({ data: { sku, name: sku } });
  await prisma.shopifyLink.create({
    data: {
      productId: p.id,
      variantId: `gid://shopify/ProductVariant/${p.id}`,
      inventoryItemId: `gid://shopify/InventoryItem/${p.id}`,
    },
  });
  await prisma.$transaction((tx) =>
    applyBalanceDelta(tx, p.id, warehouseId, { onHandQty: onHand, reservedQty: reserved }, "seed")
  );
  return p;
}

const ok = () => ({ data: { inventorySetQuantities: { userErrors: [] } } });
const stale = () => ({
  data: { inventorySetQuantities: { userErrors: [{ code: "STALE_QUANTITY", message: "compareQuantity did not match" }] } },
});
const level = (q: number) => ({
  data: {
    inventoryItem: {
      inventoryLevels: {
        nodes: [{ location: { id: "gid://shopify/Location/1" }, quantities: [{ name: "available", quantity: q }] }],
      },
    },
  },
});

describe("pinning", () => {
  it("pins an API version — an unpinned one breaks silently on Shopify's schedule", () => {
    expect(SHOPIFY_API_VERSION).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("publishing availability", () => {
  it("publishes available minus the safety buffer", async () => {
    const p = await linkedProduct("SH-1", 10, 2); // available 8
    const calls: any[] = [];
    const res = await pushAvailability(prisma, async (q, v) => { calls.push(v); return ok(); },
      { productId: p.id, warehouseId, buffer: 1 });

    expect(res).toMatchObject({ status: "pushed", quantity: 7 });
    expect(calls[0].input.quantities[0].quantity).toBe(7);
    // First push has nothing to compare against.
    expect(calls[0].input.ignoreCompareQuantity).toBe(true);
  });

  it("guards every push after the first with compareQuantity", async () => {
    const p = await linkedProduct("SH-2", 5);
    await pushAvailability(prisma, async () => ok(), { productId: p.id, warehouseId, buffer: 0 });

    const calls: any[] = [];
    await pushAvailability(prisma, async (q, v) => { calls.push(v); return ok(); },
      { productId: p.id, warehouseId, buffer: 0 });

    expect(calls[0].input.ignoreCompareQuantity).toBe(false);
    expect(calls[0].input.quantities[0].compareQuantity, "what we last told Shopify").toBe(5);
  });

  it("🔴 re-reads and retries when Shopify says our number is stale", async () => {
    // Someone bought one while we were computing. Shopify refuses the set
    // rather than letting us clobber the sale — then we take its number and
    // try again against reality.
    const p = await linkedProduct("SH-3", 4);
    await pushAvailability(prisma, async () => ok(), { productId: p.id, warehouseId, buffer: 0 });

    const seen: any[] = [];
    let call = 0;
    const res = await pushAvailability(
      prisma,
      async (query, vars) => {
        if (query.includes("query Level")) return level(3);   // Shopify really has 3
        seen.push(vars.input.quantities[0]);
        return ++call === 1 ? stale() : ok();
      },
      { productId: p.id, warehouseId, buffer: 0 }
    );

    expect(res).toMatchObject({ status: "pushed", attempts: 2 });
    expect(seen[0].compareQuantity, "our stale belief").toBe(4);
    expect(seen[1].compareQuantity, "Shopify's actual number").toBe(3);
  });

  it("gives up as a conflict rather than forcing the write", async () => {
    // A number that keeps moving means a busy storefront. Forcing it with
    // ignoreCompareQuantity would be exactly the oversell this prevents.
    const p = await linkedProduct("SH-4", 9);
    await pushAvailability(prisma, async () => ok(), { productId: p.id, warehouseId, buffer: 0 });

    const res = await pushAvailability(
      prisma,
      async (query) => (query.includes("query Level") ? level(1) : stale()),
      { productId: p.id, warehouseId, buffer: 0, maxAttempts: 3 }
    );
    expect(res.status).toBe("conflict");
    expect((res as any).attempts).toBe(3);
  });

  it("never publishes a negative quantity", async () => {
    const p = await linkedProduct("SH-5", 1);
    const calls: any[] = [];
    await pushAvailability(prisma, async (q, v) => { calls.push(v); return ok(); },
      { productId: p.id, warehouseId, buffer: 5 });
    expect(calls[0].input.quantities[0].quantity).toBe(0);
  });

  it("reports an unlinked product instead of throwing", async () => {
    const p = await prisma.product.create({ data: { sku: "SH-NOLINK", name: "no link" } });
    const res = await pushAvailability(prisma, async () => ok(),
      { productId: p.id, warehouseId, buffer: 0 });
    expect(res).toMatchObject({ status: "unlinked" });
  });

  it("surfaces a non-stale error without retrying it", async () => {
    const p = await linkedProduct("SH-6", 3);
    let calls = 0;
    const res = await pushAvailability(
      prisma,
      async () => { calls++; return { data: { inventorySetQuantities: { userErrors: [{ code: "INVALID", message: "bad location" }] } } }; },
      { productId: p.id, warehouseId, buffer: 0 }
    );
    expect(res).toMatchObject({ status: "failed" });
    expect(calls, "a permanent error must not be retried").toBe(1);
  });
});
