import type { Question, Requirement } from "./schema.js";

export interface CoverageReport {
  /** Every requirement with no question pointing at it. */
  uncovered: string[];
  /** The subset of `uncovered` marked must — these block shipping the kit. */
  uncoveredMust: string[];
  /** requirement id -> ids of the questions that cover it */
  questionsByRequirement: Map<string, string[]>;
}

/**
 * Deterministic coverage check. The model never decides whether something is
 * covered: a requirement is covered iff at least one question lists its id.
 * References to requirement ids that do not exist are ignored (they cover nothing).
 */
export function checkCoverage(requirements: Requirement[], questions: Question[]): CoverageReport {
  const questionsByRequirement = new Map<string, string[]>(requirements.map((r) => [r.id, []]));
  for (const q of questions) {
    for (const rid of new Set(q.requirement_ids)) {
      questionsByRequirement.get(rid)?.push(q.id);
    }
  }

  const uncovered = requirements.filter((r) => questionsByRequirement.get(r.id)!.length === 0);
  return {
    uncovered: uncovered.map((r) => r.id),
    uncoveredMust: uncovered.filter((r) => r.priority === "must").map((r) => r.id),
    questionsByRequirement,
  };
}
