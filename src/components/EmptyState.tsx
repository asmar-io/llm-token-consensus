"use client";

import { useChorus } from "@/lib/client/store";
import { VoiceMark } from "./VoiceMark";

export function EmptyState({ children }: { children?: React.ReactNode }) {
  const choir = useChorus((s) => s.choir);
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
          <h2 id="choir-h" className="eyebrow mb-3">
            Tonight&apos;s choir · {choir.voices.length} voices
          </h2>
          <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
            {choir.voices.map((v, i) => (
              <li key={v.id} className="flex gap-3 bg-raised p-4">
                <VoiceMark index={i} size={14} className="mt-1" />
                <div className="min-w-0">
                  <p className="text-[15px] font-medium text-ink">{v.label}</p>
                  <p className="text-xs text-ink-3">
                    {v.lab} · {v.origin}
                    {v.simulated && " · simulated"}
                  </p>
                  {v.blurb && <p className="mt-1.5 text-[13px] leading-snug text-ink-2">{v.blurb}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
