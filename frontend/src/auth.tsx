import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { api, DEMO_USER_KEY } from "./api";

export type DemoUser = { email: string; name: string; role: string };

type AuthValue = {
  user: DemoUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

function readStoredUser(): DemoUser | null {
  try {
    const raw = localStorage.getItem(DEMO_USER_KEY);
    return raw ? (JSON.parse(raw) as DemoUser) : null;
  } catch {
    return null;
  }
}

/**
 * Demo auth only: the backend checks a hard-coded pair and returns a user
 * object we keep in localStorage. There is no token and no session — every API
 * route is open. Do not model real auth on this.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DemoUser | null>(readStoredUser);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ user: DemoUser }>("/auth/login", { email, password });
    localStorage.setItem(DEMO_USER_KEY, JSON.stringify(res.user));
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(DEMO_USER_KEY);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
