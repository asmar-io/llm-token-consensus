"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { agreementWord, num, pct } from "@/lib/client/format";
import { useLookup } from "@/lib/client/hooks";
import { useActiveTake, useChorus } from "@/lib/client/store";
import { TokenText } from "./TokenText";
import { VoiceMark } from "./VoiceMark";

/** Compact hover card for the token under the pointer (or keyboard focus). */
export function TokenTooltip() {
  const hover = useChorus((s) => (s.hoverSource === "text" ? s.hover : null));
  const take = useActiveTake();
  const lookup = useLookup(take);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const step = hover != null ? take?.steps[hover] : undefined;

  useLayoutEffect(() => {
    if (hover == null) return;
    const el = document.querySelector<HTMLElement>(`.ms [data-ti="${hover}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 240;
    const h = ref.current?.offsetHeight ?? 64;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    const below = r.top - h - 10 < 8;
    setPos({ x, y: below ? r.bottom + 8 : r.top - h - 8, below });
  }, [hover, step]);

  useLayoutEffect(() => {
    if (hover == null) return;
    const clear = () => useChorus.getState().setHover(null);
    window.addEventListener("scroll", clear, { passive: true });
    return () => window.removeEventListener("scroll", clear);
  }, [hover]);

  if (!step || hover == null) return null;
  const vi = lookup.index(step.lead);
  const lead = lookup.info(step.lead);
  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-max max-w-[20rem] rounded-md border border-line-strong bg-raised px-3 py-2 text-xs text-ink-2 shadow-[0_8px_24px_rgb(0_0_0/0.28)]"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-serif text-base text-ink"><TokenText t={step.token} /></span>
        <span className="num ml-auto text-ink-3">#{step.index + 1}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <VoiceMark index={vi} size={10} />
        <span>
          led by <span className="text-ink">{lead.label}</span>
        </span>
      </div>
      <div className="num mt-1 flex flex-wrap gap-x-3 text-[11px]">
        <span>
          mixed <span className="text-ink">{pct(step.p)}</span>
        </span>
        <span>
          agreement <span className="text-ink">{num(step.agreement)}</span> {agreementWord(step.agreement)}
        </span>
      </div>
    </div>
  );
}
