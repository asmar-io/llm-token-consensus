"use client";

import { Check, Copy, Download, Play } from "lucide-react";
import { useState } from "react";
import { agreementWord, clamp01, ms, num, pct, plural, usd } from "@/lib/client/format";
import { useLookup, useTakeSummary } from "@/lib/client/hooks";
import { voiceColorVar } from "@/lib/client/palette";
import { useChorus, type Take } from "@/lib/client/store";
import { TokenText } from "./TokenText";
import { VoiceMark } from "./VoiceMark";

export function Finale({ take }: { take: Take }) {
  const summary = useTakeSummary(take);
  const lookup = useLookup(take);
  const [copied, setCopied] = useState(false);
  if (!summary) return null;

  const title =
    take.status === "stopped"
      ? `Stopped by you after ${plural(take.steps.length, "token")}`
      : take.reason === "eos"
        ? "The choir chose to end here"
        : take.reason === "max_tokens"
          ? `Reached the ${take.request?.maxTokens ?? take.steps.length}-token limit`
          : "Finale";

  const ranked = take.voices
    .map((v, i) => ({ v, i, inf: summary.influence[v.id] ?? 0, led: summary.led[v.id] ?? 0 }))
    .sort((a, b) => b.inf - a.inf);

  const text = take.steps.map((s) => s.token).join("");

  return (
    <section aria-labelledby="finale-h" className="mt-10 rounded-xl border border-line bg-raised p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <p className="eyebrow">Finale · Take {take.n}</p>
          <h2 id="finale-h" className="mt-1 font-serif text-2xl text-ink">
            {title}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionBtn
            onClick={() => {
              useChorus.setState({ replay: { takeId: take.id, cursor: 0, playing: true, speed: 1, session: Date.now() }, selected: null });
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            icon={<Play size={14} />}
          >
            Replay
          </ActionBtn>
          <ActionBtn
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              } catch {
                /* clipboard blocked */
              }
            }}
            icon={copied ? <Check size={14} /> : <Copy size={14} />}
          >
            {copied ? "Copied" : "Copy text"}
          </ActionBtn>
          <ActionBtn onClick={() => exportTake(take)} icon={<Download size={14} />}>
            Export JSON
          </ActionBtn>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        <Fig label="Tokens" value={String(summary.tokens)} />
        <Fig label="Mean agreement" value={num(summary.agreement)} sub={agreementWord(summary.agreement)} />
        <Fig label="Time" value={ms(summary.elapsedMs)} />
        <Fig label="Cost" value={usd(summary.costUsd)} sub={take.mode === "demo" && !take.mock ? "when recorded" : undefined} />
      </dl>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="eyebrow mb-3">Who carried the text</h3>
          <ul className="flex flex-col gap-2.5">
            {ranked.map(({ v, i, inf, led }) => (
              <li key={v.id}>
                <div className="flex items-center gap-2 text-sm">
                  <VoiceMark index={i} size={11} />
                  <span className="text-ink">{v.label}</span>
                  <span className="text-xs text-ink-3">{v.lab}</span>
                  <span className="num ml-auto text-xs text-ink-2">
                    {pct(inf, 0)} · led {led}
                  </span>
                </div>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
                  <span className="bar block h-full rounded-full" style={{ transform: `scaleX(${clamp01(inf)})`, background: voiceColorVar(i) }} />
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="eyebrow mb-1">Most contested moments</h3>
          <p className="mb-3 text-xs text-ink-3">Where the voices disagreed most. Click one to inspect it.</p>
          {summary.contested.length === 0 ? (
            <p className="text-sm text-ink-2">No contested tokens in this take.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {summary.contested.map((idx) => {
                const s = take.steps[idx];
                if (!s) return null;
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => useChorus.getState().select(idx)}
                    className="group flex items-baseline gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5 text-left transition-colors hover:border-heat"
                  >
                    <span className="font-serif text-base text-ink"><TokenText t={s.token} /></span>
                    <span className="num text-[11px] text-ink-3 group-hover:text-heat">
                      #{idx + 1} · {num(s.agreement)}
                    </span>
                    <span className="sr-only">led by {lookup.info(s.lead).label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Fig({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-raised p-3">
      <dt className="text-[11px] font-medium text-ink-3">{label}</dt>
      <dd className="num mt-0.5 text-lg text-ink">{value}</dd>
      {sub && <dd className="text-xs text-ink-3">{sub}</dd>}
    </div>
  );
}

export function ActionBtn({ onClick, icon, children }: { onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
    >
      <span aria-hidden="true">{icon}</span>
      {children}
    </button>
  );
}

function exportTake(take: Take) {
  const data = {
    take: take.n,
    prompt: take.prompt,
    mode: take.mode,
    mock: take.mock,
    request: take.request,
    forkedFrom: take.parentId ? { index: take.forkIndex, token: take.forkToken } : null,
    status: take.status,
    reason: take.reason ?? null,
    voices: take.voices,
    summary: take.summary ?? null,
    steps: take.steps,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `chorus-take-${take.n}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
