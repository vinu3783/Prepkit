"use client";

import { useState, type DragEvent, type FormEvent } from "react";
import { newId } from "@/lib/api";
import { isReplaceable } from "@/lib/applyOps";
import { CATEGORIES, CATEGORY_LABEL, type Kit, type KitOp, type KitRecord, type Question, type QuestionCategory, type Requirement } from "@/lib/types";
import { EditableText } from "../EditableText";
import { Badge, Button, Card, Textarea } from "../ui";
import { PriorityBadge, ProvenanceBadges, RegenerateButton, RequirementChip } from "./shared";

const DIFFICULTY = ["", "Warm-up", "Standard", "Hard"];

export function QuestionsTab({ kit, record, edit, reload }: { kit: Kit; record: KitRecord; edit: (...ops: KitOp[]) => void; reload: () => void }) {
  const reqById = new Map(kit.role.requirements.map((r) => [r.id, r]));
  const [dragId, setDragId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <CoverageStrip kit={kit} />
      {CATEGORIES.map((category) => {
        const questions = kit.questions.filter((q) => q.category === category);
        const section = `category:${category}`;
        const regenerating = record.regenerating.some((r) => r.section === section);
        const replaceable = questions.filter(isReplaceable).length;
        return (
          <Card key={category}>
            <div
              className="flex flex-wrap items-center justify-between gap-2"
              onDragOver={(e) => dragId && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) edit({ type: "moveQuestion", id: dragId, category, index: questions.length });
                setDragId(null);
              }}
            >
              <div>
                <h2 className="font-semibold">
                  {CATEGORY_LABEL[category]} <span className="font-normal text-slate-400">({questions.length})</span>
                </h2>
                <p className="text-xs text-slate-500">
                  {regenerating
                    ? "Regenerating. You can keep editing: anything you touch now is kept."
                    : questions.length
                      ? `${replaceable} of ${questions.length} would be replaced by regenerating; edited, pinned and your own stay.`
                      : "No questions in this category."}
                </p>
              </div>
              <RegenerateButton record={record} section={section} body={{ section: "category", category }} onStarted={reload} label={questions.length ? "Regenerate" : "Generate"} />
            </div>
            {questions.length > 0 && (
              <ol className="mt-3 flex flex-col gap-2">
                {questions.map((q, index) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    index={index}
                    count={questions.length}
                    reqById={reqById}
                    requirements={kit.role.requirements}
                    edit={edit}
                    dragging={dragId === q.id}
                    onDragStart={() => setDragId(q.id)}
                    onDragEnd={() => setDragId(null)}
                    onDropHere={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragId && dragId !== q.id) edit({ type: "moveQuestion", id: dragId, category, index });
                      setDragId(null);
                    }}
                    canDrop={!!dragId && dragId !== q.id}
                  />
                ))}
              </ol>
            )}
            <AddQuestion category={category} requirements={kit.role.requirements} onAdd={(q) => edit({ type: "addQuestion", question: q })} />
          </Card>
        );
      })}
    </div>
  );
}

function CoverageStrip({ kit }: { kit: Kit }) {
  const uncovered = new Set(kit.coverage.uncovered_requirement_ids);
  if (kit.role.requirements.length === 0) return null;
  const mustUncovered = kit.role.requirements.filter((r) => r.priority === "must" && uncovered.has(r.id));
  return (
    <Card className={mustUncovered.length ? "border-red-200" : ""}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Coverage</h2>
        <p className={`text-sm ${mustUncovered.length ? "font-medium text-red-700" : "text-emerald-700"}`}>
          {mustUncovered.length ? `${mustUncovered.length} must-have requirement(s) have no question` : "Every must-have requirement has at least one question"}
        </p>
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {kit.role.requirements.map((r) => {
          const n = kit.questions.filter((q) => q.requirement_ids.includes(r.id)).length;
          return (
            <li key={r.id} className={`rounded-md border px-2 py-1 text-xs ${n === 0 ? (r.priority === "must" ? "border-red-300 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900") : "border-slate-200 bg-white"}`}>
              <span className="font-medium">{r.id}</span> {r.text.length > 36 ? `${r.text.slice(0, 35)}…` : r.text} <span className="text-slate-500">· {n}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function QuestionCard({
  question: q,
  index,
  count,
  reqById,
  requirements,
  edit,
  dragging,
  onDragStart,
  onDragEnd,
  onDropHere,
  canDrop,
}: {
  question: Question;
  index: number;
  count: number;
  reqById: Map<string, Requirement>;
  requirements: Requirement[];
  edit: (...ops: KitOp[]) => void;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropHere: (e: DragEvent) => void;
  canDrop: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [over, setOver] = useState(false);
  const pinned = q.state?.pinned ?? false;

  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        onDropHere(e);
      }}
      className={`rounded-lg border bg-white transition ${dragging ? "opacity-40" : ""} ${over ? "border-brand-500 ring-2 ring-brand-100" : "border-slate-200"}`}
    >
      <div className="flex items-start gap-2 p-2.5">
        <span aria-hidden="true" className="mt-1.5 hidden cursor-grab select-none text-slate-300 sm:block" title="Drag to reorder">
          ⋮⋮
        </span>
        <div className="min-w-0 flex-1">
          <EditableText label={`question ${q.id}`} value={q.prompt} required onCommit={(v) => edit({ type: "updateQuestion", id: q.id, patch: { prompt: v } })} textClassName="text-sm font-medium" />
          <div className="mt-1 flex flex-wrap items-center gap-1 px-1.5">
            <Badge tone={q.difficulty === 3 ? "red" : q.difficulty === 1 ? "green" : "slate"}>{DIFFICULTY[q.difficulty]}</Badge>
            <ProvenanceBadges state={q.state} />
            {q.requirement_ids.map((id) => (
              <RequirementChip key={id} requirement={reqById.get(id)} />
            ))}
            {q.requirement_ids.length === 0 && <span className="text-[11px] text-slate-400">No linked requirement</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
          <div className="flex">
            <Button size="sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => edit({ type: "moveQuestion", id: q.id, category: q.category, index: index - 1 })}>
              ↑
            </Button>
            <Button size="sm" variant="ghost" aria-label="Move down" disabled={index === count - 1} onClick={() => edit({ type: "moveQuestion", id: q.id, category: q.category, index: index + 1 })}>
              ↓
            </Button>
          </div>
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Less" : "More"}
          </Button>
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-t border-slate-100 p-3">
          <div>
            <p className="px-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Answer outline</p>
            <EditableText label={`answer outline for ${q.id}`} value={q.answer_outline} onCommit={(v) => edit({ type: "updateQuestion", id: q.id, patch: { answer_outline: v } })} textClassName="text-sm text-slate-700" />
          </div>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Difficulty</span>
              <select className="rounded-md border border-slate-300 px-2 py-1" value={q.difficulty} onChange={(e) => edit({ type: "updateQuestion", id: q.id, patch: { difficulty: Number(e.target.value) } })}>
                <option value={1}>Warm-up</option>
                <option value={2}>Standard</option>
                <option value={3}>Hard</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Category</span>
              <select className="rounded-md border border-slate-300 px-2 py-1" value={q.category} onChange={(e) => edit({ type: "moveQuestion", id: q.id, category: e.target.value as QuestionCategory, index: Number.MAX_SAFE_INTEGER })}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" aria-pressed={pinned} onClick={() => edit({ type: "pinQuestion", id: q.id, pinned: !pinned })}>
              {pinned ? "Unpin" : "Pin"}
            </Button>
            {confirmDelete ? (
              <span className="flex items-center gap-1">
                <Button size="sm" variant="danger" onClick={() => edit({ type: "deleteQuestion", id: q.id })}>
                  Confirm delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </div>
          {requirements.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-xs text-slate-500">Requirements this question tests</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {requirements.map((r) => (
                  <label key={r.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={q.requirement_ids.includes(r.id)}
                      onChange={(e) =>
                        edit({
                          type: "updateQuestion",
                          id: q.id,
                          patch: { requirement_ids: e.target.checked ? [...q.requirement_ids, r.id] : q.requirement_ids.filter((x) => x !== r.id) },
                        })
                      }
                    />
                    <span>
                      {r.id} {r.text.length > 30 ? `${r.text.slice(0, 29)}…` : r.text}
                    </span>
                    <PriorityBadge priority={r.priority} />
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}
    </li>
  );
}

function AddQuestion({ category, requirements, onAdd }: { category: QuestionCategory; requirements: Requirement[]; onAdd: (q: Omit<Question, "state">) => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [reqId, setReqId] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    onAdd({ id: newId("u"), category, prompt: prompt.trim(), answer_outline: "", difficulty: 2, requirement_ids: reqId ? [reqId] : [] });
    setPrompt("");
    setReqId("");
    setOpen(false);
  }

  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setOpen(true)}>
        + Add a {CATEGORY_LABEL[category].toLowerCase()} question
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2 rounded-lg bg-slate-50 p-3">
      <label className="text-xs font-medium text-slate-600" htmlFor={`add-${category}`}>
        Your question
      </label>
      <Textarea id={`add-${category}`} autoFocus rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select aria-label="Linked requirement" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={reqId} onChange={(e) => setReqId(e.target.value)}>
          <option value="">No linked requirement</option>
          {requirements.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id}: {r.text}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!prompt.trim()}>
            Add question
          </Button>
        </div>
      </div>
    </form>
  );
}
