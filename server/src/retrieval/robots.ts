export const USER_AGENT_TOKEN = "PrepKitBot";
export const USER_AGENT = `${USER_AGENT_TOKEN}/1.0 (+interview prep research; respects robots.txt)`;

interface Rule {
  allow: boolean;
  pattern: string;
}

/** Rules that apply to us, parsed from a robots.txt body. */
export function parseRobots(body: string, agentToken = USER_AGENT_TOKEN): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | undefined;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      // An empty Disallow means "allow everything"; skip it.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  const token = agentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

/** Longest matching pattern wins; Allow wins a tie (RFC 9309). */
export function isPathAllowed(rules: Rule[], pathAndQuery: string): boolean {
  let best: Rule | undefined;
  for (const rule of rules) {
    if (!matches(rule.pattern, pathAndQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Per-origin cache of robots rules. A missing or unreadable robots.txt allows everything. */
export class RobotsCache {
  private cache = new Map<string, Promise<Rule[]>>();

  constructor(private readonly fetchText: (url: string) => Promise<string | null>) {}

  async isAllowed(url: URL): Promise<boolean> {
    let rules = this.cache.get(url.origin);
    if (!rules) {
      rules = this.fetchText(`${url.origin}/robots.txt`)
        .then((body) => (body ? parseRobots(body) : []))
        .catch(() => []);
      this.cache.set(url.origin, rules);
    }
    return isPathAllowed(await rules, url.pathname + url.search);
  }
}
