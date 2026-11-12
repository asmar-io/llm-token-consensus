"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { agreementWord, heatOf, num, pct } from "@/lib/client/format";
import { useLookup } from "@/lib/client/hooks";
import { useChorus, type Take } from "@/lib/client/store";
import { TokenText } from "./TokenText";
import { VoiceMark, drawShape } from "./VoiceMark";

const COL = 11; // px per step
const LANE = 16; // px per voice lane
const TOP = 14; // agreement strip
const GAP = 4;

/**
 * The score: one lane per voice, one column per step. Each cell's strength is
 * how much that voice backed the chosen token (pChosen); the lead is marked
 * with its shape. Drawn on a viewport-sized canvas so 400+ steps stay cheap.
 */
export function Score({ take, count }: { take: Take; count: number }) {
  const lookup = useLookup(take);
  const voices = take.voices;
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const followRef = useRef(true);
  const theme = useChorus((s) => s.theme);
  const selected = useChorus((s) => s.selected);
  const hover = useChorus((s) => s.hover);
  const [readout, setReadout] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const height = TOP + GAP + voices.length * LANE + 4;

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const sc = scrollRef.current;
    if (!cv || !sc) return;
    const dpr = window.devicePixelRatio || 1;
    const w = sc.clientWidth;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(height * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(height * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${height}px`;
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const col = (n: string) => css.getPropertyValue(n).trim() || "#888";
    const vcols = Array.from({ length: 6 }, (_, k) => col(`--v${k}`));
    const ink3 = col("--ink-3");
    const line = col("--line");
    const heatC = col("--heat");
    const accent = col("--accent");
    const ink = col("--ink");

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const sl = sc.scrollLeft;
    const first = Math.max(0, Math.floor(sl / COL) - 1);
    const last = Math.min(count - 1, Math.ceil((sl + w) / COL) + 1);
    const st = useChorus.getState();

    // lane guides
    ctx.fillStyle = line;
    for (let v = 0; v < voices.length; v++) ctx.fillRect(0, TOP + GAP + v * LANE + LANE - 1, w, 1);

    for (let i = first; i <= last; i++) {
      const s = take.steps[i];
      if (!s) continue;
      const x = i * COL - sl;
      if (i === st.hover) {
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = ink;
        ctx.fillRect(x, 0, COL, height);
        ctx.globalAlpha = 1;
      }
      // agreement strip: calm = faint, hot = heat colour
      const h = heatOf(s.agreement);
      ctx.globalAlpha = 0.12 + h * 0.88;
      ctx.fillStyle = h > 0.05 ? heatC : ink3;
      ctx.fillRect(x + 1, TOP - 8 - h * 4, COL - 2, 8 + h * 4);
      ctx.globalAlpha = 1;

      voices.forEach((vInfo, v) => {
        const b = s.ballots.find((bb) => bb.voiceId === vInfo.id);
        const y = TOP + GAP + v * LANE;
        if (!b) return;
        const c = vcols[v % 6];
        if (b.failed) {
          ctx.strokeStyle = ink3;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 2.5, y + 4.5, COL - 5, LANE - 9);
          return;
        }
        const p = Math.max(0, Math.min(1, Number.isFinite(b.pChosen) ? b.pChosen : 0));
        ctx.fillStyle = c;
        ctx.globalAlpha = b.weight === 0 ? 0.08 + p * 0.25 : 0.1 + p * 0.9;
        const hgt = 3 + p * (LANE - 6);
        ctx.fillRect(x + 1, y + (LANE - 1 - hgt) / 2 + 0.5, COL - 2, hgt);
        ctx.globalAlpha = 1;
        if (s.lead === vInfo.id) {
          ctx.fillStyle = ink;
          drawShape(ctx, v, x + COL / 2, y + LANE / 2 - 0.5, 2.6);
        }
      });

      if (s.forced || i === take.forkIndex) {
        ctx.fillStyle = accent;
        ctx.fillRect(x, 0, 2, height);
      }
      if (i === st.selected) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, 1, COL - 2, height - 2);
      }
    }
  }, [count, height, take.steps, take.forkIndex, voices]);

  // Size tracking.
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => setWidth(sc.clientWidth));
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);

  // Follow the performance while the user is at the right edge.
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    if (followRef.current) sc.scrollLeft = sc.scrollWidth;
    draw();
  }, [count, draw, width, theme]);

  // Bring the selected column into view and redraw selection/hover.
  useEffect(() => {
    const sc = scrollRef.current;
    if (sc && selected != null) {
      const x = selected * COL;
      if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 30) {
        sc.scrollLeft = x - sc.clientWidth / 2;
        followRef.current = false;
      }
    }
    draw();
  }, [selected, hover, draw]);

  const idxAt = (clientX: number) => {
    const sc = scrollRef.current;
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    const i = Math.floor((clientX - r.left + sc.scrollLeft) / COL);
    return i >= 0 && i < count ? i : null;
  };

  const shown = readout ?? selected;
  const s = shown != null ? take.steps[shown] : undefined;
  const lead = s ? lookup.info(s.lead) : null;

  return (
    <section aria-labelledby="score-h" className="mt-10">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="score-h" className="eyebrow">
          Score
        </h2>
        <p className="min-h-[1.25rem] text-xs text-ink-3" aria-live="off">
          {s && lead ? (
            <>
              <span className="num text-ink-2">#{s.index + 1}</span> <span className="font-serif text-sm text-ink"><TokenText t={s.token} /></span> · led by {lead.label} · agreement{" "}
              <span className="num">{num(s.agreement)}</span> ({agreementWord(s.agreement)}) · mixed <span className="num">{pct(s.p)}</span>
            </>
          ) : (
            "Bar height is how strongly each voice backed the chosen token. The shape marks the lead. The top strip glows where the voices split."
          )}
        </p>
      </div>
      <div className="flex overflow-hidden rounded-lg border border-line bg-sunk">
        <div className="shrink-0 border-r border-line bg-raised py-0" style={{ height }} aria-hidden="true">
          <div className="flex items-end px-2 text-[10px] text-ink-3" style={{ height: TOP + GAP }}>
            split
          </div>
          {voices.map((v, i) => (
            <div key={v.id} className="flex items-center gap-1.5 px-2 text-[11px] text-ink-2" style={{ height: LANE }}>
              <VoiceMark index={i} size={9} />
              <span className="max-w-[5.5rem] truncate">{v.label}</span>
            </div>
          ))}
        </div>
        <div
          ref={scrollRef}
          className="scroll-thin relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          style={{ height: height + 10 }}
          onScroll={() => {
            const sc = scrollRef.current;
            if (!sc) return;
            followRef.current = sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - COL * 2;
            requestAnimationFrame(draw);
          }}
          onPointerMove={(e) => {
            const i = idxAt(e.clientX);
            setReadout(i);
            if (useChorus.getState().hover !== i) useChorus.getState().setHover(i, "score");
          }}
          onPointerLeave={() => {
            setReadout(null);
            useChorus.getState().setHover(null);
          }}
          onClick={(e) => {
            const i = idxAt(e.clientX);
            if (i != null) useChorus.getState().select(i);
          }}
          role="img"
          aria-label={`Score of ${count} tokens across ${voices.length} voices. Use the text above to move through tokens with the keyboard.`}
        >
          <canvas ref={canvasRef} className="sticky left-0 top-0 block" />
          <div style={{ width: count * COL + 40, height: 1, marginTop: -1 }} />
        </div>
      </div>
    </section>
  );
}
