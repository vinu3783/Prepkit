"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Kit, KitRecord, PracticeSummary } from "@/lib/types";
import { Alert, Button, Card, EmptyState } from "../ui";
import { PriorityBadge } from "./shared";

const CONFIDENCE = [
  { value: 1, label: "No idea", key: "1", className: "border-red-200 hover:bg-red-50" },
  { value: 2, label: "Shaky", key: "2", className: "border-amber-200 hover:bg-amber-50" },
  { value: 3, label: "Got it", key: "3", className: "border-emerald-200 hover:bg-emerald-50" },
  { value: 4, label: "Easy", key: "4", className: "border-brand-100 hover:bg-brand-50" },
] as const;

export function PracticeTab({ kit, record, reload }: { kit: Kit; record: KitRecord; reload: () => void }) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [position, setPosition] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<PracticeSummary | null>(record.practiceSummary);
  const [sessionCount, setSessionCount] = useState(0);

  useEffect(() => setSummary(record.practiceSummary), [record.practiceSummary]);

  const cards = new Map(kit.flashcards.map((c) => [c.id, c]));
  const current = order ? cards.get(order[position] ?? "") : undefined;
  const finished = order !== null && position >= order.length;

  async function start() {
    setError(null);
    try {
      const r = await api<{ order: string[] }>(`/kits/${record.id}/practice/session`);
      setOrder(r.order);
      setPosition(0);
      setRevealed(false);
      setSessionCount(0);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  const rate = useCallback(
    async (confidence: number) => {
      if (!current || saving) return;
      setSaving(true);
      setError(null);
      try {
        const r = await api<{ summary: PracticeSummary }>(`/kits/${record.id}/practice`, { body: { cardId: current.id, confidence } });
        setSummary(r.summary);
        setPosition((p) => p + 1);
        setRevealed(false);
        setSessionCount((n) => n + 1);
      } catch (err) {
        setError((err as ApiError).message);
      } finally {
        setSaving(false);
      }
    },
    [current, record.id, saving],
  );

  // Keyboard: Space/Enter reveals, 1-4 rates, Escape ends the session.
  useEffect(() => {
    if (!order || finished) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select")) return;
      if ((e.key === " " || e.key === "Enter") && !revealed && !target.closest("button")) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
        void rate(Number(e.key));
      } else if (e.key === "Escape") {
        setOrder(null);
        reload();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, finished, revealed, rate, reload]);

  // A card deleted mid-session is skipped.
  useEffect(() => {
    if (order && !finished && !current) setPosition((p) => p + 1);
  }, [order, finished, current]);

  if (kit.flashcards.length === 0) return <EmptyState title="No flashcards to practise">Add some in the Flashcards tab.</EmptyState>;

  const reqById = new Map(kit.role.requirements.map((r) => [r.id, r]));
  const s = summary;

  if (!order || finished) {
    return (
      <div className="grid gap-5 md:grid-cols-[1fr_1fr]">
        <Card>
          <h2 className="font-semibold">{finished ? `Session done: ${sessionCount} card(s) reviewed` : "Practice"}</h2>
          <p className="mt-1 text-sm text-slate-600">
            Cards you were least sure about come first; ones you know come back later, but always before your interview date.
          </p>
          {s && (
            <>
              <div className="mt-4">
                <div className="flex justify-between text-sm">
                  <span>Covered</span>
                  <span className="tabular-nums">
                    {s.covered} / {s.total}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={s.covered} aria-label="Cards covered">
                  <div className="h-full bg-brand-500" style={{ width: `${s.total ? (s.covered / s.total) * 100 : 0}%` }} />
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">
                {CONFIDENCE.map((c) => (
                  <div key={c.value} className={`rounded-md border p-2 ${c.className}`}>
                    <dt className="text-slate-500">{c.label}</dt>
                    <dd className="text-lg font-semibold tabular-nums">{s.byConfidence[String(c.value) as "1"]}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-sm text-slate-600">
                {s.dueNow} due now · {s.total - s.covered} not seen yet
              </p>
            </>
          )}
          {error && (
            <div className="mt-3">
              <Alert tone="error">{error}</Alert>
            </div>
          )}
          <Button variant="primary" className="mt-4" onClick={() => void start()}>
            {finished ? "Practise again" : s?.covered ? "Continue practising" : "Start practising"}
          </Button>
        </Card>
        <Card>
          <h2 className="font-semibold">Weak spots</h2>
          {s && s.weakRequirementIds.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5 text-sm">
              {s.weakRequirementIds.map((id) => {
                const r = reqById.get(id);
                return r ? (
                  <li key={id} className="flex items-center gap-2">
                    <PriorityBadge priority={r.priority} />
                    {r.text}
                  </li>
                ) : null;
              })}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-600">{s?.covered ? "Nothing below “got it”. Nice." : "Practise a few cards and your weak requirements will show here."}</p>
          )}
        </Card>
      </div>
    );
  }

  if (!current) return null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-3 flex items-center justify-between text-sm text-slate-500">
        <span>
          Card {position + 1} of {order.length}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOrder(null);
            reload();
          }}
        >
          End session (Esc)
        </Button>
      </div>
      <Card className="min-h-64">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Question</p>
        <p className="mt-1 whitespace-pre-wrap text-lg font-medium">{current.front}</p>
        {revealed ? (
          <div className="mt-5 border-t border-slate-100 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Answer</p>
            <p className="mt-1 whitespace-pre-wrap text-slate-700">{current.back || "No answer written; compare with your own notes."}</p>
          </div>
        ) : (
          <Button variant="primary" className="mt-6" autoFocus onClick={() => setRevealed(true)}>
            Reveal answer (Space)
          </Button>
        )}
      </Card>
      {revealed && (
        <div className="mt-4">
          <p id="confidence-label" className="mb-2 text-sm font-medium">
            How confident were you?
          </p>
          <div role="group" aria-labelledby="confidence-label" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CONFIDENCE.map((c, i) => (
              <button
                key={c.value}
                type="button"
                autoFocus={i === 2}
                disabled={saving}
                onClick={() => void rate(c.value)}
                className={`rounded-lg border bg-white px-3 py-2 text-sm font-medium disabled:opacity-50 ${c.className}`}
              >
                {c.label} <span className="text-xs text-slate-400">({c.key})</span>
              </button>
            ))}
          </div>
          {error && (
            <div className="mt-3">
              <Alert tone="error">{error}</Alert>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
