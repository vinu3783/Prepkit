"use client";

import { useState, type FormEvent } from "react";
import { newId } from "@/lib/api";
import type { Kit, KitOp } from "@/lib/types";
import { EditableText } from "../EditableText";
import { Button, Card, EmptyState, Input, Textarea } from "../ui";
import { ProvenanceBadges, RequirementChip } from "./shared";

export function FlashcardsTab({ kit, edit }: { kit: Kit; edit: (...ops: KitOp[]) => void }) {
  const reqById = new Map(kit.role.requirements.map((r) => [r.id, r]));
  const cards = kit.flashcards;
  return (
    <div className="flex flex-col gap-4">
      <AddFlashcard onAdd={(front, back) => edit({ type: "addFlashcard", flashcard: { id: newId("f"), front, back, requirement_ids: [] } })} />
      {cards.length === 0 ? (
        <EmptyState title="No flashcards">Add one above, then practise in the Practice tab.</EmptyState>
      ) : (
        <ol className="grid gap-3 md:grid-cols-2">
          {cards.map((c, i) => {
            const pinned = c.state?.pinned ?? false;
            return (
              <li key={c.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <p className="px-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Front</p>
                <EditableText label={`front of card ${c.id}`} value={c.front} required onCommit={(v) => edit({ type: "updateFlashcard", id: c.id, patch: { front: v } })} textClassName="text-sm font-medium" />
                <p className="mt-2 px-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Back</p>
                <EditableText label={`back of card ${c.id}`} value={c.back} onCommit={(v) => edit({ type: "updateFlashcard", id: c.id, patch: { back: v } })} textClassName="text-sm text-slate-700" />
                <div className="mt-2 flex flex-wrap items-center gap-1 px-1.5">
                  <ProvenanceBadges state={c.state} />
                  {c.requirement_ids.map((id) => (
                    <RequirementChip key={id} requirement={reqById.get(id)} />
                  ))}
                </div>
                <div className="mt-auto flex flex-wrap justify-end gap-1 pt-2">
                  <Button size="sm" variant="ghost" aria-label="Move earlier" disabled={i === 0} onClick={() => edit({ type: "moveFlashcard", id: c.id, index: i - 1 })}>
                    ↑
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Move later" disabled={i === cards.length - 1} onClick={() => edit({ type: "moveFlashcard", id: c.id, index: i + 1 })}>
                    ↓
                  </Button>
                  <Button size="sm" variant="ghost" aria-pressed={pinned} onClick={() => edit({ type: "pinFlashcard", id: c.id, pinned: !pinned })}>
                    {pinned ? "Unpin" : "Pin"}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => edit({ type: "deleteFlashcard", id: c.id })}>
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function AddFlashcard({ onAdd }: { onAdd: (front: string, back: string) => void }) {
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!front.trim()) return;
    onAdd(front.trim(), back.trim());
    setFront("");
    setBack("");
  }
  return (
    <Card>
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-slate-600">New card: front</span>
          <Input value={front} onChange={(e) => setFront(e.target.value)} placeholder="e.g. Explain idempotency keys" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-slate-600">Back</span>
          <Textarea rows={1} value={back} onChange={(e) => setBack(e.target.value)} />
        </label>
        <Button type="submit" variant="primary" disabled={!front.trim()}>
          Add card
        </Button>
      </form>
    </Card>
  );
}
