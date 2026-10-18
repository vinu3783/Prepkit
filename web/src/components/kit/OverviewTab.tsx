"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Kit, KitOp, KitRecord } from "@/lib/types";
import { EditableText } from "../EditableText";
import { Alert, Badge, Button, Card, EmptyState } from "../ui";
import { PriorityBadge, RegenerateButton } from "./shared";

export function OverviewTab({ kit, record, edit, reload, onRecord }: { kit: Kit; record: KitRecord; edit: (...ops: KitOp[]) => void; reload: () => void; onRecord: (r: KitRecord) => void }) {
  const brief = kit.company_brief;
  const pinned = brief.state?.pinned ?? false;
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const coverageCount = (id: string) => kit.questions.filter((q) => q.requirement_ids.includes(id)).length;
  const process = kit.interview_process;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-5">
        <Card>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold">Company brief</h2>
              <p className="text-xs text-slate-500">
                {brief.state?.edited ? "Edited by you. " : ""}
                {brief.sources.length ? `From ${brief.sources.length} page(s) on their site.` : "Not based on the company website."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {record.hasPreviousBrief && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={undoing}
                  onClick={async () => {
                    setUndoing(true);
                    setUndoError(null);
                    try {
                      onRecord(await api<KitRecord>(`/kits/${record.id}/brief/undo`, { body: {} }));
                    } catch (err) {
                      setUndoError((err as ApiError).message);
                    } finally {
                      setUndoing(false);
                    }
                  }}
                >
                  Undo regenerate
                </Button>
              )}
              <Button size="sm" variant="ghost" aria-pressed={pinned} onClick={() => edit({ type: "pinBrief", pinned: !pinned })}>
                {pinned ? "📌 Pinned" : "Pin"}
              </Button>
              <RegenerateButton record={record} section="brief" body={{ section: "brief" }} onStarted={reload} disabledReason={pinned ? "Unpin the brief to regenerate it" : undefined} />
            </div>
          </div>
          {undoError && <Alert tone="error">{undoError}</Alert>}
          <h3 className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</h3>
          <EditableText label="company summary" value={brief.summary} onCommit={(v) => edit({ type: "updateBrief", patch: { summary: v } })} />
          <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">What they do</h3>
          <EditableText label="what the company does" value={brief.what_they_do} onCommit={(v) => edit({ type: "updateBrief", patch: { what_they_do: v } })} />
          {brief.key_facts && brief.key_facts.length > 0 && (
            <>
              <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Key facts</h3>
              <ul className="mt-1 list-disc pl-6 text-sm">
                {brief.key_facts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </>
          )}
          {brief.sources.length > 0 && <SourceList title="Sources" urls={brief.sources} />}
        </Card>

        <Card>
          <h2 className="mb-2 font-semibold">How they interview</h2>
          {process ? (
            <>
              <p className="text-sm text-slate-700">{process.summary}</p>
              {process.stages.length > 0 && (
                <ol className="mt-3 flex flex-col gap-2">
                  {process.stages.map((s, i) => (
                    <li key={`${s.name}-${i}`} className="flex gap-3 text-sm">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{i + 1}</span>
                      <span>
                        <strong>{s.name}</strong>
                        {s.details && <span className="text-slate-600">: {s.details}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {process.formats.take_home && <Badge tone="blue">Take-home</Badge>}
                {process.formats.system_design && <Badge tone="blue">System design</Badge>}
                {process.formats.live_coding && <Badge tone="blue">Live coding</Badge>}
                {process.formats.behavioural && <Badge tone="blue">Behavioural</Badge>}
              </div>
              <SourceList title="Sources" urls={[...(process.source_url ? [process.source_url] : []), ...process.discussion.map((d) => d.url)]} />
            </>
          ) : (
            <EmptyState title="No published interview process found">Neither the company site nor public discussion described it. The questions assume a typical process.</EmptyState>
          )}
        </Card>

        <Card>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">The role</h2>
            <p className="text-sm text-slate-500">
              {kit.role.seniority !== "unspecified" && <span className="capitalize">{kit.role.seniority} · </span>}
              {kit.source.location || "Location not stated"}
            </p>
          </div>
          {kit.role.responsibilities.length > 0 && (
            <>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Responsibilities</h3>
              <ul className="mb-4 mt-1 list-disc pl-6 text-sm">
                {kit.role.responsibilities.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Requirements ({kit.role.requirements.length})</h3>
          {kit.role.requirements.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">The posting doesn&apos;t state explicit requirements. We didn&apos;t invent any.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Requirement</th>
                    <th className="px-2 py-1 font-medium">Priority</th>
                    <th className="px-2 py-1 font-medium">Kind</th>
                    <th className="py-1 pl-2 text-right font-medium">Questions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {kit.role.requirements.map((r) => {
                    const n = coverageCount(r.id);
                    return (
                      <tr key={r.id}>
                        <td className="py-1.5 pr-2">
                          <span className="mr-1.5 text-xs text-slate-400">{r.id}</span>
                          {r.text}
                        </td>
                        <td className="px-2 py-1.5">
                          <PriorityBadge priority={r.priority} />
                        </td>
                        <td className="px-2 py-1.5 capitalize text-slate-600">{r.kind}</td>
                        <td className={`py-1.5 pl-2 text-right tabular-nums ${n === 0 ? "font-semibold text-red-700" : ""}`}>{n === 0 ? "none" : n}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <aside className="flex flex-col gap-5">
        <Card>
          <h2 className="mb-2 font-semibold">Research trail</h2>
          <p className="text-xs text-slate-500">Coverage checked in {kit.coverage.passes} pass{kit.coverage.passes === 1 ? "" : "es"}.</p>
          {record.research && (
            <>
              <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Pages read</h3>
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {record.research.pages.map((p) => (
                  <li key={p.url} className="flex items-center gap-1.5">
                    <Badge tone={p.kind === "hiring" ? "green" : p.kind === "about" ? "blue" : "slate"}>{p.kind}</Badge>
                    <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="truncate text-brand-700 hover:underline">
                      {p.title || pathOf(p.url)}
                    </a>
                  </li>
                ))}
                {record.research.pages.length === 0 && <li className="text-slate-500">None</li>}
              </ul>
              {record.research.skipped.length > 0 && (
                <>
                  <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Skipped</h3>
                  <ul className="mt-1 flex flex-col gap-1 text-xs text-slate-600">
                    {record.research.skipped.map((s) => (
                      <li key={s.url} className="break-all">
                        {pathOf(s.url)}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {record.research.discussionSearched && (
                <p className="mt-3 text-xs text-slate-500">
                  Searched Hacker News for “{record.research.discussionSearched}”.
                  {record.research.discussionSkipped.length > 0 && ` Unavailable: ${record.research.discussionSkipped.map((s) => s.url).join(", ")}.`}
                </p>
              )}
            </>
          )}
        </Card>
      </aside>
    </div>
  );
}

function SourceList({ title, urls }: { title: string; urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <ul className="mt-1 flex flex-col gap-0.5 text-sm">
        {urls.map((u) => (
          <li key={u} className="truncate">
            <a href={u} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-700 hover:underline">
              {u}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function pathOf(u: string) {
  try {
    const url = new URL(u);
    return url.pathname === "/" ? url.host : url.pathname;
  } catch {
    return u;
  }
}
