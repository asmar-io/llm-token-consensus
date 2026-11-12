"use client";

import { Check } from "lucide-react";
import { MIN_VOICES, selectedVoices, useChorus } from "@/lib/client/store";
import { Faq } from "./Faq";
import { VoiceMark } from "./VoiceMark";

export function EmptyState({ children }: { children?: React.ReactNode }) {
  const choir = useChorus((s) => s.choir);
  const channels = useChorus((s) => s.channels);
  const selected = selectedVoices({ choir, channels });
  const pickable = choir?.mode === "live" && (choir?.voices.length ?? 0) > MIN_VOICES;
  return (
    <div className="flex flex-col gap-10">
      <div className="max-w-2xl">
        <h1 className="font-serif text-[2.6rem] leading-[1.05] tracking-tight text-ink sm:text-6xl">
          Many voices,
          <br />
          <span className="italic text-accent">one text.</span>
        </h1>
        <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-2">
          For every next token, several language models from different labs each give their odds. Chorus blends them, draws one token, and moves on, so no single lab decides the answer.
          Click any word afterwards to see who carried it, where the voices split, and what they would have said instead.
        </p>
      </div>

      {children}

      {choir && (
        <section aria-labelledby="choir-h">
          <h2 id="choir-h" className="eyebrow mb-1">
            {pickable ? `Tonight's choir · ${selected.length} of ${choir.voices.length} models` : `Tonight's choir · ${choir.voices.length} voices`}
          </h2>
          <p className="mb-3 text-xs text-ink-3">
            {pickable
              ? "Pick two or more. Each model here was verified to continue a partial answer and report its odds."
              : choir.mode === "demo"
                ? "The models heard in the recorded performances."
                : "The models that will sing."}
          </p>
          <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
            {choir.voices.map((v) => {
              const idx = selected.findIndex((x) => x.id === v.id);
              const on = idx >= 0;
              const locked = on && selected.length <= MIN_VOICES;
              const body = (
                <>
                  <VoiceMark index={idx} size={14} className="mt-1" hollow={!on} />
                  <div className="min-w-0 flex-1 text-left">
                    <p className={`text-[15px] font-medium ${on ? "text-ink" : "text-ink-2"}`}>{v.label}</p>
                    <p className="text-xs text-ink-3">
                      {v.lab} · {v.origin}
                    </p>
                    {v.blurb && <p className="mt-1.5 text-[13px] leading-snug text-ink-2">{v.blurb}</p>}
                  </div>
                  {pickable && (
                    <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded border ${on ? "border-accent bg-accent text-accent-ink" : "border-line-strong"}`} aria-hidden="true">
                      {on && <Check size={14} strokeWidth={3} />}
                    </span>
                  )}
                </>
              );
              return (
                <li key={v.id} className="bg-raised">
                  {pickable ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      disabled={locked}
                      title={locked ? "A choir needs at least two voices" : undefined}
                      onClick={() => useChorus.getState().toggleVoice(v.id)}
                      className={`flex h-full w-full gap-3 p-4 transition-colors hover:bg-sunk/60 disabled:cursor-not-allowed ${on ? "" : "opacity-70"}`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex gap-3 p-4">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Faq />
    </div>
  );
}
