"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Inline editor: reads as text, becomes a textarea on click/Enter.
 * While focused it owns its draft, so polling or a save response re-rendering
 * the kit never overwrites what the user is typing. Commits are debounced while
 * typing and flushed on blur; Escape reverts.
 */
export function EditableText({
  value,
  onCommit,
  label,
  placeholder = "Click to add…",
  multiline = true,
  className = "",
  textClassName = "",
  debounceMs = 800,
  required = false,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  textClassName?: string;
  debounceMs?: number;
  required?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(value);
      committed.current = value;
    }
  }, [value, editing]);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.setSelectionRange(ref.current.value.length, ref.current.value.length);
      autosize(ref.current);
    }
  }, [editing]);

  const commit = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    const next = multiline ? text : text.replace(/\s*\n\s*/g, " ");
    if (required && !next.trim()) return;
    if (next !== committed.current) {
      committed.current = next;
      onCommit(next);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${label}`}
        className={`group block w-full cursor-text rounded-md px-1.5 py-1 text-left hover:bg-slate-50 ${className}`}
      >
        <span className={`whitespace-pre-wrap ${value ? textClassName : "italic text-slate-400"}`}>{value || placeholder}</span>
      </button>
    );
  }

  return (
    <textarea
      ref={ref}
      aria-label={label}
      value={draft}
      rows={multiline ? 3 : 1}
      onChange={(e) => {
        setDraft(e.target.value);
        autosize(e.target);
        if (timer.current) clearTimeout(timer.current);
        const text = e.target.value;
        timer.current = setTimeout(() => commit(text), debounceMs);
      }}
      onBlur={() => {
        commit(draft);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (timer.current) clearTimeout(timer.current);
          setDraft(committed.current);
          setEditing(false);
        } else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      className={`w-full resize-none rounded-md border border-brand-500 bg-white px-1.5 py-1 text-sm ring-2 ring-brand-100 focus:outline-none ${textClassName} ${className}`}
    />
  );
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}
