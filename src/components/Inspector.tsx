"use client";

import { ChevronLeft, ChevronRight, GitBranch, X } from "lucide-react";
import type { Step, VoiceBallot, VoiceInfo } from "@/lib/protocol";
import { fork } from "@/lib/client/conductor";
import { agreementWord, bits, clamp01, entropyWord, heatOf, isEOS, ms, num, pct, showToken, usd } from "@/lib/client/format";
import { useLookup } from "@/lib/client/hooks";
import { voiceColorVar, type VoiceLookup } from "@/lib/client/palette";
import { useActiveTake, useChorus, visibleCount, type Take } from "@/lib/client/store";
import { TokenText } from "./TokenText";
import { VoiceMark } from "./VoiceMark";

export function Inspector({ onClose }: { onClose: () => void }) {
  const take = useActiveTake();
  const selected = useChorus((s) => s.selected);
  const replay = useChorus((s) => s.replay);
  const lookup = useLookup(take);
  const count = visibleCount(take, replay);
  const select = useChorus((s) => s.select);

  if (!take || selected == null) {
    return (
      <div className="flex flex-col gap-3 p-5 text-sm text-ink-2">
        <p className="eyebrow">Inspector</p>
        <p className="font-serif text-xl leading-snug text-ink">Select any word to see how the choir decided it.</p>
        <p>You will see who carried it, how far the voices agreed, what each one would have said alone, and every alternative you can fork into a new take.</p>
        <p className="text-ink-3">Keyboard: ← → move between tokens, F forks to the best unchosen alternative, Esc closes.</p>
      </div>
    );
  }

  const step: Step | undefined = take.steps[selected];
  const header = (
    <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-line bg-raised/95 px-4 py-2 backdrop-blur-sm">
      <p className="eyebrow mr-auto">
        Token <span className="num text-ink-2">{selected + 1}</span> of <span className="num text-ink-2">{Math.max(count, selected + 1)}</span>
      </p>
      <IconBtn label="Previous token" disabled={selected <= 0} onClick={() => select(selected - 1)}>
        <ChevronLeft size={16} />
      </IconBtn>
      <IconBtn label="Next token" disabled={selected >= count - 1} onClick={() => select(selected + 1)}>
        <ChevronRight size={16} />
      </IconBtn>
      <IconBtn label="Close inspector" onClick={onClose}>
        <X size={16} />
      </IconBtn>
    </div>
  );

  if (!step) {
    return (
      <div>
        {header}
        <div className="flex items-center gap-3 p-5 text-sm text-ink-2">
          {take.status === "performing" || take.status === "connecting" ? (
            <>
              <span className="performing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              Waiting for the choir to reach this token…
            </>
          ) : (
            "This token is not part of the current take."
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pb-6">
      {header}
      <StepDetail take={take} step={step} lookup={lookup} />
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-md text-ink-2 transition-colors hover:bg-sunk hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function StepDetail({ take, step, lookup }: { take: Take; step: Step; lookup: VoiceLookup }) {
  const leadIdx = lookup.index(step.lead);
  const lead = lookup.info(step.lead);
  const heat = heatOf(step.agreement);
  const singing = step.ballots.filter((b) => b.weight > 0 && !b.failed).length;

  // Ballots ordered like the choir; ballots from unknown voices go last.
  const known = take.voices.map((v) => step.ballots.find((b) => b.voiceId === v.id)).filter(Boolean) as VoiceBallot[];
  const extra = step.ballots.filter((b) => !take.voices.some((v) => v.id === b.voiceId));
  const missing = take.voices.filter((v) => !step.ballots.some((b) => b.voiceId === v.id));
  const ballots = [...known, ...extra];

  return (
    <div className="flex flex-col gap-6 px-4 pt-4 sm:px-5">
      {/* the token */}
      <section aria-label="The chosen token">
        <div className="flex flex-wrap items-end gap-3">
          <span className="rounded-md border border-line-strong bg-sunk px-3 py-1 font-serif text-[2rem] leading-tight text-ink"><TokenText t={step.token} /></span>
          <div className="flex flex-wrap gap-1.5 pb-1">
            {step.forced && <Badge tone="accent">◆ forced by a fork</Badge>}
            {step.unanimous ? <Badge tone="ok">unanimous</Badge> : <Badge tone={heat > 0.5 ? "heat" : "plain"}>not unanimous</Badge>}
            {step.ballots.some((b) => b.failed) && <Badge tone="plain">○ a voice sat out</Badge>}
          </div>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-sm text-ink-2">
          <VoiceMark index={leadIdx} size={11} />
          Carried mostly by <span className="font-medium text-ink">{lead.label}</span>
          <span className="text-ink-3">({lead.lab})</span>
        </p>
      </section>

      {/* the numbers */}
      <section aria-label="How sure the choir was" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line">
        <Stat label="Mixed probability" value={pct(step.p)} note="How likely the blended choir found this piece." meter={clamp01(step.p)} meterColor="var(--cool)" />
        <Stat
          label="Agreement"
          value={num(step.agreement)}
          tag={agreementWord(step.agreement)}
          note="How alike the voices' whole predictions were here. 1 means identical."
          meter={clamp01(step.agreement)}
          meterColor={heat > 0.5 ? "var(--heat)" : "var(--ok)"}
        />
        <Stat label="Entropy" value={bits(step.entropy)} note={`Spread of the blend: ${entropyWord(step.entropy) || "no reading"}. Lower means fewer real options.`} />
        <Stat
          label="Unanimous"
          value={step.unanimous ? "Yes" : "No"}
          note={
            step.unanimous
              ? `All ${singing} singing ${singing === 1 ? "voice" : "voices"} put this piece first.`
              : "At least one singing voice would have picked something else."
          }
        />
      </section>

      <Alternatives take={take} step={step} />

      <section aria-labelledby="votes-h">
        <h3 id="votes-h" className="eyebrow mb-3">
          How each voice voted
        </h3>
        <ul className="flex flex-col gap-2.5">
          {ballots.map((b) => (
            <BallotRow key={b.voiceId} ballot={b} info={lookup.info(b.voiceId)} index={lookup.index(b.voiceId)} step={step} isLead={b.voiceId === step.lead} />
          ))}
          {missing.map((v) => (
            <li key={v.id} className="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-ink-3">
              <VoiceMark index={lookup.index(v.id)} size={11} hollow />
              {v.label} sent no ballot for this token.
            </li>
          ))}
        </ul>
      </section>

      <p className="num text-[11px] text-ink-3">
        Step took {ms(step.elapsedMs)} · ballots cost {usd(step.ballots.reduce((a, b) => a + (Number.isFinite(b.costUsd) ? b.costUsd : 0), 0))}
      </p>
    </div>
  );
}

function Badge({ tone, children }: { tone: "accent" | "ok" | "heat" | "plain"; children: React.ReactNode }) {
  const cls =
    tone === "accent"
      ? "border-accent/50 text-accent"
      : tone === "ok"
        ? "border-ok/50 text-ok"
        : tone === "heat"
          ? "border-heat/60 text-heat"
          : "border-line-strong text-ink-2";
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

function Stat({ label, value, note, tag, meter, meterColor }: { label: string; value: string; note: string; tag?: string; meter?: number; meterColor?: string }) {
  return (
    <div className="flex flex-col gap-1 bg-raised p-3">
      <span className="text-[11px] font-medium text-ink-3">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="num text-lg text-ink">{value}</span>
        {tag && <span className="text-xs text-ink-2">{tag}</span>}
      </span>
      {meter != null && (
        <span className="h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
          <span className="bar block h-full rounded-full" style={{ transform: `scaleX(${meter})`, background: meterColor }} />
        </span>
      )}
      <span className="text-[11.5px] leading-snug text-ink-3">{note}</span>
    </div>
  );
}

function Alternatives({ take, step }: { take: Take; step: Step }) {
  const alts = step.alternatives?.length ? step.alternatives : [{ token: step.token, p: step.p }];
  const max = Math.max(...alts.map((a) => (Number.isFinite(a.p) ? a.p : 0)), 0.0001);
  return (
    <section aria-labelledby="alts-h">
      <h3 id="alts-h" className="eyebrow mb-1">
        What else it could have been
      </h3>
      <p className="mb-3 text-xs text-ink-3">The blended odds for this position. Fork any alternative to hear where the choir goes from there.</p>
      <ol className="flex flex-col">
        {alts.map((a, k) => {
          const chosen = a.token === step.token;
          const eos = isEOS(a.token);
          return (
            <li key={`${a.token}-${k}`} className={`group flex items-center gap-2 border-l-2 py-1 pl-2 ${chosen ? "border-accent" : "border-transparent"}`}>
              <span className="num w-4 text-[11px] text-ink-3">{k + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={`truncate font-serif text-[17px] ${eos ? "italic text-ink-2" : "text-ink"}`}><TokenText t={a.token} /></span>
                  {chosen && <span className="text-[11px] font-medium text-accent">chosen</span>}
                  <span className="num ml-auto text-xs text-ink-2">{pct(a.p)}</span>
                </div>
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
                  <span className="bar block h-full rounded-full" style={{ transform: `scaleX(${clamp01(a.p / max)})`, background: chosen ? "var(--accent)" : "var(--ink-3)" }} />
                </span>
              </div>
              {!chosen ? (
                <button
                  type="button"
                  onClick={() => fork(take.id, step.index, a.token)}
                  aria-label={eos ? `Fork: end the text before token ${step.index + 1}` : `Fork from here with “${showToken(a.token)}” at token ${step.index + 1}`}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-line px-2 text-xs text-ink-2 transition-colors hover:border-accent hover:text-accent"
                >
                  <GitBranch size={13} aria-hidden="true" />
                  <span className="hidden sm:inline">{eos ? "End here" : "Fork from here"}</span>
                  <span className="sm:hidden">Fork</span>
                </button>
              ) : (
                <span className="w-[1px] shrink-0" />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function BallotRow({ ballot: b, info, index, step, isLead }: { ballot: VoiceBallot; info: VoiceInfo; index: number; step: Step; isLead: boolean }) {
  const muted = b.weight === 0;
  const failed = !!b.failed;
  const color = voiceColorVar(index);
  const own = b.top?.[0];
  const differs = !!own && own.token !== step.token;

  return (
    <li className={`rounded-lg border px-3 py-2.5 ${isLead ? "border-line-strong bg-sunk/60" : "border-line"} ${failed || muted ? "opacity-80" : ""}`}>
      <div className="flex items-center gap-2">
        <VoiceMark index={index} size={12} hollow={muted || failed} />
        <span className="text-sm font-medium text-ink">{info.label}</span>
        <span className="truncate text-xs text-ink-3">
          {info.lab} · {info.origin}
        </span>
        <span className="ml-auto shrink-0">
          {failed ? (
            <Badge tone="plain">sat out</Badge>
          ) : muted ? (
            <Badge tone="plain">listening</Badge>
          ) : isLead ? (
            <Badge tone="accent">lead</Badge>
          ) : null}
        </span>
      </div>

      {failed ? (
        <p className="mt-1.5 text-xs text-ink-3">This voice errored or timed out on this token, so the others decided without it.</p>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <span className="bar block h-full rounded-full" style={{ transform: `scaleX(${clamp01(b.share)})`, background: color }} />
            </span>
            <span className="num w-12 text-right text-xs text-ink">{pct(b.share, 0)}</span>
          </div>
          <p className="mt-1 text-xs text-ink-2">
            {muted ? (
              <>Muted, so it carried none of this token. </>
            ) : (
              <>
                Carried <span className="num text-ink">{pct(b.share, 0)}</span> of it.{" "}
              </>
            )}
            Gave “<TokenText t={step.token} />” <span className="num text-ink">{pct(b.pChosen)}</span>
            {b.rank != null ? (
              <>
                , its <span className="num text-ink">#{b.rank}</span> choice.
              </>
            ) : (
              <>, outside its top choices.</>
            )}
          </p>
          {b.top?.length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] text-ink-3">{differs ? "Alone, it would have said something else:" : "Alone, it would have said the same:"}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {b.top.slice(0, 4).map((c, k) => {
                  const isChosen = c.token === step.token;
                  const hot = k === 0 && differs;
                  return (
                    <span
                      key={`${c.token}-${k}`}
                      className={`flex items-baseline gap-1 rounded border px-1.5 py-0.5 text-xs ${hot ? "border-heat/70 bg-heat/10 text-ink" : isChosen ? "border-accent/50 text-ink" : "border-line text-ink-2"}`}
                    >
                      <span className={`font-serif text-[14px] ${isEOS(c.token) ? "italic" : ""}`}><TokenText t={c.token} /></span>
                      <span className="num text-[10.5px] text-ink-3">{pct(c.p, 0)}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
      <p className="num mt-2 text-[10.5px] text-ink-3">
        {ms(b.latencyMs)} · {usd(b.costUsd)} · gain ×{num(b.weight)}
      </p>
    </li>
  );
}
