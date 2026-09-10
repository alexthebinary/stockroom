import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { badRequest, notFound } from "./errors";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Validates that every product and warehouse referenced by a set of lines
 * exists and is still active, before anything is written.
 *
 * Without this the database raises a foreign-key error deep inside a nested
 * create, which is both a worse message and harder to map to a status code. It
 * also closes the window where a client's cached dropdown still offers a
 * product or warehouse that has since been deactivated.
 */
export async function assertReferencesUsable(
  client: Client,
  refs: { productId: number; warehouseId: number }[]
) {
  const productIds = [...new Set(refs.map((r) => r.productId))];
  const warehouseIds = [...new Set(refs.map((r) => r.warehouseId))];

  const [products, warehouses] = await Promise.all([
    client.product.findMany({ where: { id: { in: productIds } } }),
    client.warehouse.findMany({ where: { id: { in: warehouseIds } } }),
  ]);

  const missingProduct = productIds.find((id) => !products.some((p) => p.id === id));
  if (missingProduct !== undefined) throw notFound(`Product ${missingProduct} not found`);

  const missingWarehouse = warehouseIds.find((id) => !warehouses.some((w) => w.id === id));
  if (missingWarehouse !== undefined) throw notFound(`Warehouse ${missingWarehouse} not found`);

  const inactiveProduct = products.find((p) => !p.isActive);
  if (inactiveProduct) {
    throw badRequest(`Product ${inactiveProduct.sku} is inactive and cannot be used on new activity`);
  }

  const inactiveWarehouse = warehouses.find((w) => !w.isActive);
  if (inactiveWarehouse) {
    throw badRequest(
      `Warehouse ${inactiveWarehouse.code} is inactive and cannot be used on new activity`
    );
  }

  return { products, warehouses };
}
