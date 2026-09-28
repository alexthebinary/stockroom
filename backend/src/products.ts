/** Total cost of goods per unit: what the supplier charges plus freight to get it here. */
export function totalUnitCostCents(p: { costOfGoodsCents: number; supplierShippingCents: number }) {
  return p.costOfGoodsCents + p.supplierShippingCents;
}
