/**
 * A simulated Shopify, for running the whole loop before a real store exists.
 *
 * It implements the SAME GraphQL contract the live client speaks, so nothing in
 * `shopify.ts` changes between sim and live — which is the point. A simulator
 * that takes a different code path proves the simulator works, not the product.
 *
 * WHAT IT FAITHFULLY REPRODUCES, because it is the behaviour worth testing:
 *   - compare-and-set: a set is REFUSED when `compareQuantity` does not match
 *     what the store currently holds, with a STALE_QUANTITY error;
 *   - `ignoreCompareQuantity` forcing the write;
 *   - reading back a live level.
 *
 * `sellOne()` is the demo lever: it moves the store's number behind our back,
 * exactly as a customer would, so the oversell guard can be SHOWN rather than
 * described.
 */
import type { GraphQLFetch } from "./shopify";

type Key = string;
const keyOf = (inventoryItemId: string, locationId: string) => `${inventoryItemId}@${locationId}`;

export class ShopifySim {
  private quantities = new Map<Key, number>();
  /** Every call, for a demo panel or an assertion. */
  readonly calls: { op: string; vars: any }[] = [];

  seed(inventoryItemId: string, locationId: string, quantity: number) {
    this.quantities.set(keyOf(inventoryItemId, locationId), quantity);
  }

  get(inventoryItemId: string, locationId: string) {
    return this.quantities.get(keyOf(inventoryItemId, locationId)) ?? 0;
  }

  /** A customer bought one, without telling us. The thing compare-and-set is for. */
  sellOne(inventoryItemId: string, locationId: string, n = 1) {
    const k = keyOf(inventoryItemId, locationId);
    this.quantities.set(k, Math.max(0, (this.quantities.get(k) ?? 0) - n));
  }

  client(): GraphQLFetch {
    return async (query, variables: any) => {
      if (query.includes("query Level")) {
        this.calls.push({ op: "read", vars: variables });
        const id = variables.id as string;
        const nodes = [...this.quantities.entries()]
          .filter(([k]) => k.startsWith(`${id}@`))
          .map(([k, q]) => ({
            location: { id: k.split("@")[1] },
            quantities: [{ name: "available", quantity: q }],
          }));
        return { data: { inventoryItem: { inventoryLevels: { nodes } } } };
      }

      this.calls.push({ op: "set", vars: variables });
      const input = variables.input;
      const line = input.quantities[0];
      const k = keyOf(line.inventoryItemId, line.locationId);
      const current = this.quantities.get(k);

      if (!input.ignoreCompareQuantity) {
        if (current !== line.compareQuantity) {
          // Exactly what the real API does: refuse rather than clobber.
          return {
            data: {
              inventorySetQuantities: {
                userErrors: [
                  {
                    field: ["quantities", "compareQuantity"],
                    code: "STALE_QUANTITY",
                    message: `compareQuantity ${line.compareQuantity} does not match ${current}`,
                  },
                ],
              },
            },
          };
        }
      }

      this.quantities.set(k, line.quantity);
      return {
        data: {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: { createdAt: new Date().toISOString(), reason: input.reason },
            userErrors: [],
          },
        },
      };
    };
  }
}

/**
 * Which mode are we in, and is that unambiguous?
 *
 * 🔴 THE FAILURE THIS GUARDS IS "THOUGHT IT WAS SIM, WAS LIVE" — a demo that
 * quietly writes wrong quantities into a real storefront. So live requires BOTH
 * credentials AND an explicit `SHOPIFY_MODE=live`; credentials alone are not
 * consent. Everything else is sim, and sim never touches the network.
 */
export function shopifyMode(env: NodeJS.ProcessEnv = process.env): {
  mode: "sim" | "live";
  reason: string;
} {
  const hasCreds = Boolean(env.SHOPIFY_SHOP && env.SHOPIFY_ADMIN_TOKEN);
  if (env.SHOPIFY_MODE === "live") {
    if (!hasCreds) {
      // Refusing beats falling back to sim: a run that was MEANT to be live and
      // silently simulated reports success for pushes that never happened.
      throw new Error(
        "SHOPIFY_MODE=live but SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN are missing — refusing to fall back to sim"
      );
    }
    return { mode: "live", reason: "SHOPIFY_MODE=live with credentials present" };
  }
  return {
    mode: "sim",
    reason: hasCreds
      ? "credentials present but SHOPIFY_MODE is not 'live' — credentials alone are not consent"
      : "no Shopify credentials configured",
  };
}
