"use client";

import { Pause, Play, X } from "lucide-react";
import { useEffect, useId, type CSSProperties } from "react";
import { playNote } from "@/lib/client/audio";
import { heatOf } from "@/lib/client/format";
import { useLookup } from "@/lib/client/hooks";
import { useChorus, type Take } from "@/lib/client/store";

const SPEEDS = [0.5, 1, 2, 4];

export function ReplayBar({ take }: { take: Take }) {
  const replay = useChorus((s) => (s.replay?.takeId === take.id ? s.replay : null));
  const lookup = useLookup(take);
  const id = useId();
  const total = take.steps.length;

  useEffect(() => {
    if (!replay?.playing) return;
    if (replay.cursor >= total) {
      useChorus.setState({ replay: { ...replay, playing: false } });
      return;
    }
    const step = take.steps[replay.cursor];
    const base = Number.isFinite(step?.elapsedMs) ? step.elapsedMs : 90;
    const delay = Math.max(25, Math.min(400, base)) / replay.speed;
    const t = setTimeout(() => {
      const st = useChorus.getState();
      if (!st.replay || st.replay.takeId !== take.id) return;
      if (st.sound && step) playNote(lookup.index(step.lead), heatOf(step.agreement));
      useChorus.setState({ replay: { ...st.replay, cursor: st.replay.cursor + 1 } });
    }, delay);
    return () => clearTimeout(t);
  }, [replay, total, take, lookup]);

  if (!replay) return null;
  const set = (p: Partial<typeof replay>) => useChorus.setState({ replay: { ...replay, ...p } });

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-line-strong bg-raised/95 px-3 py-2 backdrop-blur-sm">
      <span className="eyebrow">Replay</span>
      <button
        type="button"
        onClick={() => set(replay.cursor >= total ? { cursor: 0, playing: true, session: Date.now() } : { playing: !replay.playing })}
        aria-label={replay.playing ? "Pause replay" : "Play replay"}
        className="grid size-9 place-items-center rounded-md bg-accent text-accent-ink"
      >
        {replay.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <label htmlFor={id} className="sr-only">
        Replay position
      </label>
      <input
        id={id}
        type="range"
        className="fader min-w-[8rem] flex-1"
        min={0}
        max={total}
        step={1}
        value={replay.cursor}
        onChange={(e) => set({ cursor: Number(e.target.value), playing: false })}
        style={{ "--fill": `${total ? (replay.cursor / total) * 100 : 0}%` } as CSSProperties}
      />
      <span className="num w-16 text-right text-xs text-ink-2">
        {replay.cursor}/{total}
      </span>
      <div role="radiogroup" aria-label="Replay speed" className="flex rounded-md border border-line p-0.5">
        {SPEEDS.map((sp) => (
          <button
            key={sp}
            type="button"
            role="radio"
            aria-checked={replay.speed === sp}
            onClick={() => set({ speed: sp })}
            className={`num h-7 rounded px-2 text-xs ${replay.speed === sp ? "bg-sunk text-ink" : "text-ink-3 hover:text-ink"}`}
          >
            {sp}×
          </button>
        ))}
      </div>
      <button type="button" onClick={() => useChorus.setState({ replay: null })} aria-label="Exit replay" className="grid size-9 place-items-center rounded-md text-ink-2 hover:bg-sunk hover:text-ink">
        <X size={16} />
      </button>
    </div>
  );
}
