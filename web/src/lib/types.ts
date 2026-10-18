// Mirrors the API's kit shape (server/src/domain/schema.ts, Appendix A plus extensions).

export type RequirementKind = "technical" | "behavioural" | "domain";
export type Priority = "must" | "nice";
export type QuestionCategory = "technical" | "system-design" | "behavioural" | "company-fit";
export const CATEGORIES: QuestionCategory[] = ["technical", "system-design", "behavioural", "company-fit"];
export const CATEGORY_LABEL: Record<QuestionCategory, string> = {
  technical: "Technical",
  "system-design": "System design",
  behavioural: "Behavioural",
  "company-fit": "Company fit",
};

export interface ItemState {
  origin: "generated" | "user";
  edited: boolean;
  pinned: boolean;
}

export interface Requirement {
  id: string;
  text: string;
  kind: RequirementKind;
  priority: Priority;
}

export interface Question {
  id: string;
  requirement_ids: string[];
  category: QuestionCategory;
  prompt: string;
  answer_outline: string;
  difficulty: number;
  state?: ItemState;
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  requirement_ids: string[];
  state?: ItemState;
}

export interface ScheduleDay {
  day: number;
  focus: string;
  question_ids: string[];
  minutes: number;
}

export interface InterviewProcess {
  source_url: string | null;
  summary: string;
  stages: { name: string; details: string }[];
  formats: { take_home: boolean; system_design: boolean; live_coding: boolean; behavioural: boolean };
  discussion: { url: string; title: string }[];
}

export interface Kit {
  source: { company: string; company_url: string; role: string; location: string; jd_chars: number; researched_at: string; pages_used: string[] };
  company_brief: { summary: string; what_they_do: string; sources: string[]; key_facts?: string[]; state?: { edited: boolean; pinned: boolean } };
  interview_process?: InterviewProcess | null;
  role: { title: string; seniority: string; responsibilities: string[]; requirements: Requirement[] };
  questions: Question[];
  flashcards: Flashcard[];
  schedule: { days_available: number; days: ScheduleDay[] };
  coverage: { uncovered_requirement_ids: string[]; passes: number };
  notes?: string[];
}

export type KitStatus = "queued" | "running" | "ready" | "failed";

export interface ProgressEvent {
  step: string;
  status: "running" | "done" | "skipped" | "warning" | "failed";
  message: string;
  at: string;
}

export interface CardProgress {
  reviews: number;
  lastConfidence: 1 | 2 | 3 | 4;
  ease: number;
  intervalDays: number;
  dueAt: string;
  lastReviewedAt: string;
}

export interface PracticeSummary {
  total: number;
  covered: number;
  dueNow: number;
  byConfidence: Record<"1" | "2" | "3" | "4", number>;
  weakRequirementIds: string[];
}

export interface Story {
  id: string;
  title: string;
  situation: string;
  action: string;
  result: string;
  requirement_ids: string[];
}

export interface KitRecord {
  id: string;
  status: KitStatus;
  input: { jd: string; companyUrl: string; days: number };
  progress: ProgressEvent[];
  kit: Kit | null;
  error: { code: string; message: string } | null;
  version: number;
  regenerating: { section: string; startedAt: string }[];
  regenerationErrors: { section: string; message: string; at: string }[];
  practice: Record<string, CardProgress>;
  practiceSummary: PracticeSummary | null;
  unscheduled: string[];
  stories: Story[];
  hasPreviousBrief: boolean;
  research: {
    pages: { url: string; title: string; kind: string }[];
    skipped: { url: string; reason: string }[];
    hiringPageUrl: string | null;
    discussionSearched: string;
    discussionSkipped: { url: string; reason: string }[];
  } | null;
  interviewAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface KitSummary {
  id: string;
  status: KitStatus;
  title: string;
  company: string;
  days: number;
  requirements: number | null;
  lastProgress: ProgressEvent | null;
  error: { code: string; message: string } | null;
  createdAt: string;
}

export type KitOp =
  | { type: "updateQuestion"; id: string; patch: Partial<Pick<Question, "prompt" | "answer_outline" | "difficulty" | "requirement_ids">> }
  | { type: "moveQuestion"; id: string; category: QuestionCategory; index: number }
  | { type: "addQuestion"; question: Omit<Question, "state"> }
  | { type: "deleteQuestion"; id: string }
  | { type: "pinQuestion"; id: string; pinned: boolean }
  | { type: "updateFlashcard"; id: string; patch: Partial<Pick<Flashcard, "front" | "back" | "requirement_ids">> }
  | { type: "addFlashcard"; flashcard: Omit<Flashcard, "state"> }
  | { type: "deleteFlashcard"; id: string }
  | { type: "pinFlashcard"; id: string; pinned: boolean }
  | { type: "moveFlashcard"; id: string; index: number }
  | { type: "updateBrief"; patch: { summary?: string; what_they_do?: string } }
  | { type: "pinBrief"; pinned: boolean };
