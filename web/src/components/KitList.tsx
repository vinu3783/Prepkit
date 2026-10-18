"use client";

import Link from "next/link";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { KitSummary } from "@/lib/types";
import { Alert, Badge, Button, EmptyState, Spinner } from "./ui";

export interface KitListHandle {
  refresh: () => void;
}

const STATUS: Record<KitSummary["status"], { label: string; tone: "slate" | "blue" | "green" | "red" }> = {
  queued: { label: "Queued", tone: "slate" },
  running: { label: "Generating", tone: "blue" },
  ready: { label: "Ready", tone: "green" },
  failed: { label: "Failed", tone: "red" },
};

export const KitList = forwardRef<KitListHandle>(function KitList(_props, ref) {
  const [kits, setKits] = useState<KitSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ kits: KitSummary[] }>("/kits");
      setKits(r.kits);
      setError(null);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, []);

  useImperativeHandle(ref, () => ({ refresh: () => void load() }), [load]);
  useEffect(() => {
    void load();
  }, [load]);

  const generating = kits?.some((k) => k.status === "queued" || k.status === "running");
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [generating, load]);

  if (error && !kits) {
    return (
      <Alert tone="error" title="Couldn't load your kits" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
        {error}
      </Alert>
    );
  }
  if (!kits) {
    return (
      <div className="flex items-center gap-2 py-8 text-slate-500">
        <Spinner /> Loading your kits…
      </div>
    );
  }
  if (kits.length === 0) {
    return <EmptyState title="No kits yet">Paste a job description above to build your first one.</EmptyState>;
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {kits.map((k) => (
        <li key={k.id}>
          <Link href={`/kits/${k.id}`} className="block h-full rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-500 hover:shadow">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{k.title || "Untitled role"}</p>
                <p className="truncate text-sm text-slate-500">{k.company}</p>
              </div>
              <Badge tone={STATUS[k.status].tone}>
                {k.status === "running" && <Spinner className="mr-1 h-3 w-3" />}
                {STATUS[k.status].label}
              </Badge>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              {k.status === "failed"
                ? k.error?.message
                : k.status === "ready"
                  ? `${k.requirements ?? 0} requirements · ${k.days}-day plan`
                  : (k.lastProgress?.message ?? "Waiting to start…")}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
});
