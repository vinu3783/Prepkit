import { describe, expect, it } from "vitest";
import { applyOps, isReplaceable, KitOp, KitOpError } from "../src/domain/kitOps.js";
import { orderSession, recordReview, summarizePractice, type CardProgress } from "../src/domain/practice.js";
import { keptPromptsInCategory, mergeCategoryRegeneration, replaceableInCategory } from "../src/domain/regenerate.js";
import type { Flashcard, Kit, Question } from "../src/domain/schema.js";
import { validateKit } from "../src/domain/validateKit.js";
import { makeKit, question, requirements } from "./fixtures.js";

const gen = (q: Question): Question => ({ ...q, state: { origin: "generated", edited: false, pinned: false } });

function builderKit(): Kit {
  return makeKit({
    questions: [
      gen(question("q1", ["r1"], 2, "technical")),
      gen(question("q2", ["r3"], 2, "technical")),
      gen(question("q3", ["r1"], 3, "technical")),
      gen(question("q4", ["r2"], 2, "behavioural")),
    ],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: "a", question_ids: ["q1", "q2"], minutes: 30 },
        { day: 2, focus: "b", question_ids: ["q3", "q4"], minutes: 30 },
      ],
    },
  });
}
const ids = (k: Kit, category?: string) => k.questions.filter((q) => !category || q.category === category).map((q) => q.id);
const draft = (prompt: string, reqs = ["r1"]) => ({ requirement_ids: reqs, category: "technical" as const, prompt, answer_outline: "", difficulty: 2 });

describe("builder ops", () => {
  it("marks an edited question as edited, which protects it from regeneration", () => {
    const k = applyOps(builderKit(), [{ type: "updateQuestion", id: "q1", patch: { prompt: "My better question" } }]);
    const q1 = k.questions.find((q) => q.id === "q1")!;
    expect(q1.prompt).toBe("My better question");
    expect(isReplaceable(q1)).toBe(false);
  });

  it("reorders within a category", () => {
    const k = applyOps(builderKit(), [{ type: "moveQuestion", id: "q3", category: "technical", index: 0 }]);
    expect(ids(k, "technical")).toEqual(["q3", "q1", "q2"]);
    expect(isReplaceable(k.questions.find((q) => q.id === "q3")!)).toBe(true); // pure reorder is not a content edit
  });

  it("moves a question to another category and protects it", () => {
    const k = applyOps(builderKit(), [{ type: "moveQuestion", id: "q2", category: "behavioural", index: 0 }]);
    expect(ids(k, "behavioural")).toEqual(["q2", "q4"]);
    expect(k.questions.find((q) => q.id === "q2")!.state?.edited).toBe(true);
  });

  it("adds a hand-written question as origin user, and deletes questions", () => {
    const k = applyOps(builderKit(), [
      { type: "addQuestion", question: { id: "u-abc", category: "technical", prompt: "Mine", answer_outline: "", difficulty: 2, requirement_ids: ["r1"] } },
      { type: "deleteQuestion", id: "q2" },
    ]);
    expect(ids(k, "technical")).toEqual(["q1", "q3", "u-abc"]);
    expect(k.questions.find((q) => q.id === "u-abc")!.state?.origin).toBe("user");
  });

  it("recomputes coverage and prunes the schedule when a question is deleted", () => {
    const k = applyOps(builderKit(), [{ type: "deleteQuestion", id: "q2" }]);
    expect(k.coverage.uncovered_requirement_ids).toContain("r3");
    expect(k.schedule.days[0]!.question_ids).toEqual(["q1"]);
    expect(validateKit(k).ok).toBe(true);
  });

  it("rejects unknown ids, unknown requirements and duplicate ids", () => {
    expect(() => applyOps(builderKit(), [{ type: "deleteQuestion", id: "q99" }])).toThrow(KitOpError);
    expect(() => applyOps(builderKit(), [{ type: "updateQuestion", id: "q1", patch: { requirement_ids: ["r42"] } }])).toThrow(/r42/);
    expect(() =>
      applyOps(builderKit(), [{ type: "addQuestion", question: { id: "q1", category: "technical", prompt: "x", answer_outline: "", difficulty: 2, requirement_ids: [] } }]),
    ).toThrow(/exists/);
  });

  it("validates op payloads at the boundary", () => {
    expect(KitOp.safeParse({ type: "updateQuestion", id: "q1", patch: { difficulty: 7 } }).success).toBe(false);
    expect(KitOp.safeParse({ type: "updateQuestion", id: "q1", patch: { evil: true } }).success).toBe(false);
    expect(KitOp.safeParse({ type: "dropDatabase" }).success).toBe(false);
  });

  it("does not mutate the input kit", () => {
    const k = builderKit();
    applyOps(k, [{ type: "deleteQuestion", id: "q1" }]);
    expect(ids(k)).toContain("q1");
  });

  it("marks the brief edited and pinned independently", () => {
    const k = applyOps(builderKit(), [
      { type: "updateBrief", patch: { summary: "Mine" } },
      { type: "pinBrief", pinned: true },
    ]);
    expect(k.company_brief.state).toEqual({ edited: true, pinned: true });
  });
});

describe("category regeneration merge", () => {
  it("replaces only generated, unedited, unpinned questions of that category", () => {
    let k = applyOps(builderKit(), [
      { type: "updateQuestion", id: "q1", patch: { prompt: "Edited by hand" } },
      { type: "pinQuestion", id: "q3", pinned: true },
    ]);
    const snapshot = replaceableInCategory(k, "technical");
    expect(snapshot).toEqual(["q2"]);
    const { kit, removed, added } = mergeCategoryRegeneration(k, "technical", snapshot, [draft("New A"), draft("New B", ["r3"])]);
    k = kit;
    expect(removed).toEqual(["q2"]);
    expect(added).toEqual(["q5", "q6"]);
    expect(ids(k, "technical")).toEqual(["q1", "q5", "q6", "q3"]);
    expect(k.questions.find((q) => q.id === "q1")!.prompt).toBe("Edited by hand");
    expect(ids(k, "behavioural")).toEqual(["q4"]); // other categories untouched
    expect(validateKit(k).ok).toBe(true);
  });

  it("keeps a question the user edited WHILE the regeneration was running", () => {
    const start = builderKit();
    const snapshot = replaceableInCategory(start, "technical"); // q1,q2,q3 all replaceable at start
    const latest = applyOps(start, [{ type: "updateQuestion", id: "q2", patch: { answer_outline: "typed during generation" } }]);
    const { kit, removed } = mergeCategoryRegeneration(latest, "technical", snapshot, [draft("Fresh")]);
    expect(removed).toEqual(["q1", "q3"]);
    expect(kit.questions.find((q) => q.id === "q2")!.answer_outline).toBe("typed during generation");
  });

  it("keeps questions added or moved out of the category during regeneration", () => {
    const start = builderKit();
    const snapshot = replaceableInCategory(start, "technical");
    const latest = applyOps(start, [
      { type: "addQuestion", question: { id: "u-1", category: "technical", prompt: "Hand-written", answer_outline: "", difficulty: 1, requirement_ids: [] } },
      { type: "moveQuestion", id: "q1", category: "behavioural", index: 0 },
    ]);
    const { kit } = mergeCategoryRegeneration(latest, "technical", snapshot, [draft("Fresh")]);
    expect(ids(kit)).toContain("u-1");
    expect(ids(kit, "behavioural")).toContain("q1");
  });

  it("drops generated duplicates of questions that are being kept", () => {
    const k = applyOps(builderKit(), [{ type: "pinQuestion", id: "q1", pinned: true }]);
    expect(keptPromptsInCategory(k, "technical")).toEqual(["Prompt q1"]);
    const { added } = mergeCategoryRegeneration(k, "technical", replaceableInCategory(k, "technical"), [draft("prompt Q1!"), draft("Other")]);
    expect(added).toHaveLength(1);
  });

  it("never reuses a deleted question's id", () => {
    const k = applyOps(builderKit(), [{ type: "deleteQuestion", id: "q4" }]);
    const { added } = mergeCategoryRegeneration(k, "technical", [], [draft("New")], 4);
    expect(added).toEqual(["q5"]);
  });
});

describe("practice scheduling", () => {
  const now = new Date("2026-10-18T10:00:00Z");
  const interview = new Date("2026-10-23T10:00:00Z");
  const card = (id: string): Flashcard => ({ id, front: id, back: "", requirement_ids: ["r1"] });

  it("brings a 'no idea' card back within the session and an easy card back later", () => {
    const again = recordReview(undefined, 1, now, interview);
    const easy = recordReview(undefined, 4, now, interview);
    expect(Date.parse(again.dueAt) - now.getTime()).toBe(10 * 60_000);
    expect(easy.intervalDays).toBe(2);
  });

  it("never schedules a card after the day before the interview", () => {
    let p: CardProgress | undefined;
    for (let i = 0; i < 6; i++) p = recordReview(p, 4, now, interview);
    expect(Date.parse(p!.dueAt)).toBeLessThanOrEqual(interview.getTime() - 86_400_000);
  });

  it("orders the next session: due least-confident first, then unseen, then later", () => {
    const cards = ["a", "b", "c", "d"].map(card);
    const past = new Date(now.getTime() - 60_000).toISOString();
    const future = new Date(now.getTime() + 86_400_000).toISOString();
    const base = { reviews: 1, ease: 2.5, intervalDays: 1, lastReviewedAt: past };
    const progress: Record<string, CardProgress> = {
      a: { ...base, lastConfidence: 3, dueAt: past },
      b: { ...base, lastConfidence: 1, dueAt: past },
      d: { ...base, lastConfidence: 2, dueAt: future },
    };
    expect(orderSession(cards, progress, now).map((c) => c.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("summarises covered cards and weak requirements", () => {
    const cards = [card("a"), { ...card("b"), requirement_ids: ["r2"] }];
    const progress = { a: recordReview(undefined, 4, now) };
    const s = summarizePractice(cards, progress, requirements, now);
    expect(s.covered).toBe(1);
    expect(s.weakRequirementIds).toEqual(["r2"]);
  });
});
