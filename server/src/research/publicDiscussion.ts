/**
 * Public discussion of a company's interview process.
 *
 * Sources (documented in README):
 *  - Hacker News via the public Algolia API (no key, intended for programmatic use)
 *  - Brave Search API, only when BRAVE_API_KEY is set (free tier)
 * Reddit and Glassdoor block automated access, so they are not used.
 *
 * Results are filtered in code: a hit must mention the company by name AND talk
 * about interviewing. Nothing found is a normal outcome, reported honestly.
 */

export interface DiscussionItem {
  url: string;
  title: string;
  snippet: string;
  source: "hackernews" | "brave";
}

export interface DiscussionResult {
  query: string;
  items: DiscussionItem[];
  skipped: { url: string; reason: string }[];
}

const INTERVIEW_WORDS = /\b(interview(ed|s|ing)?|hiring process|take[- ]home|onsite|on-site|recruiter|leetcode|system design|offer)\b/i;
const TIMEOUT_MS = 8_000;

export async function searchInterviewDiscussion(companyName: string, options: { maxItems?: number } = {}): Promise<DiscussionResult> {
  const maxItems = options.maxItems ?? 6;
  const name = companyName.trim();
  const query = `${name} interview`;
  const result: DiscussionResult = { query, items: [], skipped: [] };
  if (name.length < 2) {
    result.skipped.push({ url: "", reason: "no company name to search for" });
    return result;
  }

  const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const relevant = (text: string) => nameRe.test(text) && INTERVIEW_WORDS.test(text);

  const searches: Promise<DiscussionItem[]>[] = [searchHackerNews(query, relevant, result)];
  if (process.env.BRAVE_API_KEY) searches.push(searchBrave(query, relevant, result, process.env.BRAVE_API_KEY));
  const all = (await Promise.all(searches)).flat();

  const seen = new Set<string>();
  for (const item of all) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    result.items.push(item);
    if (result.items.length >= maxItems) break;
  }
  return result;
}

async function searchHackerNews(query: string, relevant: (t: string) => boolean, result: DiscussionResult): Promise<DiscussionItem[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=(story,comment)&hitsPerPage=30`;
  const data = await getJson<{
    hits?: { objectID: string; title?: string | null; story_title?: string | null; comment_text?: string | null; story_text?: string | null }[];
  }>(url, {}, result, "hackernews");
  if (!data?.hits) return [];
  return data.hits
    .map((h) => {
      const title = h.title ?? h.story_title ?? "";
      const body = stripHtml(h.comment_text ?? h.story_text ?? "");
      return { url: `https://news.ycombinator.com/item?id=${h.objectID}`, title, snippet: excerpt(body || title), source: "hackernews" as const, all: `${title} ${body}` };
    })
    .filter((h) => relevant(h.all))
    .map(({ all: _all, ...item }) => item);
}

async function searchBrave(query: string, relevant: (t: string) => boolean, result: DiscussionResult, key: string): Promise<DiscussionItem[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(`${query} process experience`)}&count=10`;
  const data = await getJson<{ web?: { results?: { url: string; title: string; description?: string }[] } }>(
    url,
    { "X-Subscription-Token": key, Accept: "application/json" },
    result,
    "brave",
  );
  return (data?.web?.results ?? [])
    .map((r) => ({ url: r.url, title: stripHtml(r.title), snippet: excerpt(stripHtml(r.description ?? "")), source: "brave" as const }))
    .filter((r) => relevant(`${r.title} ${r.snippet}`));
}

async function getJson<T>(url: string, headers: Record<string, string>, result: DiscussionResult, label: string): Promise<T | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return (await res.json()) as T;
      if (res.status !== 429 && res.status < 500) {
        result.skipped.push({ url: label, reason: `HTTP ${res.status}` });
        return null;
      }
    } catch (err) {
      if (attempt === 2) result.skipped.push({ url: label, reason: (err as Error).message });
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  if (!result.skipped.some((s) => s.url === label)) result.skipped.push({ url: label, reason: "unavailable after retries" });
  return null;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(s: string, max = 600): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
