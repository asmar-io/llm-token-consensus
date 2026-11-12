"use client";

import { memo, useEffect, useState, type CSSProperties } from "react";
import type { Step } from "@/lib/protocol";
import { clamp01, heatOf } from "@/lib/client/format";
import { useLookup } from "@/lib/client/hooks";
import { voiceColorVar } from "@/lib/client/palette";
import { useChorus, type Take } from "@/lib/client/store";

interface TokenProps {
  step: Step;
  vi: number;
  enter: boolean;
  forkPoint: boolean;
}

/**
 * One token. Memoised on stable props (the Step object never changes once
 * received); selection, hover and focus each subscribe to a boolean so only
 * the tokens whose state changed re-render.
 */
const Token = memo(function Token({ step, vi, enter, forkPoint }: TokenProps) {
  const i = step.index;
  const sel = useChorus((s) => s.selected === i);
  const hov = useChorus((s) => s.hover === i && s.hoverSource === "score");
  const tabbable = useChorus((s) => (s.selected == null ? i === 0 : s.selected === i));

  const t = step.token ?? "";
  const lead = t.match(/^\s*/)?.[0] ?? "";
  const core = t.slice(lead.length).replace(/\s+$/, "");
  const trail = t.slice(lead.length + core.length);
  const heat = heatOf(step.agreement);
  const p = clamp01(step.p);
  const failed = step.ballots?.some((b) => b.failed) ?? false;

  const style = { "--vc": voiceColorVar(vi), "--h": heat.toFixed(3), "--p": p.toFixed(3) } as CSSProperties;
  const attrs = {
    "data-ti": i,
    "aria-pressed": sel,
    tabIndex: tabbable ? 0 : -1,
    "data-split": heat > 0.66 ? "" : undefined,
    "data-unsure": p < 0.5 ? "" : undefined,
    "data-forced": step.forced ? "" : undefined,
    "data-failed": failed ? "" : undefined,
    "data-hov": hov ? "" : undefined,
    style,
    type: "button" as const,
  };
  const rule = forkPoint ? <span className="fork-rule" aria-hidden="true" title="This take branches here" /> : null;

  if (!core) {
    // Whitespace-only piece: a small visible glyph to click, then the whitespace itself.
    const nl = lead.includes("\n");
    return (
      <>
        {rule}
        <button {...attrs} className={`tok glyph${enter ? " enter" : ""}`} aria-label={nl ? `line break, token ${i + 1}` : `space, token ${i + 1}`}>
          {nl ? "↵" : "␣"}
        </button>
        {lead}
      </>
    );
  }
  return (
    <>
      {lead}
      {rule}
      <button {...attrs} className={`tok${enter ? " enter" : ""}`}>
        {core}
      </button>
      {trail}
    </>
  );
});

export function Manuscript({ take, count, enterFrom }: { take: Take; count: number; enterFrom: number }) {
  const lens = useChorus((s) => s.lens);
  const lookup = useLookup(take);
  // Captured once per mount: tokens already present do not animate, later ones do.
  const [from] = useState(enterFrom);
  const performing = take.status === "performing" || take.status === "connecting";
  const replaying = useChorus((s) => s.replay?.takeId === take.id && s.replay.playing);
  const steps = take.steps.length === count ? take.steps : take.steps.slice(0, count);

  return (
    <div
      className="ms"
      data-lens={lens}
      role="group"
      aria-label="The performance. Each token is a button; use the left and right arrow keys to move between them."
      onPointerOver={(e) => {
        if (e.pointerType === "touch") return;
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ti]");
        useChorus.getState().setHover(el ? Number(el.dataset.ti) : null, "text");
      }}
      onPointerLeave={() => useChorus.getState().setHover(null)}
      onFocus={(e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ti]");
        if (el && e.target.matches(":focus-visible")) useChorus.getState().setHover(Number(el.dataset.ti), "text");
      }}
      onBlur={() => useChorus.getState().setHover(null)}
      onClick={(e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ti]");
        if (!el) return;
        const i = Number(el.dataset.ti);
        const st = useChorus.getState();
        st.select(i);
        if (st.replay?.playing) useChorus.setState({ replay: { ...st.replay, playing: false } });
      }}
    >
      {steps.map((s) => (
        <Token key={s.index} step={s} vi={lookup.index(s.lead)} enter={s.index >= from} forkPoint={s.index === take.forkIndex} />
      ))}
      {(performing || replaying) && <span className="caret" aria-hidden="true" />}
    </div>
  );
}

/** Keeps the selected token in view and focused when it is moved by keyboard or a chip. */
export function useFollowSelection(center: boolean) {
  const selected = useChorus((s) => s.selected);
  useEffect(() => {
    if (selected == null) return;
    const el = document.querySelector<HTMLElement>(`.ms [data-ti="${selected}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    // On phones the bottom sheet covers the lower part of the screen.
    // The header plus the sticky lens bar cover roughly the top 170px.
    const topLimit = 170;
    const bottomLimit = center ? window.innerHeight * 0.36 : window.innerHeight - 48;
    if (r.top < topLimit || r.bottom > bottomLimit) {
      const target = center ? topLimit + 8 : window.innerHeight / 2 - r.height / 2;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: window.scrollY + r.top - target, behavior: reduce ? "auto" : "smooth" });
    }
  }, [selected, center]);
}
