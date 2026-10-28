// Items are stored in kg and cm; people enter and read pounds and inches.
const LB_PER_KG = 2.2046226218;
const IN_PER_CM = 1 / 2.54;

const round = (n: number, places = 3) => Number(n.toFixed(places));

export const kgToLb = (kg: number) => round(kg * LB_PER_KG);
export const lbToKg = (lb: number) => lb / LB_PER_KG;
export const cmToIn = (cm: number) => round(cm * IN_PER_CM);
export const inToCm = (inches: number) => inches * 2.54;

/** "2.646 lb · 11.811×7.874×3.937 in" for the item list; empty when nothing is measured. */
export function formatMeasurements(item: { weightKg?: number | null; lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null }): string {
  const dimensions = [item.lengthCm, item.widthCm, item.heightCm];
  return [
    item.weightKg != null ? `${kgToLb(item.weightKg)} lb` : null,
    dimensions.some((d) => d != null) ? `${dimensions.map((d) => (d != null ? cmToIn(d) : "—")).join("×")} in` : null,
  ].filter(Boolean).join(" · ");
}
