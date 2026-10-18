import { nextId } from "./ids.js";
import { isReplaceable, refreshDerived } from "./kitOps.js";
import type { Kit, Question, QuestionCategory } from "./schema.js";

export type DraftQuestion = Omit<Question, "id">;

/**
 * Snapshot taken when a category regeneration starts: the questions it is allowed
 * to replace. Anything edited, pinned or hand-written is excluded up front.
 */
export function replaceableInCategory(kit: Kit, category: QuestionCategory): string[] {
  return kit.questions.filter((q) => q.category === category && isReplaceable(q)).map((q) => q.id);
}

/** Prompts the model must not duplicate: everything that will survive the regeneration. */
export function keptPromptsInCategory(kit: Kit, category: QuestionCategory): string[] {
  return kit.questions.filter((q) => q.category === category && !isReplaceable(q)).map((q) => q.prompt);
}

/**
 * Merge freshly generated questions for one category into the LATEST kit (not the
 * snapshot the generation started from), so edits made while the model was working
 * are preserved:
 *  - a question is removed only if it was replaceable at the start AND is still
 *    replaceable now AND is still in this category (a user may have edited, pinned
 *    or moved it in the meantime: then it stays)
 *  - questions added by hand during generation are untouched (they were never in the snapshot)
 *  - new questions take the place of the first removed one; ids continue from the
 *    high-water mark so a deleted id is never reused for different content
 *  - coverage and schedule references are refreshed by code
 */
export function mergeCategoryRegeneration(
  latest: Kit,
  category: QuestionCategory,
  replaceableAtStart: Iterable<string>,
  drafts: DraftQuestion[],
  idFloor = 0,
): { kit: Kit; added: string[]; removed: string[]; idFloor: number } {
  const kit = structuredClone(latest);
  const candidates = new Set(replaceableAtStart);
  const removed: string[] = [];
  let insertAt = -1;

  const remaining: Question[] = [];
  kit.questions.forEach((q) => {
    if (candidates.has(q.id) && q.category === category && isReplaceable(q)) {
      removed.push(q.id);
      if (insertAt === -1) insertAt = remaining.length;
    } else {
      remaining.push(q);
    }
  });

  const keptPrompts = new Set(remaining.filter((q) => q.category === category).map((q) => normalizePrompt(q.prompt)));
  const added: Question[] = [];
  let floor = Math.max(idFloor, highWater(latest.questions));
  for (const d of drafts) {
    const key = normalizePrompt(d.prompt);
    if (keptPrompts.has(key)) continue;
    keptPrompts.add(key);
    const id = nextId("q", [], floor);
    floor += 1;
    added.push({ ...d, id, category, state: { origin: "generated", edited: false, pinned: false } });
  }

  if (insertAt === -1) {
    const lastInCategory = remaining.map((q) => q.category).lastIndexOf(category);
    insertAt = lastInCategory === -1 ? remaining.length : lastInCategory + 1;
  }
  remaining.splice(insertAt, 0, ...added);
  kit.questions = remaining;
  return { kit: refreshDerived(kit), added: added.map((q) => q.id), removed, idFloor: floor };
}

export function highWater(items: { id: string }[], prefix = "q"): number {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  return items.reduce((max, item) => {
    const m = re.exec(item.id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
}

function normalizePrompt(p: string): string {
  return p.toLowerCase().replace(/\W+/g, " ").trim();
}
