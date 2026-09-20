/**
 * Sim mode, and the guard that matters more than the simulator: you cannot
 * think you are in sim while pointed at a real store.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { boot, prisma } from "./helpers";
import { ShopifySim, shopifyMode } from "../src/shopify_sim";
import { pushAvailability } from "../src/shopify";
import { applyBalanceDelta } from "../src/inventory";

let warehouseId: number;

beforeAll(async () => {
  await boot();
  warehouseId = (await prisma.warehouse.create({ data: { name: "Sim WH", code: "SIMW" } })).id;
  await prisma.shopifyLocation.create({ data: { warehouseId, locationId: "gid://shopify/Location/9" } });
});

async function linked(sku: string, onHand: number) {
  const p = await prisma.product.create({ data: { sku, name: sku } });
  await prisma.shopifyLink.create({
    data: { productId: p.id, variantId: `v-${p.id}`, inventoryItemId: `ii-${p.id}` },
  });
  await prisma.$transaction((tx) =>
    applyBalanceDelta(tx, p.id, warehouseId, { onHandQty: onHand }, "seed")
  );
  return p;
}

describe("mode is explicit, and credentials are not consent", () => {
  it("defaults to sim with no credentials", () => {
    expect(shopifyMode({} as any).mode).toBe("sim");
  });

  it("🔴 stays in sim even WITH credentials unless the mode says live", () => {
    // The failure this prevents: a demo quietly writing real quantities into a
    // real storefront because someone left a token in the environment.
    const m = shopifyMode({ SHOPIFY_SHOP: "x.myshopify.com", SHOPIFY_ADMIN_TOKEN: "t" } as any);
    expect(m.mode).toBe("sim");
    expect(m.reason).toMatch(/not consent/i);
  });

  it("goes live only when asked explicitly", () => {
    const m = shopifyMode({
      SHOPIFY_SHOP: "x.myshopify.com", SHOPIFY_ADMIN_TOKEN: "t", SHOPIFY_MODE: "live",
    } as any);
    expect(m.mode).toBe("live");
  });

  it("refuses rather than silently simulating a run meant to be live", () => {
    // Falling back would report success for pushes that never happened.
    expect(() => shopifyMode({ SHOPIFY_MODE: "live" } as any)).toThrow(/refusing to fall back/i);
  });
});

describe("the simulator reproduces compare-and-set", () => {
  it("runs the full push loop with no network", async () => {
    const sim = new ShopifySim();
    const p = await linked("SIM-1", 10);
    sim.seed(`ii-${p.id}`, "gid://shopify/Location/9", 0);

    const res = await pushAvailability(prisma, sim.client(), {
      productId: p.id, warehouseId, buffer: 1,
    });
    expect(res).toMatchObject({ status: "pushed", quantity: 9 });
    expect(sim.get(`ii-${p.id}`, "gid://shopify/Location/9")).toBe(9);
  });

  it("🔴 a sale behind our back is refused, re-read, and retried", async () => {
    // This is the demo: push, someone buys one, push again. The second push
    // must NOT overwrite the sale with our stale number.
    const sim = new ShopifySim();
    const p = await linked("SIM-2", 5);
    sim.seed(`ii-${p.id}`, "gid://shopify/Location/9", 0);

    await pushAvailability(prisma, sim.client(), { productId: p.id, warehouseId, buffer: 0 });
    expect(sim.get(`ii-${p.id}`, "gid://shopify/Location/9")).toBe(5);

    sim.sellOne(`ii-${p.id}`, "gid://shopify/Location/9");     // storefront now 4
    await prisma.$transaction((tx) =>
      applyBalanceDelta(tx, p.id, warehouseId, { onHandQty: -1 }, "the sale reaching us")
    );

    const res = await pushAvailability(prisma, sim.client(), {
      productId: p.id, warehouseId, buffer: 0,
    });
    expect(res).toMatchObject({ status: "pushed", attempts: 2 });
    expect(sim.get(`ii-${p.id}`, "gid://shopify/Location/9")).toBe(4);

    const reads = sim.calls.filter((c) => c.op === "read");
    expect(reads.length, "it re-read the store rather than guessing").toBeGreaterThan(0);
  });

  it("honours ignoreCompareQuantity on a first push", async () => {
    const sim = new ShopifySim();
    const p = await linked("SIM-3", 2);
    // Store has a number we have never seen; the first push sets absolutely.
    sim.seed(`ii-${p.id}`, "gid://shopify/Location/9", 77);
    const res = await pushAvailability(prisma, sim.client(), {
      productId: p.id, warehouseId, buffer: 0,
    });
    expect(res.status).toBe("pushed");
    expect(sim.get(`ii-${p.id}`, "gid://shopify/Location/9")).toBe(2);
  });
});
