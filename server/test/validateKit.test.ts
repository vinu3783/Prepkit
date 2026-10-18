import { describe, expect, it } from "vitest";
import { buildSchedule } from "../src/domain/scheduler.js";
import { validateKit } from "../src/domain/validateKit.js";
import { makeKit, makeQuestions, question, requirements } from "./fixtures.js";

const errorsOf = (input: unknown) => {
  const v = validateKit(input);
  return v.ok ? [] : v.errors;
};

describe("validateKit", () => {
  it("accepts a well-formed Appendix A kit", () => {
    expect(validateKit(makeKit()).ok).toBe(true);
  });

  it("accepts a kit whose schedule came from buildSchedule", () => {
    const questions = makeQuestions(8);
    const schedule = buildSchedule({ requirements, questions, days: 5 });
    expect(errorsOf(makeKit({ questions, schedule }))).toEqual([]);
  });

  it("rejects missing top-level fields", () => {
    const { coverage: _omit, ...rest } = makeKit();
    expect(errorsOf(rest).some((e) => e.startsWith("coverage"))).toBe(true);
  });

  it("rejects a bad enum value for kind, priority or category", () => {
    const kit = makeKit();
    (kit.role.requirements[0] as { priority: string }).priority = "required";
    (kit.questions[0] as { category: string }).category = "coding";
    const errors = errorsOf(kit);
    expect(errors.some((e) => e.includes("priority"))).toBe(true);
    expect(errors.some((e) => e.includes("category"))).toBe(true);
  });

  it("rejects fractional minutes and out-of-range difficulty", () => {
    const kit = makeKit();
    kit.schedule.days[0]!.minutes = 37.5;
    kit.questions[0]!.difficulty = 4;
    const errors = errorsOf(kit);
    expect(errors.some((e) => e.includes("minutes"))).toBe(true);
    expect(errors.some((e) => e.includes("difficulty"))).toBe(true);
  });

  it("rejects a schedule whose length differs from days_available", () => {
    const kit = makeKit();
    kit.schedule.days_available = 3;
    expect(errorsOf(kit)).toContain("schedule has 2 days but days_available is 3");
  });

  it("rejects a schedule referencing a question that does not exist", () => {
    const kit = makeKit();
    kit.schedule.days[1]!.question_ids.push("q404");
    expect(errorsOf(kit)).toContain("schedule day 2 references unknown question q404");
  });

  it("rejects questions and flashcards that reference unknown requirements", () => {
    const kit = makeKit({ questions: [question("q1", ["r9"])] });
    kit.schedule.days = [
      { day: 1, focus: "x", question_ids: ["q1"], minutes: 15 },
      { day: 2, focus: "x", question_ids: [], minutes: 15 },
    ];
    kit.flashcards[0]!.requirement_ids = ["r8"];
    const errors = errorsOf(kit);
    expect(errors).toContain("question q1 references unknown requirement r9");
    expect(errors).toContain("flashcard f1 references unknown requirement r8");
  });

  it("rejects duplicate ids", () => {
    const kit = makeKit({ questions: [question("q1", ["r1"]), question("q1", ["r2"])] });
    kit.schedule.days[1]!.question_ids = [];
    expect(errorsOf(kit)).toContain("duplicate question id q1");
  });

  it("allows the builder state extension but validates it", () => {
    const kit = makeKit();
    kit.questions[0]!.state = { origin: "user", edited: true, pinned: false };
    expect(validateKit(kit).ok).toBe(true);
    (kit.questions[0]!.state as { origin: string }).origin = "ai";
    expect(validateKit(kit).ok).toBe(false);
  });
});
