"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { ItemState, KitRecord, Requirement } from "@/lib/types";
import { Badge, Button } from "../ui";

export function ProvenanceBadges({ state }: { state?: ItemState }) {
  if (!state) return null;
  return (
    <>
      {state.origin === "user" && (
        <Badge tone="violet" title="You wrote this. Regeneration never replaces it.">
          Yours
        </Badge>
      )}
      {state.origin === "generated" && state.edited && (
        <Badge tone="amber" title="You edited this. Regeneration keeps it.">
          Edited
        </Badge>
      )}
      {state.pinned && (
        <Badge tone="blue" title="Pinned: regeneration keeps it.">
          Pinned
        </Badge>
      )}
    </>
  );
}

export function RequirementChip({ requirement }: { requirement: Requirement | undefined }) {
  if (!requirement) return null;
  return (
    <Badge tone={requirement.priority === "must" ? "slate" : "slate"} title={`${requirement.priority === "must" ? "Must-have" : "Nice-to-have"} · ${requirement.kind}`}>
      <span className={requirement.priority === "must" ? "font-semibold" : "font-normal opacity-80"}>
        {requirement.id}: {requirement.text.length > 40 ? `${requirement.text.slice(0, 39)}…` : requirement.text}
      </span>
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: Requirement["priority"] }) {
  return priority === "must" ? <Badge tone="red">Must</Badge> : <Badge tone="slate">Nice</Badge>;
}

/** Starts a background regeneration for one section and shows its progress from the polled record. */
export function RegenerateButton({
  record,
  section,
  body,
  label = "Regenerate",
  onStarted,
  disabledReason,
}: {
  record: KitRecord;
  section: string;
  body: Record<string, unknown>;
  label?: string;
  onStarted: () => void;
  disabledReason?: string;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = record.regenerating.some((r) => r.section === section);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        size="sm"
        loading={starting || running}
        disabled={!!disabledReason}
        title={disabledReason ?? "Replaces generated items you have not edited or pinned. Your own and edited items stay."}
        onClick={async () => {
          setStarting(true);
          setError(null);
          try {
            await api(`/kits/${record.id}/regenerate`, { body });
            onStarted();
          } catch (err) {
            setError((err as ApiError).message);
          } finally {
            setStarting(false);
          }
        }}
      >
        {running ? "Regenerating…" : label}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
