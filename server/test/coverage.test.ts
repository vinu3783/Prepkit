import { describe, expect, it } from "vitest";
import { checkCoverage } from "../src/domain/coverage.js";
import { question, requirements } from "./fixtures.js";

describe("checkCoverage", () => {
  it("reports every requirement as uncovered when there are no questions", () => {
    const report = checkCoverage(requirements, []);
    expect(report.uncovered).toEqual(["r1", "r2", "r3", "r4"]);
    expect(report.uncoveredMust).toEqual(["r1", "r2"]);
  });

  it("separates must-have gaps from nice-to-have gaps", () => {
    const report = checkCoverage(requirements, [question("q1", ["r1"]), question("q2", ["r3"])]);
    expect(report.uncovered).toEqual(["r2", "r4"]);
    expect(report.uncoveredMust).toEqual(["r2"]);
  });

  it("counts a question that covers several requirements against each of them", () => {
    const report = checkCoverage(requirements, [question("q1", ["r1", "r2", "r3", "r4"])]);
    expect(report.uncovered).toEqual([]);
    expect(report.questionsByRequirement.get("r2")).toEqual(["q1"]);
  });

  it("ignores references to requirement ids that do not exist", () => {
    const report = checkCoverage(requirements, [question("q1", ["r99"])]);
    expect(report.uncovered).toHaveLength(4);
  });

  it("does not double count a duplicated requirement id on one question", () => {
    const report = checkCoverage(requirements, [question("q1", ["r1", "r1"])]);
    expect(report.questionsByRequirement.get("r1")).toEqual(["q1"]);
  });

  it("handles a thin job description with no requirements", () => {
    const report = checkCoverage([], [question("q1", [])]);
    expect(report.uncovered).toEqual([]);
    expect(report.uncoveredMust).toEqual([]);
  });
});
