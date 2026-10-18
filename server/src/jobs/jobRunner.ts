import type { ObjectId } from "mongodb";
import type { KitDocument, KitRepository } from "../db/kitRepository.js";
import { checkCoverage } from "../domain/coverage.js";
import { mergeCategoryRegeneration, replaceableInCategory, keptPromptsInCategory, highWater } from "../domain/regenerate.js";
import type { QuestionCategory } from "../domain/schema.js";
import { validateKit } from "../domain/validateKit.js";
import { LlmError } from "../llm/errors.js";
import { writeCompanyBrief } from "../pipeline/companyResearch.js";
import { generateKit, PipelineError, type PipelineDeps } from "../pipeline/generateKit.js";
import { categoryForKind, fallbackQuestion, generateCategoryQuestions, generateGapQuestions, planCategories } from "../pipeline/questions.js";
import type { CrawlResult } from "../retrieval/crawler.js";

/**
 * In-process background work. Generation is slow (often 60-120s on free tiers),
 * so requests return immediately and the UI polls the kit document, which carries
 * a progress log. At most `maxConcurrent` generations run at once so one user
 * cannot exhaust the shared LLM budget; the rest wait in a FIFO queue.
 *
 * Trade-off: a process restart loses in-flight jobs. They are marked INTERRUPTED
 * on startup and the user can retry. A real queue (e.g. BullMQ) would survive
 * restarts but needs Redis, which the free deployment does not have.
 */
export class JobRunner {
  private readonly queue: ObjectId[] = [];
  private running = 0;

  constructor(
    private readonly repo: KitRepository,
    private readonly deps: PipelineDeps,
    private readonly maxConcurrent = 2,
  ) {}

  enqueueGeneration(id: ObjectId): void {
    this.queue.push(id);
    this.pump();
  }

  get queued(): number {
    return this.queue.length + this.running;
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!;
      this.running++;
      this.runGeneration(id)
        .catch((err: unknown) => console.error("generation crashed", err))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private async runGeneration(id: ObjectId): Promise<void> {
    const doc = await this.repo.findById(id);
    if (!doc) return;
    await this.repo.set(id, { status: "running", progress: [], error: null });
    try {
      const { kit, research } = await generateKit(doc.input, this.deps, (event) => {
        void this.repo.pushProgress(id, event);
      });
      await this.repo.update(id, () => ({ status: "ready", kit, research, error: null, questionIdFloor: highWater(kit.questions) }));
    } catch (err) {
      const code = err instanceof PipelineError ? err.code : err instanceof LlmError ? `LLM_${err.code}` : "INTERNAL_ERROR";
      const message = friendlyMessage(code, (err as Error).message);
      await this.repo.markFailed(id, { code, message });
    }
  }

  /** Rewrite the company brief from stored research. Refuses (records an error) if the brief was pinned meanwhile. */
  async regenerateBrief(doc: KitDocument): Promise<void> {
    const section = "brief" as const;
    if (!doc.kit || !doc.research) return;
    await this.repo.update(doc._id, (d) => ({ regenerating: [...d.regenerating, { section, startedAt: new Date().toISOString() }] }));
    try {
      const r = doc.research;
      const brief = await writeCompanyBrief(
        { companyName: r.companyName, companyUrl: r.crawl.startUrl, aboutFromJd: r.extraction.aboutCompany, crawl: r.crawl as CrawlResult },
        this.deps.llm,
      );
      await this.repo.update(doc._id, (latest) => {
        const kit = structuredClone(latest.kit!);
        const done = latest.regenerating.filter((x) => x.section !== section);
        if (kit.company_brief.state?.pinned) {
          return { regenerating: done, regenerationErrors: pushError(latest, section, "The brief was pinned while regenerating, so it was kept.") };
        }
        const previousBrief = kit.company_brief;
        kit.company_brief = { ...brief, state: { edited: false, pinned: false } };
        kit.source.pages_used = [...new Set([...kit.source.pages_used, ...brief.sources])];
        return { kit: assertValid(kit), previousBrief, regenerating: done };
      });
    } catch (err) {
      await this.failRegeneration(doc._id, section, err);
    }
  }

  /**
   * Regenerate one question category without touching hand-written, edited or
   * pinned questions (see domain/regenerate.ts). If replacing the category leaves
   * one of its must-have requirements uncovered, gap questions are generated before
   * the merge, so a regeneration never breaks the coverage guarantee.
   */
  async regenerateCategory(doc: KitDocument, category: QuestionCategory): Promise<void> {
    const section = `category:${category}` as const;
    if (!doc.kit || !doc.research) return;
    const replaceable = replaceableInCategory(doc.kit, category);
    await this.repo.update(doc._id, (d) => ({ regenerating: [...d.regenerating, { section, startedAt: new Date().toISOString(), replaceable }] }));

    try {
      const { kit } = doc;
      const ctx = doc.research.context;
      const plans = planCategories(kit.role.requirements, kit.role.seniority, ctx.process);
      const plan = plans.find((p) => p.category === category) ?? {
        category,
        requirements: kit.role.requirements.filter((r) => categoryForKind(r.kind) === category),
        count: 3,
      };
      // Kept questions count towards the category's size, so regenerating does not keep growing it.
      const kept = keptPromptsInCategory(kit, category);
      const drafts = await generateCategoryQuestions({ ...plan, count: Math.max(2, plan.count - kept.length) }, ctx, this.deps.llm, kept);

      // Predict coverage after the merge; fill any must-have this category would lose.
      const preview = mergeCategoryRegeneration(kit, category, replaceable, drafts, doc.questionIdFloor).kit;
      const lost = checkCoverage(preview.role.requirements, preview.questions).uncoveredMust
        .map((id) => preview.role.requirements.find((r) => r.id === id)!)
        .filter((r) => categoryForKind(r.kind) === category);
      const gapDrafts = lost.length ? await generateGapQuestions(lost, ctx, this.deps.llm).catch(() => []) : [];
      const stillLost = lost.filter((r) => !gapDrafts.some((d) => d.requirement_ids.includes(r.id)));
      const all = [...drafts, ...gapDrafts, ...stillLost.map(fallbackQuestion)].map((d) => ({ ...d, category }));

      await this.repo.update(doc._id, (latest) => {
        const merged = mergeCategoryRegeneration(latest.kit!, category, replaceable, all, latest.questionIdFloor);
        return {
          kit: assertValid(merged.kit),
          questionIdFloor: merged.idFloor,
          regenerating: latest.regenerating.filter((x) => x.section !== section),
        };
      });
    } catch (err) {
      await this.failRegeneration(doc._id, section, err);
    }
  }

  private async failRegeneration(id: ObjectId, section: string, err: unknown): Promise<void> {
    const message = err instanceof LlmError ? friendlyMessage(`LLM_${err.code}`, err.message) : (err as Error).message;
    await this.repo.update(id, (latest) => ({
      regenerating: latest.regenerating.filter((x) => x.section !== section),
      regenerationErrors: pushError(latest, section, message),
    }));
  }
}

function pushError(doc: KitDocument, section: string, message: string) {
  return [...doc.regenerationErrors, { section, message, at: new Date().toISOString() }].slice(-10);
}

function assertValid<T>(kit: T): T {
  const v = validateKit(kit);
  if (!v.ok) throw new Error(`Regenerated kit failed validation: ${v.errors.slice(0, 3).join("; ")}`);
  return kit;
}

function friendlyMessage(code: string, raw: string): string {
  switch (code) {
    case "LLM_RATE_LIMITED":
      return "The AI provider's free-tier limit was reached and retries ran out. Wait a minute and retry.";
    case "LLM_PROVIDER_UNAVAILABLE":
      return "The AI provider is temporarily unavailable. Retry in a moment.";
    case "LLM_PROVIDER_CONFIG":
      return "The AI provider is misconfigured on the server (API key or model).";
    case "LLM_INVALID_OUTPUT":
      return "The AI returned unusable output twice in a row. Retrying usually works.";
    default:
      return raw;
  }
}
