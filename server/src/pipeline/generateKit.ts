import { buildSchedule } from "../domain/scheduler.js";
import { nextId } from "../domain/ids.js";
import type { Flashcard, InterviewProcess, Kit, Question } from "../domain/schema.js";
import { validateKit } from "../domain/validateKit.js";
import type { LlmClient } from "../llm/client.js";
import { LlmError } from "../llm/errors.js";
import { crawlCompanySite, type CrawlResult } from "../retrieval/crawler.js";
import type { PageFetcher } from "../retrieval/fetchPage.js";
import { searchInterviewDiscussion, type DiscussionResult } from "../research/publicDiscussion.js";
import { analyseInterviewProcess, writeCompanyBrief, type CompanyBrief } from "./companyResearch.js";
import { closeCoverageGaps, MAX_COVERAGE_PASSES } from "./coverageLoop.js";
import { flashcardsFromQuestions, generateFlashcards } from "./flashcards.js";
import { extractRequirements, type ExtractedRole } from "./requirements.js";
import { CATEGORY_ORDER, generateCategoryQuestions, planCategories, type QuestionContext } from "./questions.js";

export interface GenerateInput {
  jd: string;
  companyUrl: string;
  days: number;
}

export interface PipelineDeps {
  llm: LlmClient;
  fetcher: PageFetcher;
  searchDiscussion?: (companyName: string) => Promise<DiscussionResult>;
  now?: () => Date;
}

export type StepStatus = "running" | "done" | "skipped" | "warning" | "failed";
export interface ProgressEvent {
  step: string;
  status: StepStatus;
  message: string;
  at: string;
}
export type ProgressFn = (event: ProgressEvent) => void;

/** Everything the research steps found, kept so one section can be regenerated without re-crawling. */
export interface ResearchBundle {
  companyName: string;
  extraction: Omit<ExtractedRole, "requirements">;
  crawl: Omit<CrawlResult, "pages"> & { pages: Omit<CrawlResult["pages"][number], "text">[] & { text: string }[] };
  discussion: DiscussionResult;
  context: QuestionContext;
}

export class PipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export const MIN_DAYS = 1;
export const MAX_DAYS = 365;

/**
 * The research and generation sequence. Each step responds to what the previous ones found:
 *
 *   extract requirements ─┐            (pasted text: no retrieval needed)
 *   crawl company site ───┴─> search public discussion (needs the company name)
 *                          ─> company brief  +  interview process (needs pages / discussion)
 *                          ─> questions, one call per category (plan depends on requirements + process)
 *                          ─> coverage check ⟲ gap fill (code decides gaps)
 *                          ─> flashcards ─> schedule (code) ─> validate (code)
 *
 * Only extraction is fatal: without it there is nothing to build a kit around.
 * Every other failure degrades the kit and is recorded in kit.notes.
 */
export async function generateKit(input: GenerateInput, deps: PipelineDeps, onProgress: ProgressFn = () => {}): Promise<{ kit: Kit; research: ResearchBundle }> {
  const now = deps.now ?? (() => new Date());
  const emit = (step: string, status: StepStatus, message: string) => onProgress({ step, status, message, at: now().toISOString() });
  const notes: string[] = [];

  const jd = input.jd.trim();
  if (!jd) throw new PipelineError("INVALID_INPUT", "The job description is empty.");
  if (!Number.isInteger(input.days) || input.days < MIN_DAYS || input.days > MAX_DAYS) {
    throw new PipelineError("INVALID_INPUT", `days must be an integer from ${MIN_DAYS} to ${MAX_DAYS}.`);
  }

  // 1. Extraction (model) and crawl (network) are independent: run them together.
  emit("extract", "running", "Reading the job description");
  emit("crawl", "running", `Crawling ${input.companyUrl}`);
  const [extractionResult, crawl] = await Promise.all([
    extractRequirements(jd, deps.llm).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    crawlCompanySite(input.companyUrl, deps.fetcher),
  ]);

  reportCrawl(crawl, emit, notes);
  if (!extractionResult.ok) {
    const err = extractionResult.error;
    emit("extract", "failed", (err as Error).message);
    const code = err instanceof LlmError ? `LLM_${err.code}` : "EXTRACTION_FAILED";
    throw new PipelineError(code, `Could not extract requirements: ${(err as Error).message}`);
  }
  const role = extractionResult.value;
  const musts = role.requirements.filter((r) => r.priority === "must").length;
  emit("extract", "done", `${role.requirements.length} requirements (${musts} must-have) for "${role.title}"`);
  if (jd.length < 200 || role.requirements.length < 3) {
    notes.push(
      `The job description is short (${jd.length} characters) and states ${role.requirements.length} requirement${role.requirements.length === 1 ? "" : "s"}. This kit is deliberately small rather than padded with guesses.`,
    );
  }
  if (role.dropped.length) {
    notes.push(`Discarded ${role.dropped.length} requirement(s) the posting does not actually state: ${role.dropped.slice(0, 5).join("; ")}.`);
  }

  const companyName = role.company || nameFromSite(crawl);

  // 2. Public discussion needs a name to search for.
  let discussion: DiscussionResult = { query: "", items: [], skipped: [] };
  if (companyName) {
    emit("discussion", "running", `Searching public discussion of ${companyName} interviews`);
    try {
      discussion = await (deps.searchDiscussion ?? searchInterviewDiscussion)(companyName);
    } catch (err) {
      discussion.skipped.push({ url: "search", reason: (err as Error).message });
    }
    emit("discussion", discussion.items.length ? "done" : "warning", discussion.items.length ? `${discussion.items.length} candidate discussion(s) found` : "No public discussion found");
  } else {
    emit("discussion", "skipped", "No company name to search for");
  }

  // 3. Brief and interview process use different sources: run together.
  emit("brief", "running", "Writing the company brief");
  emit("process", "running", "Working out the interview process");
  const [briefResult, processResult] = await Promise.allSettled([
    writeCompanyBrief({ companyName, companyUrl: crawl.startUrl, aboutFromJd: role.aboutCompany, crawl }, deps.llm),
    analyseInterviewProcess({ companyName, crawl, discussion }, deps.llm),
  ]);

  let brief: CompanyBrief;
  if (briefResult.status === "fulfilled") {
    brief = briefResult.value;
    emit("brief", brief.sources.length ? "done" : "warning", brief.sources.length ? `Brief from ${brief.sources.length} page(s)` : "Brief based on the job description only");
  } else {
    brief = {
      summary: `The company brief could not be generated (${(briefResult.reason as Error).message}). Regenerate this section to try again.`,
      what_they_do: role.aboutCompany || "Not available.",
      sources: [],
      key_facts: [],
    };
    notes.push("Company brief generation failed; regenerate it from the kit page.");
    emit("brief", "failed", (briefResult.reason as Error).message);
  }

  let interviewProcess: InterviewProcess | null = null;
  if (processResult.status === "fulfilled") interviewProcess = processResult.value;
  else emit("process", "failed", (processResult.reason as Error).message);
  if (interviewProcess) {
    emit("process", "done", interviewProcess.stages.length ? `Process: ${interviewProcess.stages.map((s) => s.name).join(" → ")}` : "Process partly described");
  } else if (processResult.status === "fulfilled") {
    emit("process", "warning", "No published interview process found");
  }
  if (!interviewProcess) notes.push("No description of the interview process was found on the company site or in public discussion; questions assume a typical process.");
  if (companyName && discussion.items.length === 0) {
    notes.push(`No public discussion of ${companyName}'s interview process was found (searched: Hacker News${process.env.BRAVE_API_KEY ? ", Brave Search" : ""}).`);
  } else if (interviewProcess && discussion.items.length > 0 && interviewProcess.discussion.length === 0) {
    notes.push("Public search results did not clearly refer to this company, so they were not used.");
  }

  // 4. Questions: one call per category.
  const context: QuestionContext = {
    roleTitle: role.title,
    seniority: role.seniority,
    companyName,
    briefSummary: `${brief.summary} ${brief.what_they_do}`.trim(),
    process: interviewProcess,
  };
  const plans = planCategories(role.requirements, role.seniority, interviewProcess);
  let questions: Question[] = [];
  for (const plan of plans) {
    const step = `questions:${plan.category}`;
    emit(step, "running", `Generating ${plan.category} questions`);
    try {
      const drafts = await generateCategoryQuestions(plan, context, deps.llm);
      for (const d of drafts) questions.push({ ...d, id: nextId("q", questions) });
      emit(step, "done", `${drafts.length} ${plan.category} questions`);
    } catch (err) {
      emit(step, "failed", (err as Error).message);
      notes.push(`Generating ${plan.category} questions failed (${(err as Error).message}); the coverage pass fills in what it can.`);
    }
  }

  // 5. Coverage loop: code finds gaps, model fills them, code checks again.
  emit("coverage", "running", "Checking every requirement has a question");
  const loop = await closeCoverageGaps(role.requirements, questions, context, deps.llm, (pass, uncovered) =>
    emit("coverage", "running", `Pass ${pass}: ${uncovered.length ? `${uncovered.length} uncovered (${uncovered.join(", ")})` : "all requirements covered"}`),
  );
  questions = orderByCategory(loop.questions);
  if (loop.fallbackFor.length) {
    notes.push(`After ${MAX_COVERAGE_PASSES} passes the model had not covered ${loop.fallbackFor.join(", ")}; plain questions were added for them.`);
  }
  const uncoveredNice = loop.report.uncovered;
  if (uncoveredNice.length) notes.push(`Nice-to-have requirement(s) without a question: ${uncoveredNice.join(", ")}.`);
  emit("coverage", loop.report.uncoveredMust.length ? "failed" : "done", `${loop.passes} pass(es); ${loop.history[0]?.length ?? 0} gap(s) found in the first draft, ${loop.report.uncovered.length} left`);

  // 6. Flashcards.
  emit("flashcards", "running", "Writing flashcards");
  let flashcards: Flashcard[];
  try {
    const drafts = await generateFlashcards({ requirements: role.requirements, questions, roleTitle: role.title, companyName, companyFacts: brief.key_facts }, deps.llm);
    if (drafts.length === 0) throw new Error("model returned no flashcards");
    flashcards = withIds("f", drafts);
    emit("flashcards", "done", `${flashcards.length} flashcards`);
  } catch (err) {
    flashcards = withIds("f", flashcardsFromQuestions(questions));
    emit("flashcards", "warning", `Flashcards derived from questions (${(err as Error).message})`);
  }

  // 7. Schedule: arithmetic, in code.
  emit("schedule", "running", `Allocating across ${input.days} day(s)`);
  const schedule = buildSchedule({ requirements: role.requirements, questions, days: input.days });
  emit("schedule", "done", `${schedule.days.length} day(s), ${schedule.days.reduce((a, d) => a + d.minutes, 0)} minutes total`);

  const pagesUsed = unique([...brief.sources, ...(interviewProcess?.source_url ? [interviewProcess.source_url] : []), ...(interviewProcess?.discussion.map((d) => d.url) ?? [])]);
  const kit: Kit = {
    source: {
      company: companyName,
      company_url: crawl.startUrl,
      role: role.title,
      location: role.location,
      jd_chars: input.jd.length,
      researched_at: now().toISOString(),
      pages_used: pagesUsed,
    },
    company_brief: { ...brief, state: { edited: false, pinned: false } },
    interview_process: interviewProcess,
    role: { title: role.title, seniority: role.seniority, responsibilities: role.responsibilities, requirements: role.requirements },
    questions,
    flashcards,
    schedule,
    coverage: { uncovered_requirement_ids: loop.report.uncovered, passes: loop.passes },
    notes,
  };

  // 8. Validate before anything is saved or written.
  emit("validate", "running", "Validating kit structure");
  const validation = validateKit(kit);
  if (!validation.ok) {
    emit("validate", "failed", validation.errors.slice(0, 3).join("; "));
    throw new PipelineError("KIT_INVALID", `Generated kit failed validation: ${validation.errors.slice(0, 5).join("; ")}`);
  }
  emit("validate", "done", "Kit is valid");

  const { requirements: _r, ...extraction } = role;
  return {
    kit: validation.kit,
    research: {
      companyName,
      extraction,
      crawl: { ...crawl, pages: crawl.pages.map((p) => ({ ...p, text: p.text.slice(0, 6000) })) },
      discussion,
      context,
    },
  };
}

function reportCrawl(crawl: CrawlResult, emit: (s: string, st: StepStatus, m: string) => void, notes: string[]) {
  if (!crawl.reachable) {
    const reason = crawl.error?.message ?? "unreachable";
    emit("crawl", "warning", `Company site unavailable: ${reason}`);
    notes.push(`The company website could not be retrieved (${crawl.startUrl}: ${reason}); the brief is based on the job description only.`);
    return;
  }
  const found = [crawl.aboutPageUrl ? "about page" : null, crawl.hiringPageUrl ? (crawl.hiringProcessDescribed ? "hiring process" : "careers page") : null].filter(Boolean);
  emit("crawl", crawl.hiringPageUrl ? "done" : "warning", `${crawl.pages.length} page(s) read${found.length ? `; found ${found.join(" and ")}` : "; no about or hiring page found"}`);
  if (!crawl.hiringPageUrl) {
    notes.push(`No hiring or interview-process page was found on the company site (read ${crawl.pages.length} page(s)).`);
  } else if (!crawl.hiringProcessDescribed) {
    notes.push(`A careers page was found (${crawl.hiringPageUrl}) but it does not describe the interview process.`);
  }
  if (crawl.skipped.length) {
    notes.push(`Skipped ${crawl.skipped.length} source(s): ${crawl.skipped.slice(0, 4).map((s) => `${s.url} (${s.reason})`).join(", ")}.`);
  }
}

/** Company name from the site title ("Acme Payments — Payouts..." -> "Acme Payments"), else the host. */
function nameFromSite(crawl: CrawlResult): string {
  const title = crawl.pages[0]?.title ?? "";
  const fromTitle = title.split(/\s[|–—-]\s|:\s/)[0]?.trim();
  if (fromTitle && fromTitle.length <= 40) return fromTitle;
  try {
    const url = new URL(crawl.startUrl);
    const segment = url.pathname.split("/").filter(Boolean)[0];
    const label = ["localhost", "127.0.0.1"].includes(url.hostname) && segment ? segment : url.hostname.replace(/^www\./, "").split(".")[0]!;
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return "";
  }
}

function orderByCategory(questions: Question[]): Question[] {
  return CATEGORY_ORDER.flatMap((c) => questions.filter((q) => q.category === c));
}

function withIds<T extends object>(prefix: string, drafts: T[]): (T & { id: string })[] {
  const out: (T & { id: string })[] = [];
  for (const d of drafts) out.push({ ...d, id: nextId(prefix, out) });
  return out;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
