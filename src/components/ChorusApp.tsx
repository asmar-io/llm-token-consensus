"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect } from "react";
import { forkTopAlternative } from "@/lib/client/conductor";
import { useIsDesktop } from "@/lib/client/hooks";
import { fetchChoir, MOCK_CHOIR } from "@/lib/client/sse";
import { getActiveTake, LENSES, useActiveTake, useChorus, visibleCount, type Theme } from "@/lib/client/store";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { Header } from "./Header";
import { Inspector } from "./Inspector";
import { Mixer } from "./Mixer";
import { Sheet } from "./Sheet";
import { Stage } from "./Stage";
import { TokenTooltip } from "./TokenTooltip";

export function ChorusApp() {
  const isDesktop = useIsDesktop();
  const take = useActiveTake();
  const selected = useChorus((s) => s.selected);
  const mixerSheet = useChorus((s) => s.mixerSheet);
  const announce = useChorus((s) => s.announce);

  useBoot();
  useThemeSync();
  useKeyboard();

  const closeInspector = () => useChorus.setState({ selected: null, hover: null });

  return (
    <MotionConfig reducedMotion="user">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink">
        Skip to the performance
      </a>
      <Header showMixerButton={!isDesktop} />

      <div className="mx-auto w-full max-w-[1440px] flex-1 px-4 sm:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-10 xl:grid-cols-[minmax(0,1fr)_440px] xl:gap-14">
        <main id="main" className={`min-w-0 py-8 lg:py-12 ${!isDesktop && selected != null ? "pb-[64dvh]" : "pb-24"}`}>
          <div className="mx-auto max-w-[46rem]">
            {take ? (
              <>
                <div className="mb-10">
                  <Composer large={false} />
                </div>
                <Stage />
              </>
            ) : (
              <Landing />
            )}
          </div>
        </main>

        {isDesktop && <DeskPanel onCloseInspector={closeInspector} />}
      </div>

      {!isDesktop && (
        <>
          <Sheet open={selected != null && !!take} onClose={closeInspector} label="Token inspector">
            <Inspector onClose={closeInspector} />
          </Sheet>
          <Sheet open={mixerSheet} onClose={() => useChorus.setState({ mixerSheet: false })} label="Mixer" modal>
            <Mixer />
          </Sheet>
        </>
      )}

      <TokenTooltip />
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announce}
      </div>
    </MotionConfig>
  );
}

function Landing() {
  return (
    <div className="flex flex-col gap-10 pt-2 lg:pt-8">
      <EmptyState>
        <Composer large />
      </EmptyState>
    </div>
  );
}

function DeskPanel({ onCloseInspector }: { onCloseInspector: () => void }) {
  const panel = useChorus((s) => s.panel);
  const tabs = [
    { id: "inspector" as const, label: "Inspector" },
    { id: "mixer" as const, label: "Mixer" },
  ];
  return (
    <aside aria-label="Desk" className="sticky top-14 flex h-[calc(100dvh-3.5rem)] flex-col border-l border-line">
      <div role="tablist" aria-label="Desk panels" className="flex shrink-0 gap-1 border-b border-line px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={panel === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => useChorus.setState({ panel: t.id })}
            className={`relative h-11 px-3 text-sm transition-colors ${panel === t.id ? "text-ink" : "text-ink-3 hover:text-ink-2"}`}
          >
            {t.label}
            {panel === t.id && <motion.span layoutId="tab-ink" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>
      <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto bg-raised/40">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={panel}
            id={`panel-${panel}`}
            role="tabpanel"
            aria-labelledby={`tab-${panel}`}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8, transition: { duration: 0.1 } }}
            transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}
          >
            {panel === "inspector" ? <Inspector onClose={onCloseInspector} /> : <Mixer />}
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ effects

function useBoot() {
  useEffect(() => {
    let cancelled = false;
    const forced = new URLSearchParams(window.location.search).get("mock") === "1";
    const go = async () => {
      if (forced) {
        useChorus.getState().setChoir(MOCK_CHOIR, true, "?mock=1");
        return;
      }
      try {
        const info = await fetchChoir();
        if (!cancelled) useChorus.getState().setChoir(info, false);
      } catch (err) {
        if (!cancelled) useChorus.getState().setChoir(MOCK_CHOIR, true, err instanceof Error ? err.message : "API unreachable");
      }
    };
    void go();
    return () => {
      cancelled = true;
    };
  }, []);
}

function useThemeSync() {
  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme") as Theme | null;
    useChorus.setState({ theme: t === "light" ? "light" : "dark" });
    const m = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("chorus-theme");
      } catch {
        /* ignore */
      }
      if (saved) return;
      const next: Theme = m.matches ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      useChorus.setState({ theme: next });
    };
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!target && (target.closest("input, textarea, select, [contenteditable='true']") != null);
      const st = useChorus.getState();

      if (e.key === "Escape") {
        if (st.mixerSheet) useChorus.setState({ mixerSheet: false });
        else if (st.selected != null) useChorus.setState({ selected: null, hover: null });
        if (typing) target?.blur();
        return;
      }
      if (typing) return;

      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("prompt")?.focus();
        return;
      }
      const lensIdx = ["1", "2", "3", "4"].indexOf(e.key);
      if (lensIdx >= 0) {
        useChorus.setState({ lens: LENSES[lensIdx].id });
        return;
      }
      const take = getActiveTake(st);
      if (!take) return;
      const count = visibleCount(take, st.replay);
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
        if (!count) return;
        // Leave arrow keys alone inside other widgets (sliders, radio groups) except tokens.
        if (target && target.closest("[role='radiogroup'], [role='tablist']") && !target.closest(".ms")) return;
        e.preventDefault();
        const cur = st.selected ?? (e.key === "ArrowLeft" ? count : -1);
        const next =
          e.key === "Home" ? 0 : e.key === "End" ? count - 1 : Math.max(0, Math.min(count - 1, cur + (e.key === "ArrowLeft" ? -1 : 1)));
        st.select(next);
        const fromToken = !!target?.closest(".ms");
        if (fromToken) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.ms [data-ti="${next}"]`)?.focus());
        return;
      }
      if (e.key === "f" || e.key === "F") {
        forkTopAlternative();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
