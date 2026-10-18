"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import { Button } from "./ui";

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only z-50 rounded bg-white px-3 py-2 focus:not-sr-only focus:absolute focus:left-2 focus:top-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold text-slate-900">
            <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-sm text-white">
              P
            </span>
            PrepKit
          </Link>
          {user && (
            <div className="flex items-center gap-2 text-sm">
              <span className="hidden max-w-[16rem] truncate text-slate-500 sm:inline">{user.email}</span>
              <Button variant="ghost" size="sm" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          )}
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
