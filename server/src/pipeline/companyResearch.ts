import { z } from "zod";
import type { InterviewProcess } from "../domain/schema.js";
import type { LlmClient } from "../llm/client.js";
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from "../llm/untrusted.js";
import type { CrawlResult } from "../retrieval/crawler.js";
import type { DiscussionResult } from "../research/publicDiscussion.js";
import { lenientArray, lenientString, stringList } from "./zodHelpers.js";

export interface CompanyBrief {
  summary: string;
  what_they_do: string;
  sources: string[];
  key_facts: string[];
}

const BriefSchema = z.object({
  summary: lenientString,
  what_they_do: lenientString,
  key_facts: stringList,
  used_urls: stringList,
});

const BRIEF_SYSTEM = `You write a short, factual company brief for a candidate preparing for an interview.
Use ONLY the supplied pages and job-description excerpt. Do not use outside knowledge, do not guess revenue, size, customers or history that the sources do not state.
If the sources say little, say so plainly in the summary rather than padding.
Return JSON: {"summary": 2-4 sentences, "what_they_do": 2-4 sentences on products/customers, "key_facts": up to 5 short facts each traceable to a source, "used_urls": [urls of pages you actually used]}.
${UNTRUSTED_DATA_RULE}`;

/** Pages most useful for "what they do": home first, then about, then anything else that is not the hiring page. */
export function pagesForBrief(crawl: CrawlResult) {
  const order = { home: 0, about: 1, other: 2, hiring: 3 } as const;
  return [...crawl.pages].sort((a, b) => order[a.kind] - order[b.kind]).filter((p) => p.kind !== "hiring").slice(0, 3);
}

export async function writeCompanyBrief(
  args: { companyName: string; companyUrl: string; aboutFromJd: string; crawl: CrawlResult },
  llm: LlmClient,
): Promise<CompanyBrief> {
  const { companyName, companyUrl, aboutFromJd, crawl } = args;
  const pages = pagesForBrief(crawl);

  if (pages.length === 0) {
    // Nothing retrieved: an honest brief from the posting alone, no model call needed.
    const reason = crawl.error?.message ?? "no readable pages";
    return {
      summary: `We could not retrieve the company website (${companyUrl}: ${reason}). This brief only reflects what the job description says${companyName ? ` about ${companyName}` : ""}; verify it yourself before the interview.`,
      what_they_do: aboutFromJd || "The job description does not describe what the company does.",
      sources: [],
      key_facts: [],
    };
  }

  const material = pages.map((p) => fenceUntrusted(p.url, `${p.title}\n${p.description}\n${p.text}`, 2500)).join("\n\n");
  const out = await llm.generateJson({
    task: "company-brief",
    system: BRIEF_SYSTEM,
    user:
      `Company: ${companyName || "(unknown)"}\nWebsite: ${companyUrl}\n` +
      `What the job description says about the company: ${aboutFromJd || "(nothing)"}\n\nPages:\n${material}`,
    schema: BriefSchema,
    maxTokens: 1200,
  });

  const fetched = new Set(pages.map((p) => p.url));
  const sources = out.used_urls.filter((u) => fetched.has(u));
  const thin = pages.reduce((n, p) => n + p.text.length, 0) < 400;
  return {
    summary: thin && !/little|limited|few details/i.test(out.summary)
      ? `${out.summary} (The company website has very little content, so this brief is necessarily thin.)`.trim()
      : out.summary,
    what_they_do: out.what_they_do,
    key_facts: out.key_facts.filter(Boolean).slice(0, 5),
    sources: sources.length ? sources : [...fetched],
  };
}

// ---------------------------------------------------------------------------
// Interview process: hiring page + public discussion.
// ---------------------------------------------------------------------------

const ProcessSchema = z.object({
  summary: lenientString,
  stages: lenientArray(z.object({ name: z.string(), details: lenientString })),
  relevant_discussion_urls: stringList,
});

const PROCESS_SYSTEM = `You summarise how a company interviews, for a candidate.
Use ONLY the supplied hiring page and discussion snippets. Discussion snippets come from public forums and may be about a different company with a similar name: only use ones clearly about this company, and list their URLs in relevant_discussion_urls.
If the sources do not describe a process, return an empty stages list and say so in the summary.
Return JSON: {"summary": 2-3 sentences, "stages": [{"name": short stage name, "details": one sentence}], "relevant_discussion_urls": [string]}.
${UNTRUSTED_DATA_RULE}`;

const FORMAT_PATTERNS = {
  take_home: /\btake[\s-]?home\b|\bhome assignment\b|\bcoding (exercise|assignment)\b/i,
  system_design: /\bsystem[\s-]design\b|\barchitecture (interview|round)\b|\bdesign (a|an) [a-z ]{3,40}(system|service|ledger|api)\b/i,
  live_coding: /\blive[\s-]coding\b|\bpair(ing| programming)\b|\bwhiteboard\b|\bleetcode\b|\bcoding interview\b/i,
  behavioural: /\bbehaviou?ral\b|\bvalues (interview|round)\b|\bculture (interview|fit)\b|\bSTAR\b/,
};

/** Interview formats are decided by evidence in the text, not by the model. */
export function detectFormats(text: string): InterviewProcess["formats"] {
  return {
    take_home: FORMAT_PATTERNS.take_home.test(text),
    system_design: FORMAT_PATTERNS.system_design.test(text),
    live_coding: FORMAT_PATTERNS.live_coding.test(text),
    behavioural: FORMAT_PATTERNS.behavioural.test(text),
  };
}

export async function analyseInterviewProcess(
  args: { companyName: string; crawl: CrawlResult; discussion: DiscussionResult },
  llm: LlmClient,
): Promise<InterviewProcess | null> {
  const { companyName, crawl, discussion } = args;
  const hiringPage = crawl.hiringPageUrl ? crawl.pages.find((p) => p.url === crawl.hiringPageUrl) : undefined;
  const usableHiring = hiringPage && crawl.hiringProcessDescribed ? hiringPage : undefined;
  if (!usableHiring && discussion.items.length === 0) return null;

  const parts: string[] = [];
  if (usableHiring) parts.push(`Hiring page:\n${fenceUntrusted(usableHiring.url, usableHiring.text, 5000)}`);
  if (discussion.items.length) {
    parts.push(
      `Public discussion snippets:\n${discussion.items.map((d) => fenceUntrusted(d.url, `${d.title}\n${d.snippet}`, 700)).join("\n")}`,
    );
  }
  const out = await llm.generateJson({
    task: "interview-process",
    system: PROCESS_SYSTEM,
    user: `Company: ${companyName || "(unknown)"}\n\n${parts.join("\n\n")}`,
    schema: ProcessSchema,
    maxTokens: 1200,
  });

  const discussionByUrl = new Map(discussion.items.map((d) => [d.url, d]));
  const relevant = out.relevant_discussion_urls.map((u) => discussionByUrl.get(u)).filter((d) => d !== undefined);
  if (!usableHiring && relevant.length === 0) return null; // only noise was found

  const evidence = [usableHiring?.text ?? "", ...relevant.map((d) => `${d.title} ${d.snippet}`)].join("\n");
  return {
    source_url: usableHiring?.url ?? null,
    summary: out.summary,
    stages: out.stages.slice(0, 8).map((s) => ({ name: s.name.slice(0, 80), details: s.details.slice(0, 300) })),
    formats: detectFormats(evidence),
    discussion: relevant.map((d) => ({ url: d.url, title: d.title || d.url })),
  };
}
