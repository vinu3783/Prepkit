import { checkCoverage, type CoverageReport } from "../domain/coverage.js";
import { nextId } from "../domain/ids.js";
import type { Question, Requirement } from "../domain/schema.js";
import type { LlmClient } from "../llm/client.js";
import { fallbackQuestion, generateGapQuestions, type QuestionContext } from "./questions.js";

/**
 * Three passes: the first check of the draft, then up to two targeted gap-fill
 * rounds, each followed by a re-check. Each gap call asks for exactly one
 * question per missing requirement, so a model that cooperates at all closes
 * the gap in one round; a second round catches responses that ignored an id.
 * Beyond that returns diminish while each round costs a slice of a small
 * per-minute token budget, so any must-have still uncovered gets a plain
 * question built in code. A kit never ships with an uncovered must-have.
 */
export const MAX_COVERAGE_PASSES = 3;

export interface CoverageLoopResult {
  questions: Question[];
  passes: number;
  report: CoverageReport;
  /** Requirement ids that needed a code-built fallback question. */
  fallbackFor: string[];
  /** Requirement ids each pass found uncovered, for progress reporting. */
  history: string[][];
  gapErrors: string[];
}

export async function closeCoverageGaps(
  requirements: Requirement[],
  initial: Question[],
  ctx: QuestionContext,
  llm: LlmClient,
  onPass?: (pass: number, uncovered: string[]) => void,
): Promise<CoverageLoopResult> {
  let questions = [...initial];
  const history: string[][] = [];
  const gapErrors: string[] = [];
  let passes = 0;
  let report = checkCoverage(requirements, questions);

  for (;;) {
    passes++;
    report = checkCoverage(requirements, questions);
    history.push(report.uncovered);
    onPass?.(passes, report.uncovered);
    if (report.uncovered.length === 0 || passes >= MAX_COVERAGE_PASSES) break;

    const missing = requirements.filter((r) => report.uncovered.includes(r.id));
    try {
      const drafts = await generateGapQuestions(missing, ctx, llm);
      for (const d of drafts) questions.push({ ...d, id: nextId("q", questions) });
    } catch (err) {
      gapErrors.push((err as Error).message);
      break;
    }
  }

  const fallbackFor = report.uncoveredMust.slice();
  if (fallbackFor.length) {
    for (const id of fallbackFor) {
      const r = requirements.find((x) => x.id === id)!;
      questions.push({ ...fallbackQuestion(r), id: nextId("q", questions) });
    }
    report = checkCoverage(requirements, questions);
  }
  return { questions, passes, report, fallbackFor, history, gapErrors };
}
