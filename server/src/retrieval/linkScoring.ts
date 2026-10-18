/**
 * Score a candidate link by how likely it leads to (a) how the company hires or
 * (b) what the company does. Uses words in the URL path *and* the anchor text,
 * so /people/handbook/hiring and a footer link "How we hire" both rank highly
 * without any hard-coded paths.
 */

export type LinkIntent = "hiring" | "about" | "other";

const HIRING_TERMS: [RegExp, number][] = [
  [/\binterview(s|ing)?\b/, 12],
  [/\bhow[\s-]?we[\s-]?hire\b|\bhiring[\s-]?process\b/, 12],
  [/\bhiring\b/, 9],
  [/\bcareers?\b/, 8],
  [/\brecruit(ing|ment)?\b/, 7],
  [/\bjobs?\b/, 7],
  [/\bwork[\s-]?(with|at|for)[\s-]?us\b|\bjoin[\s-]?(us|the[\s-]?team)\b/, 7],
  [/\bopen[\s-]?(roles|positions)\b|\bvacancies\b/, 6],
  [/\bjoin\b/, 5],
  [/\bhandbook\b/, 5],
  [/\btalent\b/, 5],
  [/\bcandidates?\b/, 5],
  [/\bonboarding\b/, 3],
  [/\bpeople\b/, 2],
];

const ABOUT_TERMS: [RegExp, number][] = [
  [/\babout([\s-]?us)?\b/, 7],
  [/\bwho[\s-]?we[\s-]?are\b|\bour[\s-]?story\b/, 6],
  [/\bmission\b|\bvalues\b/, 5],
  [/\bculture\b/, 5],
  [/\bcompany\b/, 4],
  [/\bengineering\b/, 4],
  [/\bproducts?\b|\bplatform\b|\bsolutions\b/, 3],
  [/\bteam\b/, 3],
  [/\bcustomers?\b/, 2],
  [/\bblog\b/, 1],
];

const NEGATIVE: [RegExp, number][] = [
  [/\b(login|log-in|signin|sign-in|signup|sign-up|register|cart|checkout|account)\b/, 15],
  [/\b(privacy|terms|cookies?|legal|gdpr|imprint|impressum|security\.txt)\b/, 12],
  [/\b(status|docs|api|changelog|pricing|download|support|help)\b/, 2],
];

const BINARY_EXTENSION = /\.(pdf|png|jpe?g|gif|svg|webp|zip|gz|mp4|mp3|webm|ico|css|js|json|xml|rss|woff2?)$/i;

export interface ScoredLink {
  url: string;
  score: number;
  intent: LinkIntent;
}

export function scoreLink(rawUrl: string, anchorText: string, fromHiringPage = false): ScoredLink {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { url: rawUrl, score: -100, intent: "other" };
  }
  if (BINARY_EXTENSION.test(url.pathname)) return { url: rawUrl, score: -100, intent: "other" };

  const haystack = `${decodeSafe(url.pathname).replace(/[/_.]+/g, " ")} ${anchorText}`.toLowerCase();
  const hiring = sumMatches(haystack, HIRING_TERMS);
  const about = sumMatches(haystack, ABOUT_TERMS);
  const penalty = sumMatches(haystack, NEGATIVE);

  const depth = url.pathname.split("/").filter(Boolean).length;
  let score = Math.max(hiring, about) + Math.min(hiring, about) * 0.25 - penalty - depth * 0.3;
  if (url.search) score -= 2;
  // Pages linked from a hiring page are likely the detailed process (handbook pattern).
  if (fromHiringPage && hiring > 0) score += 3;

  const intent: LinkIntent = hiring > 0 && hiring >= about ? "hiring" : about > 0 ? "about" : "other";
  return { url: rawUrl, score: Math.round(score * 10) / 10, intent };
}

function sumMatches(haystack: string, terms: [RegExp, number][]): number {
  return terms.reduce((total, [re, weight]) => (re.test(haystack) ? total + weight : total), 0);
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Interview-process evidence in page *text*: decides whether a page actually describes how they hire. */
const PROCESS_SIGNALS = [
  /\binterview(s|ing)?\b/g,
  /\bhiring process\b/g,
  /\btake[\s-]?home\b/g,
  /\bsystem design\b/g,
  /\bon[\s-]?site\b/g,
  /\brecruiter\b/g,
  /\b(phone|technical|culture|initial) screen(ing)?\b/g,
  /\bpair(ing| programming)\b/g,
  /\b(stage|round|step)s?\b/g,
  /\boffer\b/g,
  /\bassessment\b/g,
];

export function hiringProcessSignal(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const re of PROCESS_SIGNALS) score += Math.min(5, lower.match(re)?.length ?? 0);
  return score;
}
