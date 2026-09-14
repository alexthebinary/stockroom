import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { api, AUTH_TOKEN_KEY, DEMO_USER_KEY } from "./api";

export type Capabilities = { stock: boolean; money: boolean; users: boolean };
export type DemoUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  can: Capabilities;
};

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
 * Real sessions now: the backend verifies a password and returns a signed
 * token, which every request carries. The user object here is a CONVENIENCE for
 * rendering — it decides which buttons to show, never what is permitted. The
 * server re-checks the role on every mutating route, because anything the
 * browser holds is editable by whoever holds it.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DemoUser | null>(readStoredUser);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: DemoUser }>("/auth/login", {
      email,
      password,
    });
    localStorage.setItem(AUTH_TOKEN_KEY, res.token);
    localStorage.setItem(DEMO_USER_KEY, JSON.stringify(res.user));
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
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
