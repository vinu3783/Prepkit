import { describe, expect, it } from "vitest";
import { buildSchedule, costOf } from "../src/domain/scheduler.js";
import { makeQuestions, question, requirements } from "./fixtures.js";

const scheduledIds = (s: ReturnType<typeof buildSchedule>) => new Set(s.days.flatMap((d) => d.question_ids));

describe("buildSchedule", () => {
  it.each([1, 2, 3, 5, 7, 14, 30, 60])("produces exactly %i days, numbered 1..n, with integer minutes", (days) => {
    const s = buildSchedule({ requirements, questions: makeQuestions(12), days });
    expect(s.days_available).toBe(days);
    expect(s.days).toHaveLength(days);
    s.days.forEach((d, i) => {
      expect(d.day).toBe(i + 1);
      expect(Number.isInteger(d.minutes)).toBe(true);
      expect(d.minutes).toBeGreaterThan(0);
      expect(d.focus.length).toBeGreaterThan(0);
    });
  });

  it.each([1, 2, 5, 60])("schedules every question, and so every covered must-have, for %i days", (days) => {
    const questions = makeQuestions(9);
    const s = buildSchedule({ requirements, questions, days });
    const ids = scheduledIds(s);
    for (const q of questions) expect(ids.has(q.id)).toBe(true);
    const mustIds = requirements.filter((r) => r.priority === "must").map((r) => r.id);
    const scheduledReqs = new Set(questions.filter((q) => ids.has(q.id)).flatMap((q) => q.requirement_ids));
    for (const id of mustIds) expect(scheduledReqs.has(id)).toBe(true);
  });

  it("only references questions that exist", () => {
    const questions = makeQuestions(4);
    const s = buildSchedule({ requirements, questions, days: 10 });
    const known = new Set(questions.map((q) => q.id));
    for (const id of scheduledIds(s)) expect(known.has(id)).toBe(true);
  });

  it("puts a 1-day schedule's whole workload on that day", () => {
    const questions = makeQuestions(6);
    const s = buildSchedule({ requirements, questions, days: 1 });
    expect(s.days[0]!.question_ids).toHaveLength(6);
    expect(s.days[0]!.minutes).toBe(questions.reduce((a, q) => a + costOf(q), 0));
  });

  it("places must-have and harder material before nice-to-have and easier", () => {
    const questions = [
      question("easy-nice", ["r3"], 1),
      question("hard-nice", ["r4"], 3),
      question("easy-must", ["r1"], 1),
      question("hard-must", ["r2"], 3),
    ];
    const s = buildSchedule({ requirements, questions, days: 4 });
    const order = s.days.slice(0, 3).flatMap((d) => d.question_ids);
    expect(order[0]).toBe("hard-must");
    expect(order.indexOf("easy-must")).toBeLessThan(order.indexOf("hard-nice"));
    expect(order.indexOf("hard-nice")).toBeLessThan(order.indexOf("easy-nice"));
  });

  it("keeps the last day free of new material when there are 3+ days", () => {
    const questions = makeQuestions(20);
    const s = buildSchedule({ requirements, questions, days: 5 });
    const last = s.days.at(-1)!;
    expect(last.focus).toMatch(/^Final review/);
    const learned = new Set(s.days.slice(0, -1).flatMap((d) => d.question_ids));
    for (const id of last.question_ids) expect(learned.has(id)).toBe(true);
  });

  it("balances learning-day workload rather than front-loading everything onto day 1", () => {
    const s = buildSchedule({ requirements, questions: makeQuestions(30), days: 6 });
    const learning = s.days.filter((d) => !/review/i.test(d.focus));
    const minutes = learning.map((d) => d.minutes);
    expect(Math.max(...minutes) - Math.min(...minutes)).toBeLessThanOrEqual(25);
  });

  it("fills every day even when there are far fewer questions than days", () => {
    const s = buildSchedule({ requirements, questions: makeQuestions(2), days: 60 });
    expect(s.days).toHaveLength(60);
    expect(s.days.every((d) => d.question_ids.length > 0)).toBe(true);
  });

  it("returns an honest placeholder schedule when there are no questions", () => {
    const s = buildSchedule({ requirements: [], questions: [], days: 3 });
    expect(s.days).toHaveLength(3);
    expect(s.days.every((d) => d.question_ids.length === 0 && d.minutes > 0)).toBe(true);
  });

  it("rejects a non-positive or fractional day count", () => {
    expect(() => buildSchedule({ requirements, questions: [], days: 0 })).toThrow(RangeError);
    expect(() => buildSchedule({ requirements, questions: [], days: 2.5 })).toThrow(RangeError);
  });

  it("is deterministic", () => {
    const input = { requirements, questions: makeQuestions(11), days: 7 };
    expect(buildSchedule(input)).toEqual(buildSchedule(input));
  });
});

describe("review days", () => {
  it("never make a review day heavier than an average learning day (+ one item)", () => {
    const s = buildSchedule({ requirements, questions: makeQuestions(13), days: 5 });
    const learning = s.days.filter((d) => !/review/i.test(d.focus));
    const avg = learning.reduce((a, d) => a + d.minutes, 0) / learning.length;
    for (const d of s.days.filter((d) => /review/i.test(d.focus))) expect(d.minutes).toBeLessThanOrEqual(Math.max(20, Math.round(avg)) + 13);
  });
});
