import type { Kit, Question, Requirement } from "../src/domain/schema.js";

export const requirements: Requirement[] = [
  { id: "r1", text: "5+ years with React", kind: "technical", priority: "must" },
  { id: "r2", text: "Mentoring junior engineers", kind: "behavioural", priority: "must" },
  { id: "r3", text: "Experience with GraphQL", kind: "technical", priority: "nice" },
  { id: "r4", text: "Fintech background", kind: "domain", priority: "nice" },
];

export function question(id: string, requirement_ids: string[], difficulty = 2, category: Question["category"] = "technical"): Question {
  return { id, requirement_ids, category, prompt: `Prompt ${id}`, answer_outline: "", difficulty };
}

export function makeQuestions(n: number): Question[] {
  return Array.from({ length: n }, (_, i) =>
    question(`q${i + 1}`, [requirements[i % requirements.length]!.id], (i % 3) + 1),
  );
}

export function makeKit(overrides: Partial<Kit> = {}): Kit {
  return structuredClone(baseKit(overrides));
}

function baseKit(overrides: Partial<Kit>): Kit {
  return {
    source: {
      company: "Acme",
      company_url: "https://acme.test/",
      role: "Senior Frontend Engineer",
      location: "Remote",
      jd_chars: 1200,
      researched_at: "2026-10-18T10:00:00Z",
      pages_used: ["https://acme.test/"],
    },
    company_brief: { summary: "s", what_they_do: "w", sources: ["https://acme.test/"] },
    role: { title: "Senior Frontend Engineer", seniority: "senior", responsibilities: ["Build UI"], requirements },
    questions: [question("q1", ["r1"]), question("q2", ["r2"], 2, "behavioural")],
    flashcards: [{ id: "f1", front: "What is reconciliation?", back: "...", requirement_ids: ["r1"] }],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: "React", question_ids: ["q1"], minutes: 15 },
        { day: 2, focus: "Mentoring", question_ids: ["q2"], minutes: 15 },
      ],
    },
    coverage: { uncovered_requirement_ids: ["r3", "r4"], passes: 1 },
    ...overrides,
  };
}
