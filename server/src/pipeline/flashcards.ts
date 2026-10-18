import { z } from "zod";
import type { Flashcard, Question, Requirement } from "../domain/schema.js";
import type { LlmClient } from "../llm/client.js";
import { UNTRUSTED_DATA_RULE } from "../llm/untrusted.js";
import { lenientArray, textOrList } from "./zodHelpers.js";

export type DraftFlashcard = Omit<Flashcard, "id">;

const FlashcardSchema = z.object({
  flashcards: lenientArray(
    z.object({
      requirement_ids: lenientArray(z.string()),
      front: z.string().min(3),
      back: textOrList,
    }),
  ),
});

const SYSTEM = `You write revision flashcards for a candidate preparing for an interview.
Fronts are short recall prompts (a concept, a trade-off, a "how would you explain X"); backs are concise answers (max ~60 words, bullets allowed).
For behavioural requirements, the front names the theme and the back lists the beats of a strong story.
Return JSON: {"flashcards": [{"requirement_ids": [ids from the list], "front": string, "back": string}]}.
${UNTRUSTED_DATA_RULE}`;

export async function generateFlashcards(
  args: { requirements: Requirement[]; questions: Question[]; roleTitle: string; companyName: string; companyFacts: string[] },
  llm: LlmClient,
): Promise<DraftFlashcard[]> {
  const { requirements, questions, roleTitle, companyName, companyFacts } = args;
  const reqs = [...requirements].sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "must" ? -1 : 1)).slice(0, 14);
  const count = requirements.length ? Math.min(18, Math.max(4, reqs.length + Math.ceil(reqs.length / 2))) : 4;
  const out = await llm.generateJson({
    task: "flashcards",
    system: SYSTEM,
    user:
      `Role: ${roleTitle}\nCompany: ${companyName || "(unknown)"}\n` +
      `Company facts: ${companyFacts.join("; ") || "(none)"}\n` +
      `Requirements:\n${reqs.map((r) => `- ${r.id} [${r.priority}, ${r.kind}] ${r.text}`).join("\n") || "(none stated: write general cards for the role, requirement_ids [])"}\n` +
      `Sample interview questions for context:\n${questions.slice(0, 8).map((q) => `- ${q.prompt.slice(0, 140)}`).join("\n")}\n\n` +
      `Write about ${count} flashcards, at least one per must-have requirement, plus one about the company if facts are available.`,
    schema: FlashcardSchema,
    maxTokens: 500 + count * 160,
  });
  const allowed = new Set(requirements.map((r) => r.id));
  return out.flashcards.map((f) => ({
    front: f.front.trim(),
    back: f.back.trim(),
    requirement_ids: [...new Set(f.requirement_ids.filter((id) => allowed.has(id)))],
    state: { origin: "generated" as const, edited: false, pinned: false },
  }));
}

/** If the model call fails, derive cards from the questions so practice mode still works. */
export function flashcardsFromQuestions(questions: Question[]): DraftFlashcard[] {
  return questions.slice(0, 12).map((q) => ({
    front: q.prompt,
    back: q.answer_outline || "Outline your answer, then compare with your notes.",
    requirement_ids: q.requirement_ids,
    state: { origin: "generated" as const, edited: false, pinned: false },
  }));
}
