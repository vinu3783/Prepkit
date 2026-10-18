import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from "../llm/untrusted.js";
import type { Priority, Requirement } from "../domain/schema.js";
import { lenientArray, lenientString, stringList } from "./zodHelpers.js";

const SENIORITY = ["intern", "junior", "mid", "senior", "staff", "principal", "lead", "manager", "unspecified"] as const;

const ExtractionSchema = z.object({
  company: lenientString,
  title: lenientString,
  seniority: z.string().catch("unspecified"),
  location: lenientString,
  about_company: lenientString,
  responsibilities: stringList,
  requirements: lenientArray(
    z.object({
      text: z.string().min(1),
      kind: z.enum(["technical", "behavioural", "domain"]).catch("technical"),
      priority: z.enum(["must", "nice"]).catch("must"),
      quote: lenientString,
    }),
  ),
});

const SYSTEM = `You extract structured facts from a job description for interview preparation.
Return JSON:
{"company": string, "title": string, "seniority": one of ${SENIORITY.map((s) => `"${s}"`).join(", ")},
 "location": string, "about_company": string, "responsibilities": [string],
 "requirements": [{"text": string, "kind": "technical"|"behavioural"|"domain", "priority": "must"|"nice", "quote": string}]}

Rules:
- Only include requirements the posting actually states. Never add requirements that are merely typical for the role. A two-line posting may yield zero or one requirement, and that is the correct answer.
- One requirement per distinct skill, experience or trait; "text" is a short paraphrase (max 12 words).
- "quote" is copied character-for-character from the posting: the phrase that states the requirement.
- priority "nice" when the posting marks it optional (nice to have, bonus, preferred, a plus, ideally) or it sits under such a heading; otherwise "must".
- kind: technical = languages, tools, engineering skills; behavioural = collaboration, leadership, mentoring, communication, ownership; domain = industry or business knowledge.
- A responsibility becomes a requirement only when it names something the candidate must be able to do (e.g. "mentor junior engineers"). Put everything else in "responsibilities".
- company, location, about_company: "" when the posting does not say. about_company: what the posting itself says about the company, 1-2 sentences.
${UNTRUSTED_DATA_RULE}`;

export interface ExtractedRole {
  company: string;
  title: string;
  seniority: string;
  location: string;
  aboutCompany: string;
  responsibilities: string[];
  requirements: Requirement[];
  /** Requirements the model proposed that the posting does not support. */
  dropped: string[];
}

export async function extractRequirements(jd: string, llm: LlmClient): Promise<ExtractedRole> {
  const raw = await llm.generateJson({
    task: "extract-requirements",
    system: SYSTEM,
    user: `Extract the role and its requirements from this job description.\n\n${fenceUntrusted("job description", jd, 14_000)}`,
    schema: ExtractionSchema,
    maxTokens: 3000,
    temperature: 0.1,
  });

  const requirements: Requirement[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const r of raw.requirements) {
    const evidence = r.quote || r.text;
    if (!isGrounded(jd, evidence) && !isGrounded(jd, r.text)) {
      dropped.push(r.text);
      continue;
    }
    const key = normalizeText(r.text);
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      id: `r${requirements.length + 1}`,
      text: r.text.trim().slice(0, 160),
      kind: r.kind,
      priority: decidePriority(jd, evidence, r.priority),
    });
    if (requirements.length >= 25) break;
  }

  const title = raw.title.trim() || firstLine(jd);
  return {
    company: raw.company.trim(),
    title,
    seniority: normalizeSeniority(raw.seniority, title),
    location: raw.location.trim(),
    aboutCompany: raw.about_company.trim(),
    responsibilities: raw.responsibilities.map((s) => s.trim()).filter(Boolean).slice(0, 15),
    requirements,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Deterministic checks. The model proposes; these decide.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set("the a an and or of to in with for on at by is are be as you your we our this that from have has will can".split(" "));

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();
}

function contentTokens(s: string): string[] {
  return normalizeText(s)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * A requirement is grounded when its evidence appears in the posting: verbatim
 * (after normalising case/punctuation) or with at least 75% of its content words present.
 */
export function isGrounded(jd: string, evidence: string): boolean {
  const e = normalizeText(evidence);
  if (!e) return false;
  if (normalizeText(jd).includes(e)) return true;
  const tokens = contentTokens(evidence);
  if (tokens.length === 0) return false;
  const jdTokens = new Set(contentTokens(jd));
  const hits = tokens.filter((t) => jdTokens.has(t)).length;
  return hits / tokens.length >= 0.75;
}

const NICE_PHRASE = /\b(nice[\s-]to[\s-]haves?|bonus|preferred|a plus|is a plus|are a plus|plus if|ideally|desirable|good[\s-]to[\s-]have|not required|optional|extra credit|would be great|great if|advantageous)\b/i;
const MUST_PHRASE = /\b(required|requirements?|must|mandatory|essential|minimum)\b/i;
const MUST_HEADING = /\b(requirements?|required|must[\s-]haves?|qualifications|what you(['’]ll)? (need|bring)|you have|you will have|minimum|essential|what we(['’]re)? looking for|about you|who you are|skills)\b/i;

/**
 * must vs nice, from how the posting words it:
 *  1. the line stating the requirement ("... is a plus" / "required: ...")
 *  2. the heading it sits under ("Nice to have:" / "Requirements:")
 *  3. otherwise the model's reading
 */
export function decidePriority(jd: string, evidence: string, modelPriority: Priority): Priority {
  const lines = jd.split(/\r?\n/);
  const index = findLine(lines, evidence);
  if (index === -1) return modelPriority;
  const line = lines[index]!;
  if (NICE_PHRASE.test(line)) return "nice";
  if (MUST_PHRASE.test(line) && !isHeading(line)) return "must";
  for (let i = index - 1; i >= 0; i--) {
    const candidate = lines[i]!;
    if (!isHeading(candidate)) continue;
    if (NICE_PHRASE.test(candidate)) return "nice";
    if (MUST_HEADING.test(candidate)) return "must";
    break; // nearest heading decides; it was neither
  }
  return modelPriority;
}

function findLine(lines: string[], evidence: string): number {
  const e = normalizeText(evidence);
  const exact = lines.findIndex((l) => e && normalizeText(l).includes(e));
  if (exact !== -1) return exact;
  const tokens = contentTokens(evidence);
  let best = -1;
  let bestScore = 0;
  lines.forEach((l, i) => {
    const lineTokens = new Set(contentTokens(l));
    const score = tokens.filter((t) => lineTokens.has(t)).length / (tokens.length || 1);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return bestScore >= 0.6 ? best : -1;
}

function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 70) return false;
  if (/^#{1,6}\s/.test(t) || /^\*\*.+\*\*:?$/.test(t)) return true;
  if (/:\s*$/.test(t)) return true;
  // An unpunctuated short line counts only if it reads like a section title ("Nice to have", "Requirements").
  return !/^[-*•\d]/.test(t) && !/[.!?]$/.test(t) && t.split(/\s+/).length <= 6 && (NICE_PHRASE.test(t) || MUST_HEADING.test(t));
}

function normalizeSeniority(raw: string, title: string): string {
  const s = raw.toLowerCase().trim();
  if ((SENIORITY as readonly string[]).includes(s) && s !== "unspecified") return s;
  const t = title.toLowerCase();
  for (const level of ["intern", "junior", "principal", "staff", "lead", "senior", "manager"]) {
    if (t.includes(level)) return level;
  }
  if (/\bsr\.?\b/.test(t)) return "senior";
  if (/\bjr\.?\b/.test(t)) return "junior";
  return "unspecified";
}

function firstLine(jd: string): string {
  return (jd.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 120);
}
