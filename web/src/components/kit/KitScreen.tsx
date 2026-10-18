"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError } from "@/lib/api";
import type { SaveState } from "@/lib/useKitEditor";
import { useKitEditor } from "@/lib/useKitEditor";
import { Alert, Button, Card, Spinner } from "../ui";
import { FlashcardsTab } from "./FlashcardsTab";
import { GenerationProgress } from "./GenerationProgress";
import { OverviewTab } from "./OverviewTab";
import { PracticeTab } from "./PracticeTab";
import { QuestionsTab } from "./QuestionsTab";
import { ScheduleTab } from "./ScheduleTab";
import { StoriesTab } from "./StoriesTab";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "questions", label: "Questions" },
  { id: "flashcards", label: "Flashcards" },
  { id: "schedule", label: "Schedule" },
  { id: "practice", label: "Practice" },
  { id: "stories", label: "Story bank" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function KitScreen({ id }: { id: string }) {
  const editor = useKitEditor(id);
  const { record, kit, loadError } = editor;
  const [tab, setTab] = useState<TabId>("overview");
  const [duplicate, setDuplicate] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Tab in the URL hash so a reload or a shared link lands on the same tab.
  useEffect(() => {
    const fromHash = window.location.hash.slice(1) as TabId;
    if (TABS.some((t) => t.id === fromHash)) setTab(fromHash);
    setDuplicate(new URLSearchParams(window.location.search).has("duplicate"));
  }, []);
  const selectTab = (t: TabId) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };
  const onTabKey = (e: KeyboardEvent, index: number) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + TABS.length) % TABS.length;
    selectTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  if (loadError && !record) {
    return (
      <Card>
        <Alert tone="error" title={loadError.status === 404 ? "Kit not found" : "Couldn't load this kit"} action={<Button size="sm" onClick={() => void editor.reload()}>Retry</Button>}>
          {loadError.status === 404 ? "It may have been deleted, or it belongs to another account." : loadError.message}
        </Alert>
        <Link href="/" className="mt-4 inline-block text-sm text-brand-700 hover:underline">
          ← Back to your kits
        </Link>
      </Card>
    );
  }
  if (!record) {
    return (
      <div className="flex items-center gap-2 py-16 text-slate-500">
        <Spinner /> Loading kit…
      </div>
    );
  }
  if (record.status === "queued" || record.status === "running") return <GenerationProgress record={record} duplicate={duplicate} />;
  if (record.status === "failed" || !kit) return <FailedState id={record.id} error={record.error} jd={record.input.jd} onRetried={() => void editor.reload()} />;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/" className="text-sm text-slate-500 hover:underline">
            ← All kits
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{kit.role.title || "Untitled role"}</h1>
          <p className="text-slate-600">
            {kit.source.company || "Unknown company"} · {kit.role.requirements.length} requirements · {kit.questions.length} questions · {kit.schedule.days_available}-day plan
          </p>
        </div>
        <SaveIndicator save={editor.save} pending={editor.pendingCount} onRetry={editor.retrySave} onDiscard={editor.discardPending} />
      </div>

      {kit.notes && kit.notes.length > 0 && (
        <Alert tone="warning" title="What we could and couldn't find">
          <ul className="list-disc pl-5">
            {kit.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Alert>
      )}
      {record.regenerationErrors.slice(-2).map((e) => (
        <Alert key={e.at} tone="error" title={`Regenerating ${e.section.replace("category:", "")} failed`}>
          {e.message} Your existing content was left unchanged.
        </Alert>
      ))}

      <div role="tablist" aria-label="Kit sections" className="-mx-4 flex gap-1 overflow-x-auto border-b border-slate-200 px-4">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => selectTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? "border-brand-600 text-brand-700" : "border-transparent text-slate-600 hover:text-slate-900"}`}
          >
            {t.label}
            {t.id === "questions" && record.regenerating.some((r) => r.section.startsWith("category:")) && <Spinner className="ml-1.5 inline h-3 w-3" />}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "overview" && <OverviewTab kit={kit} record={record} edit={editor.edit} reload={() => void editor.reload()} onRecord={editor.setRecord} />}
        {tab === "questions" && <QuestionsTab kit={kit} record={record} edit={editor.edit} reload={() => void editor.reload()} />}
        {tab === "flashcards" && <FlashcardsTab kit={kit} edit={editor.edit} />}
        {tab === "schedule" && <ScheduleTab kit={kit} record={record} onRecord={editor.setRecord} />}
        {tab === "practice" && <PracticeTab kit={kit} record={record} reload={() => void editor.reload()} />}
        {tab === "stories" && <StoriesTab kit={kit} record={record} onRecord={editor.setRecord} />}
      </div>
    </div>
  );
}

function SaveIndicator({ save, pending, onRetry, onDiscard }: { save: SaveState; pending: number; onRetry: () => void; onDiscard: () => void }) {
  if (save.kind === "error") {
    return (
      <div role="alert" className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-1.5 text-sm text-red-800">
        Not saved: {save.message}
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
        {pending > 0 && (
          <Button size="sm" variant="ghost" onClick={onDiscard}>
            Discard
          </Button>
        )}
      </div>
    );
  }
  return (
    <p className="flex items-center gap-1.5 text-sm text-slate-500" aria-live="polite">
      {save.kind === "saving" || pending > 0 ? (
        <>
          <Spinner className="h-3.5 w-3.5" /> Saving…
        </>
      ) : save.kind === "saved" ? (
        "All changes saved"
      ) : null}
    </p>
  );
}

function FailedState({ id, error, jd, onRetried }: { id: string; error: { code: string; message: string } | null; jd: string; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <h1 className="text-lg font-semibold">We couldn&apos;t build this kit</h1>
        <p className="mt-1 text-sm text-slate-600">{jd.split("\n")[0]}</p>
        <div className="mt-4">
          <Alert tone="error" title={error?.code ?? "Unknown error"}>
            {error?.message ?? "Generation failed."}
          </Alert>
        </div>
        {retryError && (
          <div className="mt-3">
            <Alert tone="error">{retryError}</Alert>
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setRetryError(null);
              try {
                await api(`/kits/${id}/retry`, { body: {} });
                onRetried();
              } catch (err) {
                setRetryError((err as ApiError).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Retry
          </Button>
          <Link href="/" className="inline-flex items-center rounded-md px-3.5 py-2 text-sm text-slate-700 hover:bg-slate-100">
            Back to kits
          </Link>
        </div>
      </Card>
    </div>
  );
}
