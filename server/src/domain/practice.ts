import type { Flashcard, Requirement } from "./schema.js";

/**
 * Practice scheduling: a small SM-2 variant, bounded by the interview date.
 *
 * Why spaced repetition rather than a plain confidence sort: a sort re-drills the
 * same weak cards every session and never revisits the ones you got right, so
 * they fade before the interview. SM-2 brings weak cards back soon and confident
 * ones back later. Why bounded: classic intervals (weeks) are useless when the
 * interview is in 5 days, so no card is scheduled past the day before the interview.
 *
 * Confidence: 1 = no idea, 2 = shaky, 3 = got it, 4 = easy.
 */

export type Confidence = 1 | 2 | 3 | 4;

export interface CardProgress {
  reviews: number;
  lastConfidence: Confidence;
  ease: number;
  intervalDays: number;
  dueAt: string;
  lastReviewedAt: string;
}

const DAY_MS = 86_400_000;
const AGAIN_MS = 10 * 60_000;

export function recordReview(prev: CardProgress | undefined, confidence: Confidence, now: Date, interviewAt?: Date): CardProgress {
  let ease = prev?.ease ?? 2.5;
  const prevInterval = prev?.intervalDays ?? 0;
  let intervalDays: number;

  switch (confidence) {
    case 1:
      ease = Math.max(1.3, ease - 0.2);
      intervalDays = 0;
      break;
    case 2:
      ease = Math.max(1.3, ease - 0.15);
      intervalDays = Math.max(1, Math.round(prevInterval * 1.2));
      break;
    case 3:
      intervalDays = prevInterval === 0 ? 1 : Math.round(prevInterval * ease);
      break;
    case 4:
      ease += 0.15;
      intervalDays = prevInterval === 0 ? 2 : Math.round(prevInterval * ease * 1.3);
      break;
  }

  let due = intervalDays === 0 ? now.getTime() + AGAIN_MS : now.getTime() + intervalDays * DAY_MS;
  if (interviewAt) {
    const lastUsefulDay = interviewAt.getTime() - DAY_MS;
    if (due > lastUsefulDay && lastUsefulDay > now.getTime()) {
      due = lastUsefulDay;
      intervalDays = Math.max(0, Math.round((due - now.getTime()) / DAY_MS));
    }
  }

  return {
    reviews: (prev?.reviews ?? 0) + 1,
    lastConfidence: confidence,
    ease: Math.round(ease * 100) / 100,
    intervalDays,
    dueAt: new Date(due).toISOString(),
    lastReviewedAt: now.toISOString(),
  };
}

/**
 * Next session order: due cards (least confident first, then most overdue),
 * then never-seen cards in kit order, then not-yet-due cards (least confident
 * first) for anyone who wants to keep going.
 */
export function orderSession(cards: Flashcard[], progress: Record<string, CardProgress>, now: Date): Flashcard[] {
  const t = now.getTime();
  const due: Flashcard[] = [];
  const unseen: Flashcard[] = [];
  const later: Flashcard[] = [];
  for (const c of cards) {
    const p = progress[c.id];
    if (!p) unseen.push(c);
    else if (Date.parse(p.dueAt) <= t) due.push(c);
    else later.push(c);
  }
  const byConfidenceThenDue = (a: Flashcard, b: Flashcard) => {
    const pa = progress[a.id]!;
    const pb = progress[b.id]!;
    return pa.lastConfidence - pb.lastConfidence || Date.parse(pa.dueAt) - Date.parse(pb.dueAt);
  };
  return [...due.sort(byConfidenceThenDue), ...unseen, ...later.sort(byConfidenceThenDue)];
}

export interface PracticeSummary {
  total: number;
  covered: number;
  dueNow: number;
  byConfidence: Record<Confidence, number>;
  /** Requirements whose cards are unseen or, on average, below "got it". */
  weakRequirementIds: string[];
}

export function summarizePractice(cards: Flashcard[], progress: Record<string, CardProgress>, requirements: Requirement[], now: Date): PracticeSummary {
  const byConfidence: Record<Confidence, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let covered = 0;
  let dueNow = 0;
  for (const c of cards) {
    const p = progress[c.id];
    if (!p) continue;
    covered++;
    byConfidence[p.lastConfidence]++;
    if (Date.parse(p.dueAt) <= now.getTime()) dueNow++;
  }
  const weakRequirementIds = requirements
    .filter((r) => {
      const related = cards.filter((c) => c.requirement_ids.includes(r.id));
      if (related.length === 0) return false;
      const scores: number[] = related.map((c) => progress[c.id]?.lastConfidence ?? 0);
      return scores.some((s) => s === 0) || scores.reduce((a, b) => a + b, 0) / scores.length < 3;
    })
    .map((r) => r.id);
  return { total: cards.length, covered, dueNow, byConfidence, weakRequirementIds };
}
