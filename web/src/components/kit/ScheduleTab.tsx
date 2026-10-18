"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { CATEGORY_LABEL, type Kit, type KitRecord } from "@/lib/types";
import { Alert, Badge, Button, Card, Input } from "../ui";

export function ScheduleTab({ kit, record, onRecord }: { kit: Kit; record: KitRecord; onRecord: (r: KitRecord) => void }) {
  const [days, setDays] = useState(String(kit.schedule.days_available));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qById = new Map(kit.questions.map((q) => [q.id, q]));
  const total = kit.schedule.days.reduce((a, d) => a + d.minutes, 0);
  const interview = new Date(record.interviewAt);

  async function replan() {
    setBusy(true);
    setError(null);
    try {
      onRecord(await api<KitRecord>(`/kits/${record.id}/regenerate`, { body: { section: "schedule", days: Number(days) } }));
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">
              {kit.schedule.days_available}-day plan · {Math.floor(total / 60)}h {total % 60}m total
            </h2>
            <p className="text-sm text-slate-500">
              Interview around {interview.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}. Must-have and harder material comes first; the
              last days are review, not new material.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-slate-500">Days available</span>
              <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="w-24" />
            </label>
            <Button onClick={() => void replan()} loading={busy}>
              Re-plan schedule
            </Button>
          </div>
        </div>
        {error && (
          <div className="mt-3">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
      </Card>
      {record.unscheduled.length > 0 && (
        <Alert tone="warning" title={`${record.unscheduled.length} question(s) aren't in the schedule yet`} action={<Button size="sm" onClick={() => void replan()} loading={busy}>Re-plan now</Button>}>
          You added or regenerated questions since this plan was made. Re-planning keeps the same number of days.
        </Alert>
      )}
      <ol className="grid gap-3 md:grid-cols-2">
        {kit.schedule.days.map((d) => {
          const review = /review/i.test(d.focus);
          return (
            <li key={d.day}>
              <Card className="h-full">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-semibold">Day {d.day}</h3>
                  <span className="flex items-center gap-1.5 text-sm tabular-nums text-slate-500">
                    {review && <Badge tone="green">Review</Badge>}
                    {d.minutes} min
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-700">{d.focus}</p>
                {d.question_ids.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {d.question_ids.map((id) => {
                      const q = qById.get(id);
                      if (!q) return null;
                      return (
                        <li key={id} className="flex gap-2">
                          <Badge>{CATEGORY_LABEL[q.category]}</Badge>
                          <span className="line-clamp-2 text-slate-600">{q.prompt}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
