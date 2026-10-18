"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { applyOps } from "./applyOps";
import type { Kit, KitOp, KitRecord } from "./types";

export type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: number } | { kind: "error"; message: string };

const POLL_MS = 1500;

/**
 * One kit's client state.
 *
 *   record   last response from the server (authoritative)
 *   pending  ops the user made that the server has not acknowledged yet
 *   kit      what the UI shows = record.kit with pending ops replayed on top
 *
 * Edits are applied locally at once and flushed in order, one request at a time.
 * Polling (while generating or regenerating) replaces `record` but never drops
 * `pending`, so a regeneration finishing mid-edit cannot clobber what the user is
 * typing: their ops are replayed over the new server state and then saved, and the
 * server's merge protects edited items too.
 */
export function useKitEditor(id: string) {
  const [record, setRecord] = useState<KitRecord | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState<KitOp[]>([]);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const inFlight = useRef(false);
  const pendingRef = useRef<KitOp[]>([]);
  pendingRef.current = pending;

  const load = useCallback(async () => {
    try {
      const r = await api<KitRecord>(`/kits/${id}`);
      setRecord((prev) => newer(prev, r));
      setLoadError(null);
      return r;
    } catch (err) {
      if (err instanceof ApiError) setLoadError(err);
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while the server is doing something for this kit.
  const busy = !!record && (record.status === "queued" || record.status === "running" || record.regenerating.length > 0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [busy, load]);

  const flush = useCallback(async () => {
    if (inFlight.current || pendingRef.current.length === 0) return;
    inFlight.current = true;
    const batch = pendingRef.current;
    setSave({ kind: "saving" });
    try {
      const r = await api<KitRecord>(`/kits/${id}/ops`, { body: { ops: batch } });
      setRecord((prev) => newer(prev, r));
      setPending((p) => p.slice(batch.length));
      setSave({ kind: "saved", at: Date.now() });
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 422 || e.status === 400) {
        // The server rejected the edit (e.g. the item was removed meanwhile): drop it and resync.
        setPending((p) => p.slice(batch.length));
        void load();
      }
      setSave({ kind: "error", message: e.message });
    } finally {
      inFlight.current = false;
    }
  }, [id, load]);

  // Flush whenever there is something to send and nothing in flight.
  useEffect(() => {
    if (pending.length && save.kind !== "error") void flush();
  }, [pending, flush, save.kind]);

  const edit = useCallback((...ops: KitOp[]) => {
    setPending((p) => [...p, ...ops]);
    setSave((s) => (s.kind === "error" ? { kind: "idle" } : s));
  }, []);

  const retrySave = useCallback(() => {
    setSave({ kind: "idle" });
  }, []);

  const discardPending = useCallback(() => {
    setPending([]);
    setSave({ kind: "idle" });
  }, []);

  const kit: Kit | null = useMemo(() => (record?.kit ? applyOps(record.kit, pending) : null), [record, pending]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!pending.length) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pending.length]);

  return { record, setRecord, kit, loadError, reload: load, edit, save, pendingCount: pending.length, retrySave, discardPending };
}

/** A slow poll response must not overwrite a newer save response (every kit write bumps `version`). */
function newer(prev: KitRecord | null, next: KitRecord): KitRecord {
  if (!prev || next.version > prev.version) return next;
  if (next.version < prev.version) return prev;
  return next.updatedAt >= prev.updatedAt ? next : prev;
}
