import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AuthService, requireAuth, SESSION_COOKIE, sessionCookieOptions, type AuthedRequest } from "../auth/auth.js";
import type { KitDocument, KitRepository } from "../db/kitRepository.js";
import { buildSchedule } from "../domain/scheduler.js";
import { applyOps, KitOp, unscheduledQuestionIds } from "../domain/kitOps.js";
import { orderSession, recordReview, summarizePractice } from "../domain/practice.js";
import { QuestionCategory } from "../domain/schema.js";
import { validateKit } from "../domain/validateKit.js";
import type { JobRunner } from "../jobs/jobRunner.js";
import { MAX_DAYS, MIN_DAYS } from "../pipeline/generateKit.js";
import { parseHttpUrl } from "../retrieval/urlSafety.js";
import { ApiError, errorHandler } from "./errors.js";

export interface AppDeps {
  auth: AuthService;
  kits: KitRepository;
  jobs: JobRunner;
  /** Origin of the web app, for CORS when it calls the API directly rather than through its proxy. */
  webOrigin?: string;
}

const Credentials = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

const KitInput = z.object({
  jd: z.string().trim().min(10, "Paste the job description (at least a line or two)").max(30_000),
  company_url: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .transform((v, ctx) => {
      try {
        return parseHttpUrl(v).href;
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message });
        return z.NEVER;
      }
    }),
  days: z.coerce.number().int().min(MIN_DAYS).max(MAX_DAYS),
});

const MAX_ACTIVE_GENERATIONS_PER_USER = 6;

/** Wrap async handlers so rejections reach the error middleware. */
const h =
  (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req as AuthedRequest, res).catch(next);

/** What the browser sees: no internal keys, no raw page texts. */
export function toClient(doc: KitDocument) {
  const now = new Date();
  return {
    id: doc._id.toHexString(),
    status: doc.status,
    input: doc.input,
    progress: doc.progress,
    kit: doc.kit,
    error: doc.error,
    version: doc.version,
    regenerating: doc.regenerating.map(({ section, startedAt }) => ({ section, startedAt })),
    regenerationErrors: doc.regenerationErrors,
    practice: doc.practice,
    practiceSummary: doc.kit ? summarizePractice(doc.kit.flashcards, doc.practice, doc.kit.role.requirements, now) : null,
    unscheduled: doc.kit ? unscheduledQuestionIds(doc.kit) : [],
    stories: doc.stories,
    hasPreviousBrief: doc.previousBrief !== null,
    research: doc.research
      ? {
          pages: doc.research.crawl.pages.map((p) => ({ url: p.url, title: p.title, kind: p.kind })),
          skipped: doc.research.crawl.skipped,
          hiringPageUrl: doc.research.crawl.hiringPageUrl,
          discussionSearched: doc.research.discussion.query,
          discussionSkipped: doc.research.discussion.skipped,
        }
      : null,
    interviewAt: doc.interviewAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Tiny fixed-window limiter for auth endpoints (per IP). Enough to stop password guessing loops. */
function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) hits.set(key, { count: 1, resetAt: now + windowMs });
    else if (++entry.count > limit) return next(new ApiError(429, "TOO_MANY_REQUESTS", "Too many attempts. Wait a minute and try again."));
    if (hits.size > 10_000) hits.clear();
    next();
  };
}

export function createApp({ auth, kits, jobs, webOrigin }: AppDeps) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const origin = req.headers.origin;
    if (webOrigin && origin === webOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") return res.status(204).end();
    }
    // Request bodies must be JSON: an HTML form on another site cannot send that (CSRF defence alongside SameSite=Lax).
    const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
    if (hasBody && !req.is("application/json")) return next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON."));
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true, queuedJobs: jobs.queued }));

  // ---------------------------------------------------------------- auth
  const authLimiter = rateLimit(20, 60_000);
  app.post(
    "/api/auth/register",
    authLimiter,
    h(async (req, res) => {
      const { email, password } = Credentials.parse(req.body);
      const user = await auth.register(email, password);
      const session = await auth.createSession(user.id);
      res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
      res.status(201).json({ user });
    }),
  );
  app.post(
    "/api/auth/login",
    authLimiter,
    h(async (req, res) => {
      const { email, password } = Credentials.extend({ password: z.string().min(1).max(200) }).parse(req.body);
      const user = await auth.login(email, password);
      const session = await auth.createSession(user.id);
      res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
      res.json({ user });
    }),
  );
  app.post(
    "/api/auth/logout",
    h(async (req, res) => {
      const token = (req.cookies as Record<string, string>)[SESSION_COOKIE];
      if (token) await auth.destroySession(token);
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
      res.json({ ok: true });
    }),
  );

  const authed = requireAuth(auth);
  app.get("/api/auth/me", authed, (req, res) => res.json({ user: (req as AuthedRequest).user }));

  // ---------------------------------------------------------------- kits
  const loadKit = async (req: AuthedRequest) => {
    const doc = await kits.findForUser(String(req.params.id), req.user.id);
    if (!doc) throw new ApiError(404, "NOT_FOUND", "Kit not found.");
    return doc;
  };
  const requireReady = (doc: KitDocument) => {
    if (doc.status !== "ready" || !doc.kit) throw new ApiError(409, "KIT_NOT_READY", "The kit is still being generated.");
    return doc.kit;
  };

  app.get(
    "/api/kits",
    authed,
    h(async (req, res) => {
      const docs = await kits.listForUser(req.user.id);
      res.json({
        kits: docs.map((d) => ({
          id: d._id.toHexString(),
          status: d.status,
          title: d.kit?.role.title ?? firstLine(d.input.jd),
          company: d.kit?.source.company ?? hostOf(d.input.companyUrl),
          days: d.input.days,
          requirements: d.kit?.role.requirements.length ?? null,
          lastProgress: d.progress.at(-1) ?? null,
          error: d.error,
          createdAt: d.createdAt,
        })),
      });
    }),
  );

  async function startKit(userId: string, input: z.infer<typeof KitInput>) {
    const { doc, duplicate } = await kits.createOrFind(userId, { jd: input.jd, companyUrl: input.company_url, days: input.days });
    if (!duplicate) jobs.enqueueGeneration(doc._id);
    return { id: doc._id.toHexString(), duplicate, status: doc.status };
  }

  async function assertCapacity(userId: string, adding: number) {
    const active = (await kits.listForUser(userId)).filter((d) => d.status === "queued" || d.status === "running").length;
    if (active + adding > MAX_ACTIVE_GENERATIONS_PER_USER) {
      throw new ApiError(429, "TOO_MANY_GENERATIONS", `You have ${active} kit(s) generating. Wait for some to finish (limit ${MAX_ACTIVE_GENERATIONS_PER_USER}).`);
    }
  }

  app.post(
    "/api/kits",
    authed,
    h(async (req, res) => {
      const input = KitInput.parse(req.body);
      await assertCapacity(req.user.id, 1);
      const result = await startKit(req.user.id, input);
      res.status(result.duplicate ? 200 : 202).json(result);
    }),
  );

  /** Several roles at once (from an uploaded file). Each item succeeds or fails on its own. */
  app.post(
    "/api/kits/batch",
    authed,
    h(async (req, res) => {
      const { items } = z.object({ items: z.array(z.unknown()).min(1).max(10) }).parse(req.body);
      await assertCapacity(req.user.id, items.length);
      const results = [];
      for (const [index, item] of items.entries()) {
        const parsed = KitInput.safeParse(item);
        if (!parsed.success) {
          results.push({ index, error: { code: "VALIDATION_FAILED", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } });
          continue;
        }
        results.push({ index, ...(await startKit(req.user.id, parsed.data)) });
      }
      res.status(202).json({ results });
    }),
  );

  app.get(
    "/api/kits/:id",
    authed,
    h(async (req, res) => res.json(toClient(await loadKit(req)))),
  );

  app.delete(
    "/api/kits/:id",
    authed,
    h(async (req, res) => {
      if (!(await kits.deleteForUser(String(req.params.id), req.user.id))) throw new ApiError(404, "NOT_FOUND", "Kit not found.");
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/kits/:id/retry",
    authed,
    h(async (req, res) => {
      const doc = await loadKit(req);
      if (doc.status !== "failed") throw new ApiError(409, "NOT_FAILED", "Only a failed kit can be retried.");
      if (!(await kits.requeue(doc))) throw new ApiError(409, "DUPLICATE", "An identical kit is already being generated.");
      jobs.enqueueGeneration(doc._id);
      res.status(202).json({ id: doc._id.toHexString(), status: "queued" });
    }),
  );

  /** Builder edits: an ordered list of ops applied to the latest stored kit. */
  app.post(
    "/api/kits/:id/ops",
    authed,
    h(async (req, res) => {
      const { ops } = z.object({ ops: z.array(KitOp).min(1).max(100) }).parse(req.body);
      const doc = await loadKit(req);
      requireReady(doc);
      const updated = await kits.update(doc._id, (latest) => {
        const kit = applyOps(latest.kit!, ops);
        const v = validateKit(kit);
        if (!v.ok) throw new ApiError(422, "INVALID_EDIT", v.errors.slice(0, 3).join("; "));
        return { kit };
      });
      res.json(toClient(updated));
    }),
  );

  /** Regenerate one section. Brief and categories run in the background; the schedule is instant arithmetic. */
  app.post(
    "/api/kits/:id/regenerate",
    authed,
    h(async (req, res) => {
      const body = z
        .discriminatedUnion("section", [
          z.object({ section: z.literal("brief") }),
          z.object({ section: z.literal("category"), category: QuestionCategory }),
          z.object({ section: z.literal("schedule"), days: z.number().int().min(MIN_DAYS).max(MAX_DAYS).optional() }),
        ])
        .parse(req.body);
      const doc = await loadKit(req);
      const kit = requireReady(doc);

      if (body.section === "schedule") {
        const days = body.days ?? doc.input.days;
        const updated = await kits.update(doc._id, (latest) => ({
          kit: { ...latest.kit!, schedule: buildSchedule({ requirements: latest.kit!.role.requirements, questions: latest.kit!.questions, days }) },
          input: { ...latest.input, days },
          interviewAt: days !== latest.input.days ? new Date(Date.now() + days * 86_400_000).toISOString() : latest.interviewAt,
        }));
        return res.json(toClient(updated));
      }

      const section = body.section === "brief" ? "brief" : `category:${body.category}`;
      if (doc.regenerating.some((r) => r.section === section)) throw new ApiError(409, "ALREADY_REGENERATING", "That section is already being regenerated.");
      if (body.section === "brief" && kit.company_brief.state?.pinned) throw new ApiError(409, "PINNED", "Unpin the brief to regenerate it.");
      if (body.section === "brief") void jobs.regenerateBrief(doc);
      else void jobs.regenerateCategory(doc, body.category);
      res.status(202).json({ ok: true, section });
    }),
  );

  app.post(
    "/api/kits/:id/brief/undo",
    authed,
    h(async (req, res) => {
      const doc = await loadKit(req);
      requireReady(doc);
      if (!doc.previousBrief) throw new ApiError(409, "NOTHING_TO_UNDO", "There is no previous brief.");
      const updated = await kits.update(doc._id, (latest) => ({
        kit: { ...latest.kit!, company_brief: latest.previousBrief! },
        previousBrief: latest.kit!.company_brief,
      }));
      res.json(toClient(updated));
    }),
  );

  // ---------------------------------------------------------------- practice
  app.get(
    "/api/kits/:id/practice/session",
    authed,
    h(async (req, res) => {
      const doc = await loadKit(req);
      const kit = requireReady(doc);
      res.json({ order: orderSession(kit.flashcards, doc.practice, new Date()).map((c) => c.id) });
    }),
  );

  app.post(
    "/api/kits/:id/practice",
    authed,
    h(async (req, res) => {
      const { cardId, confidence } = z.object({ cardId: z.string().min(1).max(40), confidence: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }).parse(req.body);
      const doc = await loadKit(req);
      const kit = requireReady(doc);
      if (!kit.flashcards.some((f) => f.id === cardId)) throw new ApiError(404, "NOT_FOUND", "Flashcard not found.");
      const updated = await kits.update(doc._id, (latest) => ({
        practice: { ...latest.practice, [cardId]: recordReview(latest.practice[cardId], confidence, new Date(), new Date(latest.interviewAt)) },
      }));
      res.json({ progress: updated.practice[cardId], summary: toClient(updated).practiceSummary });
    }),
  );

  app.post(
    "/api/kits/:id/practice/reset",
    authed,
    h(async (req, res) => {
      const doc = await loadKit(req);
      const updated = await kits.update(doc._id, () => ({ practice: {} }));
      res.json(toClient(updated));
    }),
  );

  // ---------------------------------------------------------------- story bank (creative feature)
  const Story = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    title: z.string().trim().min(1).max(200),
    situation: z.string().max(4000).default(""),
    action: z.string().max(4000).default(""),
    result: z.string().max(4000).default(""),
    requirement_ids: z.array(z.string().max(40)).max(30).default([]),
  });
  app.put(
    "/api/kits/:id/stories",
    authed,
    h(async (req, res) => {
      const { stories } = z.object({ stories: z.array(Story).max(50) }).parse(req.body);
      const doc = await loadKit(req);
      const kit = requireReady(doc);
      const known = new Set(kit.role.requirements.map((r) => r.id));
      const updated = await kits.update(doc._id, () => ({ stories: stories.map((s) => ({ ...s, requirement_ids: s.requirement_ids.filter((id) => known.has(id)) })) }));
      res.json(toClient(updated));
    }),
  );

  app.use("/api", (_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "No such endpoint.")));
  app.use(errorHandler);
  return app;
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 100);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
