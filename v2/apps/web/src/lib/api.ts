import { recordProblem } from "./diagnostics";
/** The API, as the person currently working: their profile id rides on every request. */
const PROFILE_KEY = "pi.profile";

export type Job = "CLERK" | "ACCOUNTING" | "ADMIN";
export type Profile = { id: number; name: string; job: Job };

export function storedProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
}

export function storeProfile(profile: Profile | null) {
  try {
    if (profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(PROFILE_KEY);
  } catch {
    // Private mode or blocked storage: the choice lasts for this tab only.
  }
}

/** Which company this device works in (Settings > Company > Test companies). Absent = the main company. */
const COMPANY_KEY = "pi.company";

export function storedCompany(): string | null {
  try {
    return localStorage.getItem(COMPANY_KEY);
  } catch {
    return null;
  }
}

/** Move this device into another company: forget who's working there and start over from the first screen. */
export function switchCompany(id: string | null) {
  try {
    if (id && id !== "main") localStorage.setItem(COMPANY_KEY, id);
    else localStorage.removeItem(COMPANY_KEY);
    // A delivery in progress and the last warehouse belong to the company being left.
    localStorage.removeItem("pi.receive");
    localStorage.removeItem("pi.warehouse");
  } catch {
    // Storage blocked: the switch can't be remembered.
  }
  storeProfile(null);
  window.location.assign("/");
}

/** Headers every request carries: the company, then who's working in it. */
export function scopeHeaders(): Record<string, string> {
  const profile = storedProfile();
  const company = storedCompany();
  return { ...(company ? { "x-company": company } : {}), ...(profile ? { "x-profile": String(profile.id) } : {}) };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...scopeHeaders() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    recordProblem(`${method} ${path} → no connection`);
    throw new ApiError("No connection. Your work is safe on this device; try again when you're back online.", 0);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    recordProblem(`${method} ${path} → ${response.status} ${data?.error ?? ""}`.trim());
    if (response.status === 401) onUnauthorized?.();
    throw new ApiError(data?.error ?? `Request failed (${response.status})`, response.status);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const put = <T>(path: string, body: unknown = {}) => api<T>("PUT", path, body);
export const patch = <T>(path: string, body: unknown = {}) => api<T>("PATCH", path, body);
export const del = <T>(path: string) => api<T>("DELETE", path);
