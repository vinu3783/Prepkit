import type { ItemState, Kit, KitOp, Question } from "./types";

/**
 * Optimistic, client-side replay of builder ops so edits show instantly.
 * The server (server/src/domain/kitOps.ts) is authoritative: it re-applies the
 * same ops to the latest stored kit and its response replaces this projection.
 * Unknown ids are ignored here rather than thrown, so a stale op never breaks
 * rendering; the server reports it.
 */
const GENERATED: ItemState = { origin: "generated", edited: false, pinned: false };
const st = (x: { state?: ItemState }) => x.state ?? GENERATED;

export function applyOps(kit: Kit, ops: KitOp[]): Kit {
  if (ops.length === 0) return kit;
  const next: Kit = structuredClone(kit);
  for (const op of ops) applyOne(next, op);
  const ids = new Set(next.questions.map((q) => q.id));
  next.schedule.days = next.schedule.days.map((d) => ({ ...d, question_ids: d.question_ids.filter((id) => ids.has(id)) }));
  const covered = new Set(next.questions.flatMap((q) => q.requirement_ids));
  next.coverage = { ...next.coverage, uncovered_requirement_ids: next.role.requirements.filter((r) => !covered.has(r.id)).map((r) => r.id) };
  return next;
}

function applyOne(kit: Kit, op: KitOp): void {
  switch (op.type) {
    case "updateQuestion": {
      const q = kit.questions.find((x) => x.id === op.id);
      if (q) Object.assign(q, op.patch, { state: { ...st(q), edited: true } });
      return;
    }
    case "moveQuestion": {
      const i = kit.questions.findIndex((x) => x.id === op.id);
      if (i === -1) return;
      const [q] = kit.questions.splice(i, 1) as [Question];
      if (q.category !== op.category) {
        q.category = op.category;
        q.state = { ...st(q), edited: true };
      }
      insertIntoCategory(kit.questions, q, op.index);
      return;
    }
    case "addQuestion":
      insertIntoCategory(kit.questions, { ...op.question, state: { origin: "user", edited: false, pinned: false } }, Number.MAX_SAFE_INTEGER);
      return;
    case "deleteQuestion":
      kit.questions = kit.questions.filter((q) => q.id !== op.id);
      return;
    case "pinQuestion": {
      const q = kit.questions.find((x) => x.id === op.id);
      if (q) q.state = { ...st(q), pinned: op.pinned };
      return;
    }
    case "updateFlashcard": {
      const f = kit.flashcards.find((x) => x.id === op.id);
      if (f) Object.assign(f, op.patch, { state: { ...st(f), edited: true } });
      return;
    }
    case "addFlashcard":
      kit.flashcards.push({ ...op.flashcard, state: { origin: "user", edited: false, pinned: false } });
      return;
    case "deleteFlashcard":
      kit.flashcards = kit.flashcards.filter((f) => f.id !== op.id);
      return;
    case "pinFlashcard": {
      const f = kit.flashcards.find((x) => x.id === op.id);
      if (f) f.state = { ...st(f), pinned: op.pinned };
      return;
    }
    case "moveFlashcard": {
      const i = kit.flashcards.findIndex((x) => x.id === op.id);
      if (i === -1) return;
      const [f] = kit.flashcards.splice(i, 1);
      kit.flashcards.splice(Math.min(op.index, kit.flashcards.length), 0, f!);
      return;
    }
    case "updateBrief":
      Object.assign(kit.company_brief, op.patch);
      kit.company_brief.state = { pinned: kit.company_brief.state?.pinned ?? false, edited: true };
      return;
    case "pinBrief":
      kit.company_brief.state = { edited: kit.company_brief.state?.edited ?? false, pinned: op.pinned };
      return;
  }
}

function insertIntoCategory(questions: Question[], q: Question, index: number) {
  const positions = questions.map((x, i) => (x.category === q.category ? i : -1)).filter((i) => i !== -1);
  const at = positions.length === 0 ? questions.length : index >= positions.length ? positions[positions.length - 1]! + 1 : positions[index]!;
  questions.splice(at, 0, q);
}

export function isReplaceable(item: { state?: ItemState }): boolean {
  const s = st(item);
  return s.origin === "generated" && !s.edited && !s.pinned;
}
