import { z } from "zod";

/**
 * Kit structure from Appendix A. Field names are exact and must not change.
 *
 * Extensions (allowed by the brief "where that genuinely helps"):
 *  - `state` on questions and flashcards: builder provenance used to decide what a
 *    section regeneration may replace. Optional so plain Appendix A kits validate.
 *  - `notes` on the kit: honest reporting of thin inputs / unreachable sources.
 */

export const RequirementKind = z.enum(["technical", "behavioural", "domain"]);
export const Priority = z.enum(["must", "nice"]);
export const QuestionCategory = z.enum(["technical", "behavioural", "system-design", "company-fit"]);

export const ItemState = z.object({
  origin: z.enum(["generated", "user"]),
  edited: z.boolean(),
  pinned: z.boolean(),
});

export const Requirement = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  kind: RequirementKind,
  priority: Priority,
});

export const Question = z.object({
  id: z.string().min(1),
  requirement_ids: z.array(z.string()),
  category: QuestionCategory,
  prompt: z.string().min(1),
  answer_outline: z.string(),
  difficulty: z.number().int().min(1).max(3),
  state: ItemState.optional(),
});

export const Flashcard = z.object({
  id: z.string().min(1),
  front: z.string().min(1),
  back: z.string(),
  requirement_ids: z.array(z.string()),
  state: ItemState.optional(),
});

export const ScheduleDay = z.object({
  day: z.number().int().min(1),
  focus: z.string().min(1),
  question_ids: z.array(z.string()),
  minutes: z.number().int().min(0),
});

export const SectionState = z.object({ edited: z.boolean(), pinned: z.boolean() });

/** Extension: what was learned about the interview process, and from where. */
export const InterviewProcess = z.object({
  source_url: z.string().nullable(),
  summary: z.string(),
  stages: z.array(z.object({ name: z.string(), details: z.string() })),
  formats: z.object({
    take_home: z.boolean(),
    system_design: z.boolean(),
    live_coding: z.boolean(),
    behavioural: z.boolean(),
  }),
  discussion: z.array(z.object({ url: z.string(), title: z.string() })),
});

export const Kit = z.object({
  source: z.object({
    company: z.string(),
    company_url: z.string(),
    role: z.string(),
    location: z.string(),
    jd_chars: z.number().int().min(0),
    researched_at: z.string(),
    pages_used: z.array(z.string()),
  }),
  company_brief: z.object({
    summary: z.string(),
    what_they_do: z.string(),
    sources: z.array(z.string()),
    key_facts: z.array(z.string()).optional(),
    state: SectionState.optional(),
  }),
  interview_process: InterviewProcess.nullable().optional(),
  role: z.object({
    title: z.string(),
    seniority: z.string(),
    responsibilities: z.array(z.string()),
    requirements: z.array(Requirement),
  }),
  questions: z.array(Question),
  flashcards: z.array(Flashcard),
  schedule: z.object({
    days_available: z.number().int().min(1),
    days: z.array(ScheduleDay),
  }),
  coverage: z.object({
    uncovered_requirement_ids: z.array(z.string()),
    passes: z.number().int().min(0),
  }),
  notes: z.array(z.string()).optional(),
});

export type RequirementKind = z.infer<typeof RequirementKind>;
export type Priority = z.infer<typeof Priority>;
export type QuestionCategory = z.infer<typeof QuestionCategory>;
export type ItemState = z.infer<typeof ItemState>;
export type SectionState = z.infer<typeof SectionState>;
export type InterviewProcess = z.infer<typeof InterviewProcess>;
export type Requirement = z.infer<typeof Requirement>;
export type Question = z.infer<typeof Question>;
export type Flashcard = z.infer<typeof Flashcard>;
export type ScheduleDay = z.infer<typeof ScheduleDay>;
export type Kit = z.infer<typeof Kit>;
