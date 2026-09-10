import { useQuery } from "@tanstack/react-query";
import { api, type Paginated, type Product, type Warehouse } from "./api";

/** Every select in the app picks from the same two lists, so they are cached once. */
export function useWarehouseOptions() {
  const query = useQuery({
    queryKey: ["warehouses", "options"],
    // Deactivated warehouses stay visible on the warehouses page but must not
    // be offered for new orders, transfers or adjustments.
    queryFn: () => api.get<{ data: Warehouse[] }>("/warehouses?activeOnly=true"),
    staleTime: 60_000,
  });
  return {
    ...query,
    warehouses: query.data?.data ?? [],
    options: (query.data?.data ?? []).map((w) => ({
      value: String(w.id),
      label: `${w.name} (${w.code})`,
    })),
  };
}

export function useProductOptions() {
  const query = useQuery({
    queryKey: ["products", "options"],
    queryFn: () => api.get<Paginated<Product>>("/products?pageSize=200&activeOnly=true"),
    staleTime: 60_000,
  });
  return {
    ...query,
    products: query.data?.data ?? [],
    options: (query.data?.data ?? []).map((p) => ({
      value: String(p.id),
      label: `${p.sku} — ${p.name}`,
    })),
  };
}
