"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "./AuthProvider";
import { Alert, Button, Card, Field, Input } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const { user, setUser } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [params, setParams] = useState<{ next: string; reason: string | null }>({ next: "/", reason: null });

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const next = q.get("next");
    // Only same-site relative paths: never redirect to an attacker-supplied URL.
    setParams({ next: next && next.startsWith("/") && !next.startsWith("//") ? next : "/", reason: q.get("reason") });
  }, []);

  useEffect(() => {
    if (user) router.replace(params.next);
  }, [user, router, params.next]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await api<{ user: { id: string; email: string } }>(`/auth/${mode}`, { body: { email, password } });
      setUser(r.user);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setSubmitting(false);
    }
  }

  const fields = error?.fieldErrors() ?? {};
  const isLogin = mode === "login";
  return (
    <div className="mx-auto mt-6 max-w-sm sm:mt-12">
      <h1 className="mb-1 text-2xl font-semibold">{isLogin ? "Sign in" : "Create your account"}</h1>
      <p className="mb-6 text-sm text-slate-600">Turn a job description into an interview prep kit.</p>
      {params.reason === "expired" && (
        <div className="mb-4">
          <Alert tone="warning">Your session expired. Sign in again to pick up where you left off.</Alert>
        </div>
      )}
      <Card>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {error && !error.details && <Alert tone="error">{error.message}</Alert>}
          <Field label="Email" error={fields.email}>
            {(p) => <Input {...p} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="Password" error={fields.password} hint={isLogin ? undefined : "At least 8 characters."}>
            {(p) => (
              <Input {...p} type="password" autoComplete={isLogin ? "current-password" : "new-password"} required minLength={isLogin ? 1 : 8} value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </Field>
          <Button type="submit" variant="primary" loading={submitting}>
            {isLogin ? "Sign in" : "Create account"}
          </Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-slate-600">
        {isLogin ? "New here? " : "Already have an account? "}
        <Link className="font-medium text-brand-700 underline-offset-2 hover:underline" href={isLogin ? "/register" : "/login"}>
          {isLogin ? "Create an account" : "Sign in"}
        </Link>
      </p>
    </div>
  );
}
