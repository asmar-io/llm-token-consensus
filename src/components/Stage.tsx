"use client";

import { AlertTriangle, GitBranch, RotateCcw } from "lucide-react";
import { useState } from "react";
import { retry } from "@/lib/client/conductor";
import { clamp01, ms, pct, plural } from "@/lib/client/format";
import { useIsDesktop, useTakeSummary } from "@/lib/client/hooks";
import { voiceColorVar } from "@/lib/client/palette";
import { LENSES, useActiveTake, useChorus, visibleCount, type Take } from "@/lib/client/store";
import { Finale } from "./Finale";
import { Manuscript, useFollowSelection } from "./Manuscript";
import { ReplayBar } from "./ReplayBar";
import { Score } from "./Score";
import { TokenText } from "./TokenText";
import { VoiceMark } from "./VoiceMark";

/** Everything about the active take: takes, prompt, lenses, legend, text, score, finale. */
export function Stage() {
  const take = useActiveTake();
  const replay = useChorus((s) => s.replay);
  const isDesktop = useIsDesktop();
  useFollowSelection(!isDesktop);
  if (!take) return null;
  const count = visibleCount(take, replay);
  const replaying = replay?.takeId === take.id;
  const done = take.status === "finished" || take.status === "stopped";
  // Remount the text when the take or replay session changes, so only fresh tokens animate in.
  const msKey = `${take.id}:${replaying ? replay.session : "live"}`;

  return (
    <div className="flex min-w-0 flex-col">
      <TakeSwitcher />
      {replaying && <ReplayBar take={take} />}

      <div className="mb-5">
        <p className="eyebrow mb-1.5">Prompt</p>
        <p className="font-serif text-lg italic leading-snug text-ink-2">{take.prompt}</p>
      </div>

      <div className="sticky top-14 z-10 -mx-4 border-b border-line bg-bg/92 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <LensBar />
          <VoiceLegend take={take} count={count} />
        </div>
      </div>
      <div className="mb-6 mt-2">
        <LensKey />
      </div>

      <article aria-label={`Take ${take.n}`} className="min-h-[6rem]">
        {take.status === "connecting" && take.steps.length === 0 ? (
          <p className="flex items-center gap-3 font-serif text-xl italic text-ink-3">
            <span className="performing-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            The choir is taking its breath…
          </p>
        ) : (
          <Manuscript key={msKey} take={take} count={count} enterFrom={replaying ? 0 : take.steps.length} />
        )}
      </article>

      <StatusLine take={take} count={count} />
      {take.steps.length > 0 && <Score take={take} count={count} />}
      {done && !replaying && take.steps.length > 0 && <Finale take={take} />}
    </div>
  );
}

function TakeSwitcher() {
  const takes = useChorus((s) => s.takes);
  const active = useChorus((s) => s.activeTakeId);
  if (takes.length < 2) return null;
  return (
    <nav aria-label="Takes" className="mb-6 flex flex-wrap items-center gap-2">
      <span className="eyebrow mr-1">Takes</span>
      {takes.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            aria-current={on ? "true" : undefined}
            onClick={() => useChorus.setState({ activeTakeId: t.id, replay: null, hover: null })}
            className={`flex h-9 items-center gap-2 rounded-full border px-3 text-sm transition-colors ${on ? "border-accent bg-accent/10 text-ink" : "border-line text-ink-2 hover:border-line-strong hover:text-ink"}`}
          >
            {t.parentId && <GitBranch size={13} aria-hidden="true" className="text-accent" />}
            <span className="font-medium">Take {t.n}</span>
            {t.forkIndex != null && (
              <span className="text-xs text-ink-3">
                from #{t.forkIndex + 1} <span className="font-serif text-[13px] text-ink-2"><TokenText t={t.forkToken} /></span>
              </span>
            )}
            {(t.status === "performing" || t.status === "connecting") && (
              <span className="performing-dots" aria-label="performing">
                <span />
                <span />
                <span />
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

function LensBar() {
  const lens = useChorus((s) => s.lens);
  return (
    <div className="flex items-center">
      <div role="radiogroup" aria-label="Lens: how tokens are tinted" className="flex rounded-lg border border-line bg-sunk p-0.5">
        {LENSES.map((l, k) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={lens === l.id}
            title={`${l.hint} (key ${k + 1})`}
            onClick={() => useChorus.setState({ lens: l.id })}
            className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors sm:px-3 ${lens === l.id ? "bg-raised font-medium text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]" : "text-ink-2 hover:text-ink"}`}
          >
            {l.label}
            <kbd className="num hidden text-[10px] text-ink-3 lg:inline">{k + 1}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}

function LensKey() {
  const lens = useChorus((s) => s.lens);
  const ramp = (c: string) => (
    <span className="flex h-2.5 w-16 overflow-hidden rounded-sm border border-line" aria-hidden="true">
      {[0.04, 0.2, 0.4, 0.6, 0.8].map((a) => (
        <span key={a} className="flex-1" style={{ background: `color-mix(in oklab, ${c} ${a * 100}%, transparent)` }} />
      ))}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
      {lens === "agreement" && (
        <span className="flex items-center gap-1.5">
          agreed {ramp("var(--heat)")} split <span className="ml-1 border-b-2 border-heat leading-none text-ink-2">underlined</span> = deeply split
        </span>
      )}
      {lens === "confidence" && (
        <span className="flex items-center gap-1.5">
          sure {ramp("var(--cool)")} unsure <span className="ml-1 text-ink-2 underline decoration-cool decoration-dotted underline-offset-2">dotted</span> = under 50%
        </span>
      )}
      {lens === "voice" && <span>Tint and underline show the voice that carried each token.</span>}
      <span className="flex items-center gap-1">
        <span className="inline-block size-1.5 rotate-45 bg-accent" aria-hidden="true" /> forced by a fork
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block size-2 rounded-full border-[1.5px] border-ink-3" aria-hidden="true" /> a voice sat out
      </span>
    </div>
  );
}

function VoiceLegend({ take, count }: { take: Take; count: number }) {
  const summary = useTakeSummary(take, count);
  return (
    <ul aria-label="Voices and their running influence" className="flex flex-wrap gap-x-3.5 gap-y-1">
      {take.voices.map((v, i) => {
        const inf = summary?.influence[v.id] ?? 0;
        const muted = take.request?.voices.find((rv) => rv.id === v.id)?.weight === 0;
        return (
          <li key={v.id} className="flex items-center gap-1.5 text-xs" title={`${v.label} · ${v.lab} · ${v.origin}${v.blurb ? ` — ${v.blurb}` : ""}`}>
            <VoiceMark index={i} size={10} hollow={muted} />
            <span className={muted ? "text-ink-3" : "text-ink"}>{v.label}</span>
            <span className="sr-only">
              {v.lab}, {v.origin}
            </span>
            <span className="h-1 w-8 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <span className="bar block h-full" style={{ transform: `scaleX(${clamp01(inf)})`, background: voiceColorVar(i) }} />
            </span>
            <span className="num w-7 text-ink-2">{muted ? "—" : pct(inf, 0)}</span>
            {muted && <span className="sr-only">listening only</span>}
          </li>
        );
      })}
    </ul>
  );
}

function StatusLine({ take, count }: { take: Take; count: number }) {
  const [showAll, setShowAll] = useState(false);
  const elapsed = take.steps.reduce((a, s) => a + (Number.isFinite(s.elapsedMs) ? s.elapsedMs : 0), 0);
  let text: React.ReactNode;
  switch (take.status) {
    case "connecting":
      text = "Connecting to the choir…";
      break;
    case "performing":
      text = (
        <span className="flex items-center gap-2">
          <span className="performing-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          Performing · <span className="num">{count}</span> tokens · <span className="num">{ms(elapsed)}</span>
        </span>
      );
      break;
    case "stopped":
      text = `Stopped by you after ${plural(take.steps.length, "token")}.`;
      break;
    case "finished":
      text =
        take.reason === "eos"
          ? `Finished: the choir chose to end after ${plural(take.steps.length, "token")}.`
          : `Finished: reached the ${take.request?.maxTokens ?? take.steps.length}-token limit.`;
      break;
    default:
      text = null;
  }
  const notices = take.notices;
  return (
    <div className="mt-6 flex flex-col gap-2">
      {text && <p className="text-sm text-ink-3">{text}</p>}
      {take.status === "error" && (
        <div role="alert" className="flex flex-wrap items-start gap-3 rounded-lg border border-danger/50 bg-danger/5 p-3 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
          <div className="mr-auto min-w-0">
            <p className="font-medium text-ink">The performance stopped with an error.</p>
            <p className="mt-0.5 break-words text-ink-2">{take.error}</p>
          </div>
          <button
            type="button"
            onClick={() => retry(take.id)}
            className="flex h-9 items-center gap-1.5 rounded-md border border-line-strong px-3 text-ink transition-colors hover:border-accent"
          >
            <RotateCcw size={14} aria-hidden="true" /> Retry
          </button>
        </div>
      )}
      {notices.length > 0 && (
        <div className="text-xs text-ink-3">
          <p>
            {notices[notices.length - 1].message}
            {notices.length > 1 && (
              <>
                {" "}
                <button type="button" className="underline decoration-line-strong underline-offset-2 hover:text-ink" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "Hide" : `${notices.length - 1} more`}
                </button>
              </>
            )}
          </p>
          {showAll && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {notices.slice(0, -1).map((n, k) => (
                <li key={k}>{n.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
