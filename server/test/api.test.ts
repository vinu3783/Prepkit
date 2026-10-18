import type { Server } from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { createApp } from "../src/api/app.js";
import { AuthService } from "../src/auth/auth.js";
import { KitRepository } from "../src/db/kitRepository.js";
import { connectDatabase, type Database } from "../src/db/mongo.js";
import { JobRunner } from "../src/jobs/jobRunner.js";
import type { JsonRequest, LlmClient } from "../src/llm/client.js";
import { PageFetcher } from "../src/retrieval/fetchPage.js";
import { startMockSites } from "../src/scripts/mockSites.js";

/** Scripted model: deterministic answers by task; category regeneration can be held open to simulate a slow call. */
let releaseRegeneration: (() => void) | null = null;
const llm = {
  async generateJson(req: JsonRequest<z.ZodTypeAny>) {
    const ids = [...req.user.matchAll(/- (r\d+) \[/g)].map((m) => m[1]!);
    const answers: Record<string, () => unknown> = {
      "extract-requirements": () => ({
        company: "Acme",
        title: "Backend Engineer",
        seniority: "mid",
        location: "",
        about_company: "",
        responsibilities: [],
        requirements: [
          { text: "Go", kind: "technical", priority: "must", quote: "Go" },
          { text: "Mentoring", kind: "behavioural", priority: "must", quote: "mentoring" },
        ],
      }),
      "company-brief": () => ({ summary: "Acme does payouts.", what_they_do: "Payouts.", key_facts: [], used_urls: [] }),
      "interview-process": () => ({ summary: "", stages: [], relevant_discussion_urls: [] }),
      flashcards: () => ({ flashcards: [{ requirement_ids: ["r1"], front: "Goroutines?", back: "Lightweight threads." }] }),
    };
    if (req.task.startsWith("questions:") || req.task.startsWith("gap:")) {
      const isRegen = /do not repeat/.test(req.user) || /New wave/.test(req.user);
      if (isRegen && releaseRegeneration === null) await new Promise<void>((r) => (releaseRegeneration = r));
      return req.schema.parse({
        questions: (ids.length ? ids : [""]).map((id, i) => ({
          requirement_ids: id ? [id] : [],
          prompt: `${isRegen ? "Regenerated" : "Original"} ${req.task} ${id} #${i}`,
          answer_outline: "x",
          difficulty: 2,
        })),
      });
    }
    return req.schema.parse(answers[req.task]!());
  },
} as unknown as LlmClient;

let database: Database;
let memory: MongoMemoryServer;
let sites: Server;
let siteBase: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  memory = await MongoMemoryServer.create();
  database = await connectDatabase(memory.getUri());
  ({ server: sites, baseUrl: siteBase } = await startMockSites());
  const kits = new KitRepository(database.db);
  const fetcher = new PageFetcher({ policy: { allowPrivateHosts: true }, perHostIntervalMs: 0, timeoutMs: 1500, backoffMs: 1 });
  const jobs = new JobRunner(kits, { llm, fetcher, searchDiscussion: async (q) => ({ query: q, items: [], skipped: [] }) });
  app = createApp({ auth: new AuthService(database.db), kits, jobs });
}, 120_000);

afterAll(async () => {
  sites?.close();
  await database?.close();
  await memory?.stop();
});

async function signUp(email: string) {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  return agent;
}

async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (done(v) || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const JD = "Backend Engineer at Acme\nRequirements:\n- Go\n- mentoring juniors";

describe("auth", () => {
  it("blocks signed-out access to protected endpoints", async () => {
    const res = await request(app).get("/api/kits").expect(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("reports an invalid/expired session distinctly and clears the cookie", async () => {
    const res = await request(app).get("/api/kits").set("Cookie", "pk_session=forged").expect(401);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/pk_session=;/);
  });

  it("rejects bad credentials without revealing whether the email exists", async () => {
    await signUp("a@example.com");
    const wrong = await request(app).post("/api/auth/login").send({ email: "a@example.com", password: "nope-nope" }).expect(401);
    const unknown = await request(app).post("/api/auth/login").send({ email: "zz@example.com", password: "nope-nope" }).expect(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("refuses non-JSON bodies (CSRF via HTML forms)", async () => {
    await request(app).post("/api/auth/login").type("form").send("email=a@example.com&password=x").expect(415);
  });
});

describe("kits", () => {
  it("generates a kit in the background, isolates users, and de-duplicates resubmits", async () => {
    const alice = await signUp("alice@example.com");
    const bob = await signUp("bob@example.com");

    const created = await alice.post("/api/kits").send({ jd: JD, company_url: `${siteBase}/acme/`, days: 3 }).expect(202);
    const again = await alice.post("/api/kits").send({ jd: JD, company_url: `${siteBase}/acme/`, days: 3 }).expect(200);
    expect(again.body).toMatchObject({ id: created.body.id, duplicate: true });

    const kit = await waitFor(
      () => alice.get(`/api/kits/${created.body.id}`).then((r) => r.body),
      (b) => b.status === "ready" || b.status === "failed",
    );
    expect(kit.status).toBe("ready");
    expect(kit.progress.some((p: { step: string }) => p.step === "coverage")).toBe(true);
    expect(kit.kit.schedule.days).toHaveLength(3);

    await bob.get(`/api/kits/${created.body.id}`).expect(404);
    await bob.post(`/api/kits/${created.body.id}/ops`).send({ ops: [{ type: "deleteQuestion", id: "q1" }] }).expect(404);
    expect((await bob.get("/api/kits")).body.kits).toEqual([]);
  });

  it("validates input with field-level messages", async () => {
    const agent = await signUp("val@example.com");
    const res = await agent.post("/api/kits").send({ jd: "x", company_url: "ftp://nope", days: 0 }).expect(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["company_url", "days", "jd"]);
  });

  it("accepts a batch of roles and reports bad items individually", async () => {
    const agent = await signUp("batch@example.com");
    const res = await agent
      .post("/api/kits/batch")
      .send({ items: [{ jd: JD, company_url: `${siteBase}/quietco/`, days: 2 }, { jd: "", company_url: "x", days: 2 }] })
      .expect(202);
    expect(res.body.results[0].id).toBeTruthy();
    expect(res.body.results[1].error.code).toBe("VALIDATION_FAILED");
  });
});

describe("builder over the API", () => {
  it("applies edits, then regenerates a category without losing an edit made mid-regeneration", async () => {
    const agent = await signUp("builder@example.com");
    const { body } = await agent.post("/api/kits").send({ jd: JD, company_url: `${siteBase}/tiny/`, days: 2 }).expect(202);
    const ready = await waitFor(
      () => agent.get(`/api/kits/${body.id}`).then((r) => r.body),
      (b) => b.status === "ready",
    );
    const technical = ready.kit.questions.filter((q: { category: string }) => q.category === "technical");
    const [first, second] = technical;

    // Edit one question before regenerating, and add one by hand.
    await agent
      .post(`/api/kits/${body.id}/ops`)
      .send({
        ops: [
          { type: "updateQuestion", id: first.id, patch: { prompt: "Edited before regeneration" } },
          { type: "addQuestion", question: { id: "u-mine", category: "technical", prompt: "Written by me", requirement_ids: ["r1"] } },
        ],
      })
      .expect(200);

    releaseRegeneration = null;
    await agent.post(`/api/kits/${body.id}/regenerate`).send({ section: "category", category: "technical" }).expect(202);
    await waitFor(async () => releaseRegeneration, (r) => r !== null);
    // While the model is "thinking", edit another generated question.
    if (second) await agent.post(`/api/kits/${body.id}/ops`).send({ ops: [{ type: "updateQuestion", id: second.id, patch: { answer_outline: "typed mid-flight" } }] }).expect(200);
    await agent.post(`/api/kits/${body.id}/regenerate`).send({ section: "category", category: "technical" }).expect(409);
    releaseRegeneration!();

    const after = await waitFor(
      () => agent.get(`/api/kits/${body.id}`).then((r) => r.body),
      (b) => b.regenerating.length === 0,
    );
    const prompts = after.kit.questions.map((q: { prompt: string }) => q.prompt);
    expect(prompts).toContain("Edited before regeneration");
    expect(prompts).toContain("Written by me");
    expect(prompts.some((p: string) => p.startsWith("Regenerated"))).toBe(true);
    if (second) expect(after.kit.questions.find((q: { id: string }) => q.id === second.id).answer_outline).toBe("typed mid-flight");
    expect(after.kit.questions.filter((q: { category: string }) => q.category === "behavioural").length).toBeGreaterThan(0);
    expect(after.kit.coverage.uncovered_requirement_ids).toEqual([]);
  });

  it("records practice and orders the next session by confidence", async () => {
    const agent = await signUp("practice@example.com");
    const { body } = await agent.post("/api/kits").send({ jd: JD, company_url: `${siteBase}/tiny/`, days: 4 }).expect(202);
    const ready = await waitFor(
      () => agent.get(`/api/kits/${body.id}`).then((r) => r.body),
      (b) => b.status === "ready",
    );
    const card = ready.kit.flashcards[0].id;
    const res = await agent.post(`/api/kits/${body.id}/practice`).send({ cardId: card, confidence: 1 }).expect(200);
    expect(res.body.summary.covered).toBe(1);
    await agent.post(`/api/kits/${body.id}/practice`).send({ cardId: card, confidence: 9 }).expect(400);
  });
});
