import { Kit } from "./schema.js";

export type KitValidation = { ok: true; kit: Kit } | { ok: false; errors: string[] };

/**
 * Structural validation (zod) followed by the cross-references Appendix A requires
 * but a schema cannot express: unique ids, questions/flashcards pointing at real
 * requirements, schedule pointing at real questions, and exactly N days.
 * Run before every save and before a batch case is written out.
 */
export function validateKit(input: unknown): KitValidation {
  const parsed = Kit.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const kit = parsed.data;
  const errors: string[] = [];

  const requirementIds = collectIds(kit.role.requirements, "requirement", errors);
  const questionIds = collectIds(kit.questions, "question", errors);
  collectIds(kit.flashcards, "flashcard", errors);

  for (const q of kit.questions) {
    for (const rid of q.requirement_ids) {
      if (!requirementIds.has(rid)) errors.push(`question ${q.id} references unknown requirement ${rid}`);
    }
  }
  for (const f of kit.flashcards) {
    for (const rid of f.requirement_ids) {
      if (!requirementIds.has(rid)) errors.push(`flashcard ${f.id} references unknown requirement ${rid}`);
    }
  }

  const { days_available, days } = kit.schedule;
  if (days.length !== days_available) {
    errors.push(`schedule has ${days.length} days but days_available is ${days_available}`);
  }
  days.forEach((d, i) => {
    if (d.day !== i + 1) errors.push(`schedule day at index ${i} is numbered ${d.day}, expected ${i + 1}`);
    for (const qid of d.question_ids) {
      if (!questionIds.has(qid)) errors.push(`schedule day ${d.day} references unknown question ${qid}`);
    }
  });

  for (const rid of kit.coverage.uncovered_requirement_ids) {
    if (!requirementIds.has(rid)) errors.push(`coverage lists unknown requirement ${rid}`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, kit };
}

function collectIds(items: { id: string }[], label: string, errors: string[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) errors.push(`duplicate ${label} id ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}
