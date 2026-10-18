"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { parseCasesFile, type CaseInput } from "@/lib/parseCases";
import { Alert, Button, Card, Field, Input, Textarea } from "./ui";

type Mode = "single" | "file";

export function NewKitForm({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = useState<Mode>("single");
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">New prep kit</h2>
        <div role="tablist" aria-label="How to add roles" className="inline-flex rounded-md bg-slate-100 p-0.5 text-sm">
          {(["single", "file"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded px-3 py-1 ${mode === m ? "bg-white font-medium shadow-sm" : "text-slate-600"}`}
            >
              {m === "single" ? "One role" : "Several roles (file)"}
            </button>
          ))}
        </div>
      </div>
      {mode === "single" ? <SingleForm /> : <FileForm onCreated={onCreated} />}
    </Card>
  );
}

function SingleForm() {
  const router = useRouter();
  const [jd, setJd] = useState("");
  const [url, setUrl] = useState("");
  const [days, setDays] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await api<{ id: string; duplicate: boolean }>("/kits", { body: { jd, company_url: url, days: Number(days) } });
      router.push(`/kits/${r.id}${r.duplicate ? "?duplicate=1" : ""}`);
    } catch (err) {
      setError(err as ApiError);
      setSubmitting(false);
    }
  }

  const fields = error?.fieldErrors() ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error && !error.details && <Alert tone="error">{error.message}</Alert>}
      <Field label="Job description" error={fields.jd} hint="Paste the whole posting. Short ones work too; the kit will say how much it had to go on.">
        {(p) => <Textarea {...p} rows={9} required value={jd} onChange={(e) => setJd(e.target.value)} placeholder="Senior Backend Engineer&#10;&#10;Requirements&#10;- 5+ years with Go…" />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <Field label="Company website" error={fields.company_url} hint="We crawl it for what they do and how they hire.">
          {(p) => <Input {...p} type="url" inputMode="url" required placeholder="https://company.com" value={url} onChange={(e) => setUrl(e.target.value)} />}
        </Field>
        <Field label="Days until interview" error={fields.days}>
          {(p) => <Input {...p} type="number" min={1} max={365} required value={days} onChange={(e) => setDays(e.target.value)} />}
        </Field>
      </div>
      <div className="flex items-center justify-end gap-3">
        <p className="text-xs text-slate-500">Research and generation take about 1–2 minutes.</p>
        <Button type="submit" variant="primary" loading={submitting}>
          Build my kit
        </Button>
      </div>
    </form>
  );
}

type Result = { index: number; id?: string; duplicate?: boolean; error?: { message: string } };

function FileForm({ onCreated }: { onCreated: () => void }) {
  const [items, setItems] = useState<CaseInput[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [defaultDays, setDefaultDays] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    setResults(null);
    setError(null);
    if (!file) return;
    if (file.size > 1_000_000) {
      setParseErrors(["That file is over 1 MB. Split it into smaller files."]);
      setItems([]);
      return;
    }
    const parsed = parseCasesFile(file.name, await file.text(), Number(defaultDays) || 7);
    setItems(parsed.items);
    setParseErrors(parsed.errors);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api<{ results: Result[] }>("/kits/batch", { body: { items } });
      setResults(r.results);
      onCreated();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-600">
        Upload a <strong>.json</strong> array of <code className="rounded bg-slate-100 px-1">{"{ jd, company_url, days }"}</code> or a <strong>.csv</strong> with columns{" "}
        <code className="rounded bg-slate-100 px-1">jd,company_url,days</code>. Up to 10 roles.
      </p>
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <Field label="File">{(p) => <Input {...p} type="file" accept=".json,.csv,application/json,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />}</Field>
        <Field label="Default days" hint="Used when a row has none.">
          {(p) => <Input {...p} type="number" min={1} max={365} value={defaultDays} onChange={(e) => setDefaultDays(e.target.value)} />}
        </Field>
      </div>
      {parseErrors.length > 0 && (
        <Alert tone="warning" title="Some rows need attention">
          <ul className="list-disc pl-5">
            {parseErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      {items.length > 0 && !results && (
        <div>
          <p className="mb-2 text-sm font-medium">{items.length} role(s) ready</p>
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
            {items.map((it, i) => (
              <li key={i} className="flex justify-between gap-3 px-3 py-2">
                <span className="truncate">{it.jd.split("\n")[0]}</span>
                <span className="shrink-0 text-slate-500">
                  {safeHost(it.company_url)} · {it.days}d
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end">
            <Button variant="primary" loading={submitting} onClick={() => void submit()}>
              Build {items.length} kit{items.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {results && (
        <Alert tone={results.some((r) => r.error) ? "warning" : "success"} title="Submitted">
          <ul className="list-disc pl-5">
            {results.map((r) => (
              <li key={r.index}>
                Role {r.index + 1}: {r.error ? `not created, ${r.error.message}` : r.duplicate ? "already had a kit for this posting" : "generating"}
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}

function safeHost(u: string) {
  try {
    return new URL(u.includes("://") ? u : `https://${u}`).host;
  } catch {
    return u;
  }
}
