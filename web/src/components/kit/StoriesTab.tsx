"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, newId } from "@/lib/api";
import type { Kit, KitRecord, Story } from "@/lib/types";
import { Alert, Badge, Button, Card, EmptyState, Input, Textarea } from "../ui";
import { PriorityBadge } from "./shared";

/**
 * Story Bank (the creative feature).
 *
 * Behavioural rounds are where prepared candidates freeze: not for lack of skill,
 * but because no story is ready. Five or six well-rehearsed stories usually cover
 * every behavioural question if you know which story answers which question. Here
 * the candidate writes each story once (STAR), tags the requirements it proves, and
 * the kit shows, with no model involved:
 *   - which requirements still have no story (the real gap before the interview)
 *   - for each behavioural / company-fit question, which of their stories to tell
 */
export function StoriesTab({ kit, record, onRecord }: { kit: Kit; record: KitRecord; onRecord: (r: KitRecord) => void }) {
  const [stories, setStories] = useState<Story[]>(record.stories);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!dirty.current) setStories(record.stories);
  }, [record.stories]);

  const save = (next: Story[]) => {
    setStories(next);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setStatus("saving");
      try {
        const r = await api<KitRecord>(`/kits/${record.id}/stories`, { method: "PUT", body: { stories: next.filter((s) => s.title.trim()) } });
        dirty.current = false;
        onRecord(r);
        setStatus("saved");
        setError(null);
      } catch (err) {
        setStatus("error");
        setError((err as ApiError).message);
      }
    }, 800);
  };

  const update = (id: string, patch: Partial<Story>) => save(stories.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const behaviouralFirst = [...kit.role.requirements].sort((a, b) => Number(b.kind === "behavioural") - Number(a.kind === "behavioural"));
  const storiesFor = (reqId: string) => stories.filter((s) => s.requirement_ids.includes(reqId));
  const storyQuestions = kit.questions.filter((q) => q.category === "behavioural" || q.category === "company-fit");
  const gaps = kit.role.requirements.filter((r) => r.kind !== "technical" && storiesFor(r.id).length === 0);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold">Your story bank</h2>
              <p className="text-sm text-slate-600">Write each story once. Tag what it proves. Reuse it across questions.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500" aria-live="polite">
                {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
              </span>
              <Button variant="primary" size="sm" onClick={() => save([...stories, { id: newId("s"), title: "New story", situation: "", action: "", result: "", requirement_ids: [] }])}>
                + Add story
              </Button>
            </div>
          </div>
          {error && (
            <div className="mt-3">
              <Alert tone="error">{error}</Alert>
            </div>
          )}
        </Card>
        {stories.length === 0 && <EmptyState title="No stories yet">Start with the project you are proudest of, then a conflict, a failure, and a time you led without authority.</EmptyState>}
        {stories.map((s) => (
          <Card key={s.id}>
            <div className="flex items-start gap-2">
              <label className="sr-only" htmlFor={`title-${s.id}`}>
                Story title
              </label>
              <Input id={`title-${s.id}`} value={s.title} onChange={(e) => update(s.id, { title: e.target.value })} className="font-medium" />
              <Button size="sm" variant="danger" onClick={() => save(stories.filter((x) => x.id !== s.id))}>
                Delete
              </Button>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {(["situation", "action", "result"] as const).map((field) => (
                <label key={field} className="flex flex-col gap-1 text-sm">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{field === "situation" ? "Situation & task" : field}</span>
                  <Textarea rows={4} value={s[field]} onChange={(e) => update(s.id, { [field]: e.target.value })} />
                </label>
              ))}
            </div>
            {kit.role.requirements.length > 0 && (
              <fieldset className="mt-3">
                <legend className="mb-1 text-xs text-slate-500">This story shows…</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {behaviouralFirst.map((r) => (
                    <label key={r.id} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={s.requirement_ids.includes(r.id)}
                        onChange={(e) => update(s.id, { requirement_ids: e.target.checked ? [...s.requirement_ids, r.id] : s.requirement_ids.filter((x) => x !== r.id) })}
                      />
                      {r.text.length > 34 ? `${r.text.slice(0, 33)}…` : r.text}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </Card>
        ))}
      </div>

      <aside className="flex flex-col gap-4">
        <Card>
          <h2 className="font-semibold">Gaps</h2>
          {kit.role.requirements.filter((r) => r.kind !== "technical").length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">The posting lists no behavioural or domain requirements. Stories still help with “tell me about yourself”.</p>
          ) : gaps.length ? (
            <ul className="mt-2 flex flex-col gap-1.5 text-sm">
              {gaps.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <PriorityBadge priority={r.priority} />
                  <span>{r.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-emerald-700">Every behavioural and domain requirement has at least one story.</p>
          )}
        </Card>
        <Card>
          <h2 className="font-semibold">Which story for which question</h2>
          <ul className="mt-2 flex flex-col gap-3 text-sm">
            {storyQuestions.map((q) => {
              const matches = stories.filter((s) => s.requirement_ids.some((id) => q.requirement_ids.includes(id)));
              return (
                <li key={q.id}>
                  <p className="text-slate-700">{q.prompt}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {matches.length ? matches.map((m) => <Badge key={m.id} tone="green">{m.title}</Badge>) : <Badge tone="amber">No story yet</Badge>}
                  </div>
                </li>
              );
            })}
            {storyQuestions.length === 0 && <li className="text-slate-500">No behavioural or company-fit questions in this kit.</li>}
          </ul>
        </Card>
      </aside>
    </div>
  );
}
