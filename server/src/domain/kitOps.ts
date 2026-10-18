import { z } from "zod";
import { checkCoverage } from "./coverage.js";
import { Flashcard, ItemState, QuestionCategory, type Kit, type Question } from "./schema.js";

/**
 * Builder edits as small, typed operations. The client applies them optimistically
 * and sends them in order; the server replays them on the latest stored kit. Because
 * each op names the item it touches (rather than sending the whole kit), an edit
 * never overwrites someone else's change, or a regeneration that landed meanwhile.
 *
 * Provenance rules (what a section regeneration may replace):
 *   origin "user"           — written by hand: never replaced
 *   edited true             — touched by hand (text, requirements, or moved category): never replaced
 *   pinned true             — explicitly kept: never replaced
 *   generated, unedited, unpinned — replaceable
 */

const ItemId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const Text = z.string().trim().min(1).max(4000);
const LongText = z.string().max(8000);
const Difficulty = z.number().int().min(1).max(3);

export const KitOp = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("updateQuestion"),
    id: ItemId,
    patch: z
      .object({ prompt: Text, answer_outline: LongText, difficulty: Difficulty, requirement_ids: z.array(ItemId).max(30) })
      .partial()
      .strict(),
  }),
  z.object({ type: z.literal("moveQuestion"), id: ItemId, category: QuestionCategory, index: z.number().int().min(0) }),
  z.object({
    type: z.literal("addQuestion"),
    question: z.object({
      id: ItemId,
      category: QuestionCategory,
      prompt: Text,
      answer_outline: LongText.default(""),
      difficulty: Difficulty.default(2),
      requirement_ids: z.array(ItemId).max(30).default([]),
    }),
  }),
  z.object({ type: z.literal("deleteQuestion"), id: ItemId }),
  z.object({ type: z.literal("pinQuestion"), id: ItemId, pinned: z.boolean() }),
  z.object({
    type: z.literal("updateFlashcard"),
    id: ItemId,
    patch: z.object({ front: Text, back: LongText, requirement_ids: z.array(ItemId).max(30) }).partial().strict(),
  }),
  z.object({
    type: z.literal("addFlashcard"),
    flashcard: z.object({ id: ItemId, front: Text, back: LongText.default(""), requirement_ids: z.array(ItemId).max(30).default([]) }),
  }),
  z.object({ type: z.literal("deleteFlashcard"), id: ItemId }),
  z.object({ type: z.literal("pinFlashcard"), id: ItemId, pinned: z.boolean() }),
  z.object({ type: z.literal("moveFlashcard"), id: ItemId, index: z.number().int().min(0) }),
  z.object({
    type: z.literal("updateBrief"),
    patch: z.object({ summary: LongText, what_they_do: LongText }).partial().strict(),
  }),
  z.object({ type: z.literal("pinBrief"), pinned: z.boolean() }),
]);
export type KitOp = z.infer<typeof KitOp>;

export class KitOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitOpError";
  }
}

const GENERATED: ItemState = { origin: "generated", edited: false, pinned: false };

export function stateOf(item: { state?: ItemState }): ItemState {
  return item.state ?? GENERATED;
}

/** May a regeneration replace this item? */
export function isReplaceable(item: { state?: ItemState }): boolean {
  const s = stateOf(item);
  return s.origin === "generated" && !s.edited && !s.pinned;
}

export function applyOps(kit: Kit, ops: KitOp[]): Kit {
  let next = structuredClone(kit);
  for (const op of ops) next = applyOp(next, op);
  return refreshDerived(next);
}

function applyOp(kit: Kit, op: KitOp): Kit {
  const requirementIds = new Set(kit.role.requirements.map((r) => r.id));
  const checkReqs = (ids: string[] | undefined) => {
    for (const id of ids ?? []) if (!requirementIds.has(id)) throw new KitOpError(`Unknown requirement ${id}`);
  };

  switch (op.type) {
    case "updateQuestion": {
      const q = findOrThrow(kit.questions, op.id, "question");
      checkReqs(op.patch.requirement_ids);
      Object.assign(q, op.patch);
      q.state = { ...stateOf(q), edited: true };
      return kit;
    }
    case "moveQuestion": {
      const index = kit.questions.findIndex((q) => q.id === op.id);
      if (index === -1) throw new KitOpError(`Unknown question ${op.id}`);
      const [q] = kit.questions.splice(index, 1) as [Question];
      if (q.category !== op.category) {
        // Moving to another category is a hand edit: it must survive regeneration of either category.
        q.category = op.category;
        q.state = { ...stateOf(q), edited: true };
      }
      insertIntoCategory(kit.questions, q, op.index);
      return kit;
    }
    case "addQuestion": {
      if (kit.questions.some((q) => q.id === op.question.id)) throw new KitOpError(`Question id ${op.question.id} already exists`);
      checkReqs(op.question.requirement_ids);
      const q: Question = { ...op.question, state: { origin: "user", edited: false, pinned: false } };
      insertIntoCategory(kit.questions, q, Number.MAX_SAFE_INTEGER);
      return kit;
    }
    case "deleteQuestion": {
      findOrThrow(kit.questions, op.id, "question");
      kit.questions = kit.questions.filter((q) => q.id !== op.id);
      return kit;
    }
    case "pinQuestion": {
      const q = findOrThrow(kit.questions, op.id, "question");
      q.state = { ...stateOf(q), pinned: op.pinned };
      return kit;
    }
    case "updateFlashcard": {
      const f = findOrThrow(kit.flashcards, op.id, "flashcard");
      checkReqs(op.patch.requirement_ids);
      Object.assign(f, op.patch);
      f.state = { ...stateOf(f), edited: true };
      return kit;
    }
    case "addFlashcard": {
      if (kit.flashcards.some((f) => f.id === op.flashcard.id)) throw new KitOpError(`Flashcard id ${op.flashcard.id} already exists`);
      checkReqs(op.flashcard.requirement_ids);
      const f: Flashcard = { ...op.flashcard, state: { origin: "user", edited: false, pinned: false } };
      kit.flashcards.push(f);
      return kit;
    }
    case "deleteFlashcard": {
      findOrThrow(kit.flashcards, op.id, "flashcard");
      kit.flashcards = kit.flashcards.filter((f) => f.id !== op.id);
      return kit;
    }
    case "pinFlashcard": {
      const f = findOrThrow(kit.flashcards, op.id, "flashcard");
      f.state = { ...stateOf(f), pinned: op.pinned };
      return kit;
    }
    case "moveFlashcard": {
      const index = kit.flashcards.findIndex((f) => f.id === op.id);
      if (index === -1) throw new KitOpError(`Unknown flashcard ${op.id}`);
      const [f] = kit.flashcards.splice(index, 1) as [Flashcard];
      kit.flashcards.splice(Math.min(op.index, kit.flashcards.length), 0, f);
      return kit;
    }
    case "updateBrief": {
      Object.assign(kit.company_brief, op.patch);
      kit.company_brief.state = { pinned: kit.company_brief.state?.pinned ?? false, edited: true };
      return kit;
    }
    case "pinBrief": {
      kit.company_brief.state = { edited: kit.company_brief.state?.edited ?? false, pinned: op.pinned };
      return kit;
    }
  }
}

/**
 * Place a question at position `index` *within its category*, keeping the global
 * array grouped by category so ordering in the UI and in storage agree.
 */
function insertIntoCategory(questions: Question[], q: Question, index: number): void {
  const positions = questions.map((x, i) => (x.category === q.category ? i : -1)).filter((i) => i !== -1);
  let at: number;
  if (positions.length === 0) at = questions.length;
  else if (index >= positions.length) at = positions[positions.length - 1]! + 1;
  else at = positions[index]!;
  questions.splice(at, 0, q);
}

/**
 * Keep derived fields consistent after any change: coverage is recomputed by code,
 * and the schedule loses references to questions that no longer exist (it is never
 * silently rebuilt; the UI offers "regenerate schedule" for new questions).
 */
export function refreshDerived(kit: Kit): Kit {
  const ids = new Set(kit.questions.map((q) => q.id));
  kit.schedule.days = kit.schedule.days.map((d) => ({ ...d, question_ids: d.question_ids.filter((id) => ids.has(id)) }));
  kit.coverage = { ...kit.coverage, uncovered_requirement_ids: checkCoverage(kit.role.requirements, kit.questions).uncovered };
  return kit;
}

/** Questions that exist but are not in any schedule day: the schedule is stale for them. */
export function unscheduledQuestionIds(kit: Kit): string[] {
  const scheduled = new Set(kit.schedule.days.flatMap((d) => d.question_ids));
  return kit.questions.filter((q) => !scheduled.has(q.id)).map((q) => q.id);
}

function findOrThrow<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find((x) => x.id === id);
  if (!item) throw new KitOpError(`Unknown ${label} ${id}`);
  return item;
}
