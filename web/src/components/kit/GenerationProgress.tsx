"use client";

import { useEffect, useState } from "react";
import type { KitRecord, ProgressEvent } from "@/lib/types";
import { Alert, Card, Spinner } from "../ui";

const STEPS: { key: string; label: string }[] = [
  { key: "extract", label: "Read the job description" },
  { key: "crawl", label: "Crawl the company site" },
  { key: "discussion", label: "Search public interview discussion" },
  { key: "brief", label: "Write the company brief" },
  { key: "process", label: "Work out the interview process" },
  { key: "questions", label: "Generate questions, one call per category" },
  { key: "coverage", label: "Check every requirement is covered" },
  { key: "flashcards", label: "Write flashcards" },
  { key: "schedule", label: "Plan the study schedule" },
  { key: "validate", label: "Validate the kit" },
];

const ICON: Record<ProgressEvent["status"] | "pending", { symbol: string; className: string; sr: string }> = {
  pending: { symbol: "○", className: "text-slate-300", sr: "Not started" },
  running: { symbol: "", className: "text-brand-600", sr: "In progress" },
  done: { symbol: "✓", className: "text-emerald-600", sr: "Done" },
  skipped: { symbol: "–", className: "text-slate-400", sr: "Skipped" },
  warning: { symbol: "!", className: "text-amber-600", sr: "Done with a warning" },
  failed: { symbol: "✕", className: "text-red-600", sr: "Failed" },
};

export function GenerationProgress({ record, duplicate }: { record: KitRecord; duplicate: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const started = record.progress[0] ? Date.parse(record.progress[0].at) : Date.parse(record.createdAt);
  const elapsed = Math.max(0, Math.round((now - started) / 1000));
  const latest = (key: string) => [...record.progress].reverse().find((e) => e.step === key);
  const subSteps = (key: string) => {
    const seen = new Map<string, ProgressEvent>();
    for (const e of record.progress) if (e.step.startsWith(`${key}:`)) seen.set(e.step, e);
    return [...seen.values()];
  };

  return (
    <div className="mx-auto max-w-2xl">
      {duplicate && (
        <div className="mb-4">
          <Alert tone="info">You already submitted this posting, so we opened the existing kit instead of starting a second one.</Alert>
        </div>
      )}
      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">{record.status === "queued" ? "Waiting for a free slot…" : "Researching and building your kit"}</h1>
            <p className="text-sm text-slate-500">
              {elapsed}s elapsed. You can leave this page; the work continues and the kit will be in your list.
            </p>
          </div>
          <Spinner className="h-6 w-6 text-brand-600" label="Generating" />
        </div>
        <ol className="flex flex-col gap-3" aria-live="polite">
          {STEPS.map((step) => {
            const subs = subSteps(step.key);
            const event = latest(step.key) ?? (subs.length ? subs[subs.length - 1] : undefined);
            const status = step.key === "questions" && subs.length ? aggregate(subs) : (event?.status ?? "pending");
            const icon = ICON[status];
            return (
              <li key={step.key} className="flex gap-3">
                <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center text-sm font-bold ${icon.className}`}>
                  {status === "running" ? <Spinner className="h-4 w-4" /> : <span aria-hidden="true">{icon.symbol}</span>}
                  <span className="sr-only">{icon.sr}</span>
                </span>
                <div className="min-w-0">
                  <p className={status === "pending" ? "text-slate-400" : "font-medium"}>{step.label}</p>
                  {step.key !== "questions" && event && <p className={`text-sm ${status === "warning" ? "text-amber-700" : status === "failed" ? "text-red-700" : "text-slate-500"}`}>{event.message}</p>}
                  {subs.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5 text-sm text-slate-500">
                      {subs.map((s) => (
                        <li key={s.step} className={s.status === "failed" ? "text-red-700" : ""}>
                          {ICON[s.status].symbol || "…"} {s.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}

function aggregate(events: ProgressEvent[]): ProgressEvent["status"] {
  if (events.some((e) => e.status === "running")) return "running";
  if (events.some((e) => e.status === "failed")) return "warning";
  return "done";
}
