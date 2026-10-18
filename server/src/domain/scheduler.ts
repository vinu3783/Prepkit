import type { Question, QuestionCategory, Requirement, ScheduleDay } from "./schema.js";

/**
 * Deterministic study-schedule allocation (Section 8). No model involved.
 *
 * 1. Rank questions: must-have before nice-to-have before unlinked, then harder
 *    before easier, then original order (stable).
 * 2. Split the days into learning days followed by review days. With 3+ days,
 *    a quarter (at least one) is reserved for review so the night before is never
 *    new material. If there are fewer questions than learning days, the spare days
 *    become review days too.
 * 3. Cut the ranked list into contiguous chunks of roughly equal minutes, one per
 *    learning day. Contiguity keeps the hardest, highest-priority work earliest.
 * 4. Review days revisit questions round-robin in the same priority order, at half
 *    the original cost, each capped at an average learning day's minutes.
 *
 * Every question is placed on exactly one learning day, so every requirement that
 * has a question (and after the coverage loop that is every must-have) appears.
 */

export const MINUTES_BY_DIFFICULTY: Record<number, number> = { 1: 10, 2: 15, 3: 25 };
export const EMPTY_DAY_MINUTES = 30;
export const REVIEW_MIN_MINUTES = 20;

export interface ScheduleInput {
  requirements: Requirement[];
  questions: Question[];
  days: number;
}

export interface Schedule {
  days_available: number;
  days: ScheduleDay[];
}

const CATEGORY_LABEL: Record<QuestionCategory, string> = {
  technical: "Technical",
  behavioural: "Behavioural",
  "system-design": "System design",
  "company-fit": "Company fit",
};

export function buildSchedule({ requirements, questions, days }: ScheduleInput): Schedule {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`days must be a positive integer, got ${days}`);
  }

  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const ranked = rankQuestions(questions, reqById);

  if (ranked.length === 0) {
    return {
      days_available: days,
      days: Array.from({ length: days }, (_, i) => ({
        day: i + 1,
        focus: "Company research and your own story: no questions in this kit yet",
        question_ids: [],
        minutes: EMPTY_DAY_MINUTES,
      })),
    };
  }

  const reservedReview = days >= 3 ? Math.max(1, Math.floor(days * 0.25)) : 0;
  const learnDays = Math.min(days - reservedReview, ranked.length);
  const reviewDays = days - learnDays;

  const chunks = chunkByCost(ranked, learnDays);
  const schedule: ScheduleDay[] = chunks.map((chunk, i) => ({
    day: i + 1,
    focus: describeFocus(chunk, reqById),
    question_ids: chunk.map((q) => q.id),
    minutes: sum(chunk.map(costOf)),
  }));

  // Review days walk the ranked list round-robin (must-haves and hard questions come
  // round first and most often), each capped at an average learning day's minutes so
  // review never outweighs learning. More review days than questions just cycles again.
  const learningMinutes = schedule.reduce((a, d) => a + d.minutes, 0);
  const reviewBudget = Math.max(REVIEW_MIN_MINUTES, Math.round(learningMinutes / Math.max(1, learnDays)));
  let cursor = 0;
  for (let r = 0; r < reviewDays; r++) {
    const unique: Question[] = [];
    let minutes = 0;
    while (unique.length < ranked.length) {
      const q = ranked[cursor % ranked.length]!;
      const cost = Math.ceil(costOf(q) / 2);
      if (unique.length > 0 && minutes + cost > reviewBudget) break;
      unique.push(q);
      minutes += cost;
      cursor++;
    }
    const isLast = r === reviewDays - 1;
    schedule.push({
      day: learnDays + r + 1,
      focus: isLast
        ? `Final review: light pass, no new material. ${describeFocus(unique, reqById)}`
        : `Review and mock answers: ${describeFocus(unique, reqById)}`,
      question_ids: unique.map((q) => q.id),
      minutes: sum(unique.map((q) => Math.ceil(costOf(q) / 2))),
    });
  }

  return { days_available: days, days: schedule };
}

export function costOf(q: Question): number {
  return MINUTES_BY_DIFFICULTY[q.difficulty] ?? MINUTES_BY_DIFFICULTY[2]!;
}

function priorityRank(q: Question, reqById: Map<string, Requirement>): number {
  let rank = 0;
  for (const rid of q.requirement_ids) {
    const r = reqById.get(rid);
    if (r?.priority === "must") return 2;
    if (r?.priority === "nice") rank = 1;
  }
  return rank;
}

function rankQuestions(questions: Question[], reqById: Map<string, Requirement>): Question[] {
  return questions
    .map((q, index) => ({ q, index, priority: priorityRank(q, reqById) }))
    .sort((a, b) => b.priority - a.priority || b.q.difficulty - a.q.difficulty || a.index - b.index)
    .map((x) => x.q);
}

/** Contiguous partition into exactly `n` non-empty chunks of roughly equal total cost. */
function chunkByCost(items: Question[], n: number): Question[][] {
  const chunks: Question[][] = [];
  let remainingCost = sum(items.map(costOf));
  let i = 0;
  for (let day = 0; day < n; day++) {
    const daysLeft = n - day;
    const target = remainingCost / daysLeft;
    const chunk: Question[] = [];
    let cost = 0;
    while (i < items.length) {
      const itemsLeftAfterTake = items.length - (i + 1);
      const mustLeaveForOthers = itemsLeftAfterTake < daysLeft - 1;
      if (mustLeaveForOthers) break;
      const next = costOf(items[i]!);
      // Take the item if the day is empty, or if adding it lands closer to target than stopping.
      if (chunk.length > 0 && cost + next / 2 > target && daysLeft > 1) break;
      chunk.push(items[i]!);
      cost += next;
      i++;
    }
    chunks.push(chunk);
    remainingCost -= cost;
  }
  return chunks;
}

function describeFocus(qs: Question[], reqById: Map<string, Requirement>): string {
  const categoryCounts = new Map<QuestionCategory, number>();
  for (const q of qs) categoryCounts.set(q.category, (categoryCounts.get(q.category) ?? 0) + 1);
  const categories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => CATEGORY_LABEL[c]);

  const topics: string[] = [];
  for (const q of qs) {
    for (const rid of q.requirement_ids) {
      const text = reqById.get(rid)?.text;
      if (text && !topics.includes(text)) topics.push(text);
    }
  }
  const topicText = topics.slice(0, 2).map((t) => truncate(t, 48)).join("; ");
  return topicText ? `${categories.join(" + ")}: ${topicText}` : categories.join(" + ");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
