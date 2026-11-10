import { useCallback, useState } from "react";

/** A value kept in this browser (per person, per device). Storage can be blocked: it then lasts for the visit only. */
export function useLocalStore<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback((next: T) => {
    setValue(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* blocked: visit only */ }
  }, [key]);
  return [value, set];
}
