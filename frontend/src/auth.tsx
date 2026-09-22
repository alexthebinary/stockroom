import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  ACTING_ROLE_KEY,
  AUTH_TOKEN_KEY,
  DEMO_USER_KEY,
  SESSION_EXPIRED_EVENT,
} from "./api";

export type Capabilities = { stock: boolean; money: boolean; users: boolean };
export type DemoUser = {
  id: number;
  email: string;
  name: string;
  /** What this session may currently do. */
  role: string;
  can: Capabilities;
  /** What the account actually holds, when acting as a lesser role. */
  actualRole?: string;
  actualCan?: Capabilities;
  actingAs?: string;
};

type AuthValue = {
  user: DemoUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Administrators only: work as a lesser role, or null to stop. */
  actAs: (role: string | null) => Promise<void>;
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
  const queryClient = useQueryClient();

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: DemoUser }>("/auth/login", {
      email,
      password,
    });
    localStorage.setItem(AUTH_TOKEN_KEY, res.token);
    localStorage.setItem(DEMO_USER_KEY, JSON.stringify(res.user));
    setUser(res.user);
    // Anything that 401'd while signed out is cached as an error and will not
    // retry on its own, so the app renders signed-in with holes where that
    // data should be — the sidebar's counts came up blank until a manual
    // reload. Throw the cache away; none of it belongs to this session.
    queryClient.clear();
  }, [queryClient]);

  // The API layer clears storage the moment a token is rejected; this is what
  // turns that into a render, so the sign-in form actually appears instead of
  // a shell full of failed panels.
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      queryClient.clear();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [queryClient]);

  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(DEMO_USER_KEY);
    localStorage.removeItem(ACTING_ROLE_KEY);
    setUser(null);
    // And on the way out, so the next person to sign in on this machine never
    // sees a flash of the last one's data.
    queryClient.clear();
  }, [queryClient]);

  const actAs = useCallback(async (role: string | null) => {
    try {
      if (role) localStorage.setItem(ACTING_ROLE_KEY, role);
      else localStorage.removeItem(ACTING_ROLE_KEY);
    } catch {
      /* private browsing; the header simply will not be sent */
    }
    // Re-ask the server rather than assuming the switch worked. It decides
    // whether the role was allowed, and this is how we find out.
    const res = await api.get<{ user: DemoUser }>("/auth/me");
    localStorage.setItem(DEMO_USER_KEY, JSON.stringify(res.user));
    setUser(res.user);
  }, []);

  const value = useMemo(() => ({ user, login, logout, actAs }), [user, login, logout, actAs]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
