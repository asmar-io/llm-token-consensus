"use client";

import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { performPrompt, stop } from "@/lib/client/conductor";
import { singingCount, useActiveTake, useChorus } from "@/lib/client/store";

export function Composer({ large }: { large: boolean }) {
  const prompt = useChorus((s) => s.prompt);
  const choir = useChorus((s) => s.choir);
  const singing = useChorus((s) => singingCount(s));
  const take = useActiveTake();
  const running = take?.status === "performing" || take?.status === "connecting";
  const ref = useRef<HTMLTextAreaElement>(null);
  const canPerform = !!choir && prompt.trim().length > 0 && singing > 0;

  // Grow with content.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [prompt, large]);

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (running) stop();
          else if (canPerform) performPrompt();
        }}
        className={`group relative flex items-end gap-2 rounded-xl border border-line-strong bg-raised transition-colors focus-within:border-accent ${large ? "p-3 sm:p-4" : "p-2"}`}
      >
        <label htmlFor="prompt" className="sr-only">
          Prompt for the choir
        </label>
        <textarea
          id="prompt"
          ref={ref}
          rows={1}
          value={prompt}
          onChange={(e) => useChorus.setState({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canPerform && !running) performPrompt();
            }
          }}
          placeholder="Ask the choir anything…"
          className={`min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-ink placeholder:text-ink-3 focus:outline-none ${large ? "font-serif text-xl sm:text-2xl" : "font-serif text-lg"}`}
        />
        {running ? (
          <button
            type="submit"
            className="flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line-strong bg-sunk px-3.5 text-sm font-medium text-ink transition-colors hover:border-danger hover:text-danger"
          >
            <Square size={13} fill="currentColor" aria-hidden="true" /> Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canPerform}
            className="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-ink transition-[opacity,transform] hover:opacity-90 active:scale-[0.97] disabled:opacity-40"
          >
            Perform <ArrowUp size={15} aria-hidden="true" />
          </button>
        )}
      </form>
      {choir && singing === 0 && (
        <p role="alert" className="text-xs text-danger">
          Every voice is muted in the mixer. Unmute at least one to perform.
        </p>
      )}
      {large && choir && choir.samplePrompts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow mr-1">Try</span>
          {choir.samplePrompts.map((p) => (
            <button
              key={p}
              type="button"
              disabled={singing === 0}
              onClick={() => {
                useChorus.setState({ prompt: p });
                performPrompt(p);
              }}
              className="rounded-full border border-line px-3 py-1.5 text-left text-[13px] text-ink-2 transition-colors hover:border-accent hover:text-ink disabled:opacity-40"
            >
              {p}
            </button>
          ))}
        </div>
      )}
      <p className={`text-[11px] text-ink-3 ${large ? "hidden sm:block" : "hidden"}`}>
        Enter performs · Shift+Enter for a new line · <kbd className="num">/</kbd> focuses this box
      </p>
    </div>
  );
}
