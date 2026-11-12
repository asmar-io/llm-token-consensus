"use client";

import { Dices } from "lucide-react";
import { useId, type CSSProperties } from "react";
import { num } from "@/lib/client/format";
import { voiceColorVar } from "@/lib/client/palette";
import { buildVoiceWeights, useChorus } from "@/lib/client/store";
import { VoiceMark } from "./VoiceMark";

/** The mixing desk: per-voice gain / mute / solo, plus the global blend settings. */
export function Mixer() {
  const choir = useChorus((s) => s.choir);
  const channels = useChorus((s) => s.channels);
  const solo = useChorus((s) => s.solo);
  const settings = useChorus((s) => s.settings);
  const { setChannel, toggleSolo, setSettings } = useChorus.getState();
  const weights = buildVoiceWeights({ choir, channels, solo });
  const singing = weights.filter((w) => w.weight > 0).length;
  const ids = { temp: useId(), seed: useId(), max: useId() };

  if (!choir) return null;

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-5">
      <div>
        <p className="eyebrow">Mixer</p>
        <p className="mt-1 text-xs text-ink-3">Changes apply to the next performance and to forks.</p>
      </div>

      <section aria-label="Voices" className="flex flex-col overflow-hidden rounded-lg border border-line">
        {choir.voices.map((v, i) => {
          const ch = channels[v.id] ?? { gain: 1, muted: false };
          const w = weights[i]?.weight ?? 0;
          const silencedBySolo = solo != null && solo !== v.id;
          return (
            <div key={v.id} className={`flex flex-col gap-1 border-b border-line px-3 py-2.5 last:border-b-0 ${w === 0 ? "bg-sunk/50" : ""}`}>
              <div className="flex items-center gap-2">
                <VoiceMark index={i} size={12} hollow={w === 0} />
                <span className={`text-sm font-medium ${w === 0 ? "text-ink-2" : "text-ink"}`}>{v.label}</span>
                <span className="truncate text-xs text-ink-3">{v.lab}</span>
                <span className="ml-auto flex shrink-0 gap-1">
                  <DeskBtn active={ch.muted} onClick={() => setChannel(v.id, { muted: !ch.muted })} label={`${ch.muted ? "Unmute" : "Mute"} ${v.label}`} tone="mute">
                    M
                  </DeskBtn>
                  <DeskBtn active={solo === v.id} onClick={() => toggleSolo(v.id)} label={`${solo === v.id ? "Stop soloing" : "Solo"} ${v.label}`} tone="solo">
                    S
                  </DeskBtn>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  className="fader"
                  min={0}
                  max={2}
                  step={0.05}
                  value={ch.gain}
                  disabled={ch.muted || silencedBySolo}
                  aria-label={`${v.label} gain`}
                  onChange={(e) => setChannel(v.id, { gain: Number(e.target.value) })}
                  style={{ "--fill": `${(ch.gain / 2) * 100}%`, "--fc": voiceColorVar(i) } as CSSProperties}
                />
                <span className="num w-20 shrink-0 text-right text-xs text-ink-2">
                  {ch.muted ? "listening" : silencedBySolo ? "listening" : `×${num(ch.gain)}`}
                </span>
              </div>
            </div>
          );
        })}
      </section>
      {singing === 0 && (
        <p role="alert" className="-mt-3 text-xs text-danger">
          Every voice is muted. Unmute at least one, or turn a gain up, to perform.
        </p>
      )}
      {solo && (
        <p className="-mt-3 text-xs text-ink-3">
          Solo: only one voice sings; the others still listen, so you can see what they would have said.
        </p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[11px] font-medium text-ink-3">Blend</legend>
        <div role="radiogroup" aria-label="Blend mode" className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-sunk p-1">
          {(
            [
              ["mixture", "Mixture"],
              ["consensus", "Consensus"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={settings.blend === id}
              onClick={() => setSettings({ blend: id })}
              className={`h-9 rounded-md text-sm transition-colors ${settings.blend === id ? "bg-raised font-medium text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]" : "text-ink-2 hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs leading-snug text-ink-3">
          {settings.blend === "mixture"
            ? "Mixture averages the voices' odds: any one voice can carry a word it strongly wants."
            : "Consensus multiplies the voices' odds: a word only wins if every singing voice finds it plausible."}
        </p>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.temp} className="flex items-baseline justify-between text-[11px] font-medium text-ink-3">
          Temperature <span className="num text-xs text-ink-2">{num(settings.temperature)}</span>
        </label>
        <input
          id={ids.temp}
          type="range"
          className="fader"
          min={0}
          max={1.5}
          step={0.05}
          value={settings.temperature}
          onChange={(e) => setSettings({ temperature: Number(e.target.value) })}
          style={{ "--fill": `${(settings.temperature / 1.5) * 100}%` } as CSSProperties}
        />
        <p className="text-xs text-ink-3">0 always takes the blend&apos;s favourite. Higher lets less likely words through.</p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.max} className="flex items-baseline justify-between text-[11px] font-medium text-ink-3">
          Max tokens <span className="num text-xs text-ink-2">{settings.maxTokens}</span>
        </label>
        <input
          id={ids.max}
          type="range"
          className="fader"
          min={16}
          max={512}
          step={8}
          value={settings.maxTokens}
          onChange={(e) => setSettings({ maxTokens: Number(e.target.value) })}
          style={{ "--fill": `${((settings.maxTokens - 16) / 496) * 100}%` } as CSSProperties}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.seed} className="text-[11px] font-medium text-ink-3">
          Seed
        </label>
        <div className="flex gap-2">
          <input
            id={ids.seed}
            type="number"
            inputMode="numeric"
            value={settings.seed}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (Number.isFinite(n)) setSettings({ seed: Math.max(0, n) });
            }}
            className="num h-10 min-w-0 flex-1 rounded-md border border-line bg-sunk px-3 text-sm text-ink focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setSettings({ seed: Math.floor(Math.random() * 1_000_000) })}
            className="flex h-10 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
          >
            <Dices size={15} aria-hidden="true" /> Reroll
          </button>
        </div>
        <p className="text-xs text-ink-3">Same seed and settings replay the same performance.</p>
      </div>
    </div>
  );
}

function DeskBtn({ active, onClick, label, tone, children }: { active: boolean; onClick: () => void; label: string; tone: "mute" | "solo"; children: React.ReactNode }) {
  const on = tone === "mute" ? "bg-danger/90 text-bg border-danger" : "bg-accent text-accent-ink border-accent";
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`num grid size-8 place-items-center rounded border text-[11px] font-semibold transition-colors ${active ? on : "border-line-strong text-ink-2 hover:text-ink"}`}
    >
      {children}
    </button>
  );
}
