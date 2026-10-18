import { z } from "zod";
import type { InterviewProcess, Question, QuestionCategory, Requirement } from "../domain/schema.js";
import type { LlmClient } from "../llm/client.js";
import { UNTRUSTED_DATA_RULE } from "../llm/untrusted.js";
import { difficulty, lenientArray, textOrList } from "./zodHelpers.js";

/** A question before the kit assigns its id. */
export type DraftQuestion = Omit<Question, "id">;

export interface QuestionContext {
  roleTitle: string;
  seniority: string;
  companyName: string;
  briefSummary: string;
  process: InterviewProcess | null;
}

export interface CategoryPlan {
  category: QuestionCategory;
  requirements: Requirement[];
  count: number;
}

export const CATEGORY_ORDER: QuestionCategory[] = ["technical", "system-design", "behavioural", "company-fit"];

const DESIGN_TERMS = /\b(architect\w*|system design|design(ing)? (systems|services|apis)|scal\w+|distributed|microservices?|high[- ]availability|throughput|event[- ]driven|infrastructure)\b/i;
const SENIOR = new Set(["senior", "staff", "principal", "lead", "manager"]);

/** Which requirement kind is questioned in which category. Domain knowledge is about the business, so it is company fit. */
export function categoryForKind(kind: Requirement["kind"]): QuestionCategory {
  return kind === "technical" ? "technical" : kind === "behavioural" ? "behavioural" : "company-fit";
}

/**
 * Deterministic category plan. Each category becomes its own model call.
 * The interview process changes the plan: a published system-design round adds
 * that category even for a mid-level role; seniority or design-heavy requirements
 * add it too.
 */
export function planCategories(requirements: Requirement[], seniority: string, process: InterviewProcess | null): CategoryPlan[] {
  const byCategory = (c: QuestionCategory) => requirements.filter((r) => categoryForKind(r.kind) === c);
  const technical = byCategory("technical");
  const behavioural = byCategory("behavioural");
  const domain = byCategory("company-fit");
  const plans: CategoryPlan[] = [];

  if (requirements.length === 0) {
    // Thin posting: a small, honest set of role-level questions, none claiming to cover requirements.
    return [
      { category: "technical", requirements: [], count: 3 },
      { category: "behavioural", requirements: [], count: 2 },
      { category: "company-fit", requirements: [], count: 2 },
    ];
  }

  if (technical.length) plans.push({ category: "technical", requirements: technical, count: clamp(Math.ceil(technical.length * 1.3), 3, 10) });

  const designReqs = technical.filter((r) => DESIGN_TERMS.test(r.text));
  const wantsDesign = process?.formats.system_design || SENIOR.has(seniority) || designReqs.length > 0;
  if (wantsDesign && technical.length) {
    const targets = designReqs.length ? designReqs : technical.filter((r) => r.priority === "must").slice(0, 3);
    plans.push({ category: "system-design", requirements: targets, count: process?.formats.system_design ? 3 : 2 });
  }

  const wantsBehavioural = behavioural.length > 0 || process?.formats.behavioural;
  if (wantsBehavioural) plans.push({ category: "behavioural", requirements: behavioural, count: clamp(behavioural.length + 1, 2, 6) });

  plans.push({ category: "company-fit", requirements: domain, count: clamp(domain.length + 2, 2, 5) });
  return plans;
}

const QuestionsSchema = z.object({
  questions: lenientArray(
    z.object({
      requirement_ids: lenientArray(z.string()),
      prompt: z.string().min(5),
      answer_outline: textOrList,
      difficulty,
    }),
  ),
});

const CATEGORY_INSTRUCTIONS: Record<QuestionCategory, string> = {
  technical:
    "Write technical interview questions that probe real hands-on depth with the listed requirements: concrete scenarios, debugging, trade-offs and past decisions, not textbook definitions. answer_outline: 3-5 short bullet points a strong answer covers.",
  "system-design":
    "Write system design interview prompts grounded in the company's domain and the listed requirements. Each prompt names a concrete system to design. answer_outline: requirements to clarify, core components, data model, scaling and failure modes.",
  behavioural:
    "Write behavioural interview questions (STAR format) that test the listed requirements through specific past situations ('Tell me about a time...'). answer_outline: what a strong Situation/Task/Action/Result answer demonstrates and red flags to avoid.",
  "company-fit":
    "Write questions about motivation for this company, its product, customers and values, and any listed domain knowledge. Ground them in the company brief; if the brief says little, keep questions general rather than inventing facts. answer_outline: what the candidate should research and mention.",
};

const SYSTEM = `You write interview preparation questions for one question category at a time.
Return JSON: {"questions": [{"requirement_ids": [ids from the provided list that this question genuinely tests], "prompt": string, "answer_outline": string, "difficulty": 1|2|3}]}
difficulty: 1 = warm-up, 2 = standard, 3 = hard / senior-level.
Use only requirement ids from the provided list. ${UNTRUSTED_DATA_RULE}`;

function describeContext(ctx: QuestionContext): string {
  const lines = [
    `Role: ${ctx.roleTitle || "(not stated)"} (seniority: ${ctx.seniority})`,
    `Company: ${ctx.companyName || "(unknown)"}`,
    `Company brief: ${ctx.briefSummary.slice(0, 600) || "(none)"}`,
  ];
  if (ctx.process) {
    const stages = ctx.process.stages.map((s) => s.name).join(" → ");
    lines.push(`Published interview process: ${stages || ctx.process.summary.slice(0, 300)}`);
  } else {
    lines.push("Interview process: not published; prepare for a typical process.");
  }
  return lines.join("\n");
}

function processGuidance(category: QuestionCategory, process: InterviewProcess | null): string {
  if (!process) return "";
  const f = process.formats;
  const notes: string[] = [];
  if (category === "technical" && f.take_home) notes.push("The process includes a take-home exercise reviewed with interviewers: include one question that prepares the candidate to walk through and defend their take-home decisions.");
  if (category === "technical" && f.live_coding) notes.push("The process includes live coding / pairing: include one short practical coding problem in the role's stack.");
  if (category === "system-design" && f.system_design) {
    const stage = process.stages.find((s) => /design/i.test(`${s.name} ${s.details}`));
    notes.push(`The process has a system design round${stage ? ` (${stage.details})` : ""}: make the first prompt close to what that round describes.`);
  }
  if (category === "behavioural" && f.behavioural) {
    const stage = process.stages.find((s) => /behaviou?r|values|culture/i.test(`${s.name} ${s.details}`));
    if (stage) notes.push(`The process has a behavioural round focused on: ${stage.details}. Reflect those themes.`);
  }
  return notes.join("\n");
}

function requirementList(reqs: Requirement[]): string {
  return reqs.length ? reqs.map((r) => `- ${r.id} [${r.priority}] ${r.text}`).join("\n") : "(no explicit requirements; use requirement_ids: [])";
}

/** One call per category, with that category's own instructions. */
export async function generateCategoryQuestions(plan: CategoryPlan, ctx: QuestionContext, llm: LlmClient, avoid: string[] = []): Promise<DraftQuestion[]> {
  const avoidText = avoid.length ? `\nThe candidate already has these questions; do not repeat or paraphrase them:\n${avoid.map((p) => `- ${p.slice(0, 160)}`).join("\n")}` : "";
  const out = await llm.generateJson({
    task: `questions:${plan.category}`,
    system: SYSTEM,
    user:
      `Category: ${plan.category}\n${CATEGORY_INSTRUCTIONS[plan.category]}\n${processGuidance(plan.category, ctx.process)}\n\n` +
      `${describeContext(ctx)}\n\nRequirements to cover (every listed id needs at least one question):\n${requirementList(plan.requirements)}\n\n` +
      `Write ${plan.count} questions.${avoidText}`,
    schema: QuestionsSchema,
    maxTokens: 600 + plan.count * 260,
  });
  return sanitize(out.questions, plan.category, plan.requirements);
}

/**
 * Gap fill for the coverage loop: exactly one question per uncovered requirement,
 * grouped into one call per category so each keeps its category's instructions.
 */
export async function generateGapQuestions(uncovered: Requirement[], ctx: QuestionContext, llm: LlmClient): Promise<DraftQuestion[]> {
  const groups = new Map<QuestionCategory, Requirement[]>();
  for (const r of uncovered) {
    const c = categoryForKind(r.kind);
    groups.set(c, [...(groups.get(c) ?? []), r]);
  }
  const results: DraftQuestion[] = [];
  for (const [category, reqs] of groups) {
    const out = await llm.generateJson({
      task: `gap:${category}`,
      system: SYSTEM,
      user:
        `Category: ${category}\n${CATEGORY_INSTRUCTIONS[category]}\n\n${describeContext(ctx)}\n\n` +
        `These requirements have no question yet. Write exactly one question for EACH, and set its requirement_ids to that requirement's id:\n${requirementList(reqs)}`,
      schema: QuestionsSchema,
      maxTokens: 500 + reqs.length * 280,
    });
    results.push(...sanitize(out.questions, category, reqs));
  }
  return results;
}

/** Last resort when the model will not cover a must-have: a plain, honest question built in code. */
export function fallbackQuestion(r: Requirement): DraftQuestion {
  const category = categoryForKind(r.kind);
  const prompt =
    r.kind === "behavioural"
      ? `Tell me about a specific time you demonstrated this: "${r.text}". What was the situation, what did you do, and what was the result?`
      : r.kind === "domain"
        ? `What do you know about ${r.text}, and how has that knowledge shaped work you have done?`
        : `Walk me through a project where you relied on ${r.text}. What decisions did you make, what went wrong, and what would you do differently?`;
  return {
    requirement_ids: [r.id],
    category,
    prompt,
    answer_outline: "- A concrete, recent example\n- Your own decisions and their trade-offs\n- Measurable outcome\n- What you learned",
    difficulty: 2,
    state: { origin: "generated", edited: false, pinned: false },
  };
}

function sanitize(raw: z.infer<typeof QuestionsSchema>["questions"], category: QuestionCategory, allowed: Requirement[]): DraftQuestion[] {
  const allowedIds = new Set(allowed.map((r) => r.id));
  const seen = new Set<string>();
  const out: DraftQuestion[] = [];
  for (const q of raw) {
    const key = q.prompt.toLowerCase().replace(/\W+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      requirement_ids: [...new Set(q.requirement_ids.filter((id) => allowedIds.has(id)))],
      category,
      prompt: q.prompt.trim(),
      answer_outline: q.answer_outline.trim(),
      difficulty: q.difficulty,
      state: { origin: "generated", edited: false, pinned: false },
    });
  }
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
