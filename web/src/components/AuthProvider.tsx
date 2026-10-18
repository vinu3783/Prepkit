"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, SESSION_EVENT } from "@/lib/api";
import { Spinner } from "./ui";

interface User {
  id: string;
  email: string;
}
interface AuthState {
  user: User | null;
  loading: boolean;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Any 401 from anywhere: drop the user and go to sign-in, remembering where they were.
  useEffect(() => {
    const onLost = (e: Event) => {
      setUser(null);
      const reason = (e as CustomEvent<string>).detail === "SESSION_EXPIRED" ? "expired" : "signin";
      if (!pathname.startsWith("/login") && !pathname.startsWith("/register")) {
        router.replace(`/login?reason=${reason}&next=${encodeURIComponent(pathname)}`);
      }
    };
    window.addEventListener(SESSION_EVENT, onLost);
    return () => window.removeEventListener(SESSION_EVENT, onLost);
  }, [pathname, router]);

  const logout = useCallback(async () => {
    await api("/auth/logout", { body: {} }).catch(() => {});
    setUser(null);
    router.replace("/login");
  }, [router]);

  return <AuthContext.Provider value={{ user, loading, setUser, logout }}>{children}</AuthContext.Provider>;
}

/** Gate for signed-in pages; redirects to /login with a return path. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, user, router, pathname]);
  if (loading || !user) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-slate-500">
        <Spinner label="Checking your session" />
      </div>
    );
  }
  return <>{children}</>;
}
