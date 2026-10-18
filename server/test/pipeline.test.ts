import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { validateKit } from "../src/domain/validateKit.js";
import type { JsonRequest, LlmClient } from "../src/llm/client.js";
import { LlmError } from "../src/llm/errors.js";
import { detectFormats } from "../src/pipeline/companyResearch.js";
import { closeCoverageGaps } from "../src/pipeline/coverageLoop.js";
import { generateKit, PipelineError, type ProgressEvent } from "../src/pipeline/generateKit.js";
import { planCategories, type QuestionContext } from "../src/pipeline/questions.js";
import { decidePriority, isGrounded } from "../src/pipeline/requirements.js";
import { PageFetcher } from "../src/retrieval/fetchPage.js";
import { startMockSites } from "../src/scripts/mockSites.js";
import { question, requirements } from "./fixtures.js";

type Handler = (req: JsonRequest<z.ZodTypeAny>) => unknown;

/** Stands in for LlmClient: answers by task name and records every call. */
function scriptedLlm(handlers: Record<string, Handler>) {
  const calls: JsonRequest<z.ZodTypeAny>[] = [];
  const llm = {
    async generateJson(req: JsonRequest<z.ZodTypeAny>) {
      calls.push(req);
      const key = Object.keys(handlers).find((k) => req.task === k || req.task.startsWith(`${k}:`)) ?? req.task;
      const handler = handlers[key];
      if (!handler) throw new LlmError("PROVIDER_UNAVAILABLE", `no handler for ${req.task}`);
      return req.schema.parse(handler(req));
    },
  };
  return { llm: llm as unknown as LlmClient, calls };
}

const JD = `Senior Backend Engineer
Acme Payments

Requirements
- 5+ years building backend services
- Strong Go experience
- Mentor junior engineers

Nice to have
- Kafka`;

const extraction = {
  company: "Acme Payments",
  title: "Senior Backend Engineer",
  seniority: "senior",
  location: "",
  about_company: "",
  responsibilities: ["Build payout services"],
  requirements: [
    { text: "5+ years building backend services", kind: "technical", priority: "must", quote: "5+ years building backend services" },
    { text: "Strong Go experience", kind: "technical", priority: "must", quote: "Strong Go experience" },
    { text: "Mentoring junior engineers", kind: "behavioural", priority: "must", quote: "Mentor junior engineers" },
    { text: "Kafka", kind: "technical", priority: "must", quote: "Kafka" }, // model mislabels: posting says nice
    { text: "10 years of COBOL", kind: "technical", priority: "must", quote: "10 years of COBOL" }, // invented
  ],
};

/** Answers every category, but every first draft "forgets" r2 so the loop must close it. */
function happyHandlers(): Record<string, Handler> {
  return {
    "extract-requirements": () => extraction,
    "company-brief": (req) => ({ summary: "Acme builds payout APIs.", what_they_do: "Payouts for marketplaces.", key_facts: ["Founded 2017"], used_urls: [/https?:\/\/\S+?acme\/"?/.exec(req.user)?.[0]?.replace(/"$/, "") ?? ""] }),
    "interview-process": () => ({ summary: "Four stages.", stages: [{ name: "Take-home", details: "3 hours" }, { name: "System design", details: "Design a ledger" }], relevant_discussion_urls: [] }),
    questions: (req) => {
      const ids = [...req.user.matchAll(/- (r\d+) \[/g)].map((m) => m[1]!).filter((id) => id !== "r2");
      return { questions: (ids.length ? ids : [""]).map((id) => ({ requirement_ids: id ? [id] : [], prompt: `${req.task} question about ${id || "the role"}`, answer_outline: ["point one", "point two"], difficulty: "3" })) };
    },
    gap: (req) => ({ questions: [...req.user.matchAll(/- (r\d+) \[/g)].map((m) => ({ requirement_ids: [m[1]], prompt: `Gap question for ${m[1]}`, answer_outline: "x", difficulty: 2 })) }),
    flashcards: () => ({ flashcards: [{ requirement_ids: ["r1"], front: "Idempotency?", back: "Same request, same effect." }] }),
  };
}

let server: Server;
let base: string;
const fetcher = () => new PageFetcher({ policy: { allowPrivateHosts: true }, perHostIntervalMs: 0, backoffMs: 1, timeoutMs: 1500 });
const noDiscussion = async (q: string) => ({ query: q, items: [], skipped: [] });

beforeAll(async () => {
  ({ server, baseUrl: base } = await startMockSites());
});
afterAll(() => {
  server.close();
});

describe("requirement grounding and priority (code decides, not the model)", () => {
  it("accepts verbatim and lightly paraphrased evidence, rejects invented requirements", () => {
    expect(isGrounded(JD, "Strong Go experience")).toBe(true);
    expect(isGrounded(JD, "strong GO experience!")).toBe(true);
    expect(isGrounded(JD, "10 years of COBOL")).toBe(false);
  });

  it("reads priority from the line and the heading it sits under", () => {
    expect(decidePriority(JD, "Kafka", "must")).toBe("nice");
    expect(decidePriority(JD, "Strong Go experience", "nice")).toBe("must");
    expect(decidePriority("Skills\n- Rust (a plus)\n- SQL", "Rust (a plus)", "must")).toBe("nice");
    expect(decidePriority("Bonus points for:\n- GraphQL\n- Rust", "Rust", "must")).toBe("nice");
  });

  it("falls back to the model when the posting gives no signal", () => {
    expect(decidePriority("We use Elixir and Postgres.", "Elixir", "nice")).toBe("nice");
  });
});

describe("planCategories", () => {
  const ctxProcess = (system_design: boolean) => ({
    source_url: null,
    summary: "",
    stages: [],
    formats: { take_home: false, system_design, live_coding: false, behavioural: false },
    discussion: [],
  });

  it("adds a system-design round only when the process, seniority or requirements call for it", () => {
    const reqs = [{ id: "r1", text: "React", kind: "technical" as const, priority: "must" as const }];
    expect(planCategories(reqs, "mid", null).map((p) => p.category)).toEqual(["technical", "company-fit"]);
    expect(planCategories(reqs, "mid", ctxProcess(true)).map((p) => p.category)).toContain("system-design");
    expect(planCategories(reqs, "senior", null).map((p) => p.category)).toContain("system-design");
  });

  it("sends technical requirements and behavioural requirements to different calls", () => {
    const plans = planCategories(requirements, "mid", null);
    expect(plans.find((p) => p.category === "technical")!.requirements.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(plans.find((p) => p.category === "behavioural")!.requirements.map((r) => r.id)).toEqual(["r2"]);
    expect(plans.find((p) => p.category === "company-fit")!.requirements.map((r) => r.id)).toEqual(["r4"]);
  });

  it("produces a small honest plan for a posting with no requirements", () => {
    const plans = planCategories([], "unspecified", null);
    expect(plans.every((p) => p.requirements.length === 0)).toBe(true);
  });
});

describe("detectFormats", () => {
  it("decides interview formats from evidence in the text", () => {
    expect(detectFormats("Stage 2: take-home exercise. Stage 3: system design interview.")).toMatchObject({ take_home: true, system_design: true, live_coding: false });
    expect(detectFormats("We sell books.")).toEqual({ take_home: false, system_design: false, live_coding: false, behavioural: false });
  });
});

describe("closeCoverageGaps", () => {
  const ctx: QuestionContext = { roleTitle: "Eng", seniority: "mid", companyName: "Acme", briefSummary: "", process: null };

  it("finds a gap, generates the missing question, and checks again", async () => {
    const { llm, calls } = scriptedLlm(happyHandlers());
    const result = await closeCoverageGaps(requirements, [question("q1", ["r1"]), question("q2", ["r3"])], ctx, llm);
    expect(result.history[0]).toEqual(["r2", "r4"]);
    expect(result.passes).toBe(2);
    expect(result.report.uncovered).toEqual([]);
    expect(calls.map((c) => c.task).sort()).toEqual(["gap:behavioural", "gap:company-fit"]);
    expect(result.fallbackFor).toEqual([]);
  });

  it("stops after the maximum passes and adds code-built questions for remaining must-haves", async () => {
    const { llm } = scriptedLlm({ gap: () => ({ questions: [] }) });
    const result = await closeCoverageGaps(requirements, [], ctx, llm);
    expect(result.passes).toBe(3);
    expect(result.fallbackFor).toEqual(["r1", "r2"]);
    expect(result.report.uncoveredMust).toEqual([]);
    expect(result.report.uncovered).toEqual(["r3", "r4"]); // nice-to-haves may remain, and are reported
  });

  it("survives a failing gap call and still never leaves a must-have uncovered", async () => {
    const { llm } = scriptedLlm({});
    const result = await closeCoverageGaps(requirements, [], ctx, llm);
    expect(result.gapErrors).toHaveLength(1);
    expect(result.report.uncoveredMust).toEqual([]);
  });
});

describe("generateKit end to end (scripted model, mock sites)", () => {
  it("builds a valid kit through every step and closes a coverage gap on the second pass", async () => {
    const { llm, calls } = scriptedLlm(happyHandlers());
    const events: ProgressEvent[] = [];
    const { kit, research } = await generateKit(
      { jd: JD, companyUrl: `${base}/acme/`, days: 4 },
      { llm, fetcher: fetcher(), searchDiscussion: noDiscussion },
      (e) => events.push(e),
    );

    expect(validateKit(kit).ok).toBe(true);
    // invented requirement dropped, mislabelled priority corrected from the posting
    expect(kit.role.requirements.map((r) => r.text)).not.toContain("10 years of COBOL");
    expect(kit.role.requirements.find((r) => r.text === "Kafka")!.priority).toBe("nice");
    expect(kit.notes!.join(" ")).toMatch(/Discarded 1 requirement/);
    // research really happened and steered generation
    expect(research.crawl.hiringPageUrl).toBe(`${base}/acme/handbook/people/hiring-process.html`);
    expect(kit.interview_process!.formats.system_design).toBe(true);
    const categoryCalls = calls.filter((c) => c.task.startsWith("questions:")).map((c) => c.task);
    expect(categoryCalls).toEqual(["questions:technical", "questions:system-design", "questions:behavioural", "questions:company-fit"]);
    expect(calls.find((c) => c.task === "questions:technical")!.user).toMatch(/take-home/);
    // the coverage loop found r2 missing and closed it
    expect(kit.coverage.passes).toBe(2);
    expect(kit.coverage.uncovered_requirement_ids).toEqual([]);
    expect(events.some((e) => e.step === "coverage" && /Pass 1: 1 uncovered \(r2\)/.test(e.message))).toBe(true);
    // schedule honours the requested days and difficulty strings were coerced to ints
    expect(kit.schedule.days).toHaveLength(4);
    expect(kit.questions.every((q) => q.difficulty === 3 || q.difficulty === 2)).toBe(true);
  });

  it("produces an honest kit when the company site is unreachable", async () => {
    const { llm } = scriptedLlm(happyHandlers());
    const { kit } = await generateKit({ jd: JD, companyUrl: `${base}/gone/`, days: 1 }, { llm, fetcher: fetcher(), searchDiscussion: noDiscussion });
    expect(kit.company_brief.summary).toMatch(/could not retrieve/i);
    expect(kit.company_brief.sources).toEqual([]);
    expect(kit.notes!.join(" ")).toMatch(/HTTP 404/);
    expect(kit.schedule.days).toHaveLength(1);
  });

  it("fails only when there is nothing to build on (extraction impossible)", async () => {
    const { llm } = scriptedLlm({});
    await expect(generateKit({ jd: JD, companyUrl: `${base}/acme/`, days: 3 }, { llm, fetcher: fetcher(), searchDiscussion: noDiscussion })).rejects.toMatchObject({
      code: "LLM_PROVIDER_UNAVAILABLE",
    });
  });

  it("rejects bad input before doing any work", async () => {
    const { llm, calls } = scriptedLlm(happyHandlers());
    await expect(generateKit({ jd: "  ", companyUrl: "x", days: 3 }, { llm, fetcher: fetcher() })).rejects.toBeInstanceOf(PipelineError);
    await expect(generateKit({ jd: JD, companyUrl: "x", days: 0 }, { llm, fetcher: fetcher() })).rejects.toThrow(/days/);
    expect(calls).toHaveLength(0);
  });
});

describe("lenient model-output parsing", () => {
  it("flattens object list items to strings instead of failing validation", async () => {
    const { stringList, textOrList, difficulty } = await import("../src/pipeline/zodHelpers.js");
    expect(stringList.parse([{ fact: "Founded 2017", source: "x" }, "plain"])).toEqual(["Founded 2017", "plain"]);
    expect(textOrList.parse(["a", "- b"])).toBe("- a\n- b");
    expect(difficulty.parse("3")).toBe(3);
    expect(difficulty.parse(9)).toBe(3);
  });
});
