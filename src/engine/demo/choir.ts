/**
 * The simulated demo choir: five fictional voices from fictional labs, each
 * with its own temperament, tokenizer and latency. They produce believable
 * next-piece distributions over scripted answers; the real align / mix /
 * sample engine runs on them unchanged.
 *
 * These are SIMULATIONS. Names and labs are invented and must never be
 * presented as real models.
 */
import { EOS, type VoiceInfo } from "@/lib/protocol";
import type { Voice, VoiceContext, VoiceDistribution } from "@/engine/voice";
import { combineSeed, mulberry32 } from "@/engine/sample";
import { boundaries, locate, type Position, type Script, type Temperament, type TokenizerProfile } from "./script";
import { SCRIPTS, scriptForPrompt } from "./scripts";

export interface Persona {
  info: VoiceInfo;
  temperament: Temperament;
  tokenizer: TokenizerProfile;
  /** Typical probability on its top piece at an uncontested position. */
  confidence: number;
  /** Exponent applied to option preferences: higher = more decisive at contested slots. */
  decisiveness: number;
  /** Simulated latency range in ms. */
  latency: [number, number];
}

export const PERSONAS: Persona[] = [
  {
    info: {
      id: "demo:aster",
      label: "Aster",
      lab: "Meridian Collective (fictional)",
      origin: "Canada",
      blurb: "Simulated. Cautious and hedging: qualifies claims and prefers the safer word.",
      simulated: true,
    },
    temperament: "c",
    tokenizer: { kind: "suffix", minLen: 8, suffixes: ["ing", "ion", "ity", "ally", "ment", "ness", "able", "ible", "ful", "ous", "ive", "ised"] },
    confidence: 0.82,
    decisiveness: 1.3,
    latency: [70, 140],
  },
  {
    info: {
      id: "demo:flint",
      label: "Flint",
      lab: "Northgate Labs (fictional)",
      origin: "US",
      blurb: "Simulated. Blunt: short words, firm verdicts, little patience for caveats.",
      simulated: true,
    },
    temperament: "b",
    tokenizer: { kind: "whole" },
    confidence: 0.94,
    decisiveness: 2.6,
    latency: [40, 80],
  },
  {
    info: {
      id: "demo:lumen",
      label: "Lumen",
      lab: "Kairo Systems (fictional)",
      origin: "Singapore",
      blurb: "Simulated. Optimistic about technology: reaches for progress, tools and speed.",
      simulated: true,
    },
    temperament: "t",
    tokenizer: { kind: "half", minLen: 9 },
    confidence: 0.9,
    decisiveness: 2.0,
    latency: [50, 110],
  },
  {
    info: {
      id: "demo:hearth",
      label: "Hearth",
      lab: "Atlas Commons (fictional)",
      origin: "Morocco",
      blurb: "Simulated. Reaches for tradition, community and the people affected.",
      simulated: true,
    },
    temperament: "k",
    tokenizer: { kind: "head", minLen: 8, head: 4 },
    confidence: 0.87,
    decisiveness: 1.8,
    latency: [60, 130],
  },
  {
    info: {
      id: "demo:quill",
      label: "Quill",
      lab: "Lex Foundry (fictional)",
      origin: "Germany",
      blurb: "Simulated. Legalistic: talks in rules, duties and who is accountable.",
      simulated: true,
    },
    temperament: "l",
    tokenizer: { kind: "suffix", minLen: 7, suffixes: ["s", "ed", "ing", "ly", "er", "tion", "ment"] },
    confidence: 0.9,
    decisiveness: 2.2,
    latency: [55, 120],
  },
];

export const DEMO_SAMPLE_PROMPTS = SCRIPTS.filter((s) => !s.hidden).map((s) => s.prompt);

// ---------------------------------------------------------------------------
// Distribution construction
// ---------------------------------------------------------------------------

type Pieces = Map<string, number>;

const add = (m: Pieces, t: string, p: number) => {
  if (p > 0 && t.length > 0) m.set(t, (m.get(t) ?? 0) + p);
};

/**
 * How much this persona likes each option of a unit. Stable for a given
 * (seed, persona, script, unit) so a voice does not change its mind halfway
 * through a multi-piece option.
 */
export function optionPrefs(persona: Persona, script: Script, unit: number, seed: number): number[] {
  const opts = script.units[unit].options;
  if (opts.length === 1) return [1];
  const rng = mulberry32(combineSeed("prefs", seed, persona.info.id, script.id, unit));
  const scores = opts.map((o, i) => {
    let s = o.tags.includes(persona.temperament) ? 1 : 0.1;
    if (i === 0) s += 0.3;
    s *= Math.exp((rng() - 0.5) * 0.7);
    return Math.pow(s, persona.decisiveness);
  });
  const z = scores.reduce((a, b) => a + b, 0);
  return scores.map((s) => s / z);
}

/**
 * The persona's next pieces when it is `offset` chars into `text`: its own
 * next piece as the favourite, plus other plausible cuts of the same text
 * (a coarser merge and a finer split) as runners-up. Every runner-up keeps the
 * text on-script, so whichever piece the mix picks, all voices can follow.
 */
function piecesAt(persona: Persona, text: string, offset: number, mass: number, rng: () => number, out: Pieces) {
  const ends = boundaries(text, persona.tokenizer);
  const e1 = ends.find((e) => e > offset) ?? text.length;
  const main = text.slice(offset, e1);
  const conf = Math.min(0.985, Math.max(0.6, persona.confidence + (rng() - 0.5) * 0.08));
  const alts: string[] = [];
  const e2 = ends.find((e) => e > e1);
  // A coarser cut: this piece merged with a following sub-word piece.
  if (e2 !== undefined && /^\p{L}/u.test(text.slice(e1, e2))) alts.push(text.slice(offset, e2));
  // A finer cut of a long word, as a smaller-vocabulary tokenizer would make.
  const letters = main.replace(/^ /, "");
  if (/^\p{L}{8,}$/u.test(letters)) {
    const lead = main.length - letters.length;
    alts.push(main.slice(0, lead + Math.max(2, Math.floor(letters.length / 2) - (rng() < 0.5 ? 1 : 0))));
  }
  if (alts.length === 0) {
    add(out, main, mass * Math.min(0.99, conf + 0.06));
    return;
  }
  add(out, main, mass * conf);
  const rest = (1 - conf) * 0.85; // the remaining ~15% is unlisted tail mass
  const raw = alts.map(() => 0.3 + rng());
  const z = raw.reduce((a, b) => a + b, 0);
  alts.forEach((a, i) => add(out, a, (mass * rest * raw[i]) / z));
}

/** Pure: a persona's distribution given the prompt, the text so far and the seed. */
export function demoDistribution(persona: Persona, prompt: string, textSoFar: string, seed: number): { token: string; p: number }[] {
  const script = scriptForPrompt(prompt);
  const { positions } = locate(script, textSoFar);
  const rng = mulberry32(combineSeed("pieces", seed, persona.info.id, textSoFar));
  const out: Pieces = new Map();

  // Posterior weight of each consistent position = how much this persona likes
  // the option that position implies.
  const weighted: { pos: Position; w: number }[] = positions.map((pos) => {
    if (pos.kind === "inside") return { pos, w: optionPrefs(persona, script, pos.unit, seed)[pos.option] };
    if (pos.via !== null && pos.unit > 0) return { pos, w: optionPrefs(persona, script, pos.unit - 1, seed)[pos.via] ?? 1 };
    return { pos, w: 1 };
  });
  const wz = weighted.reduce((a, b) => a + b.w, 0) || 1;

  for (const { pos, w } of weighted) {
    const mass = w / wz;
    if (pos.kind === "inside") {
      piecesAt(persona, script.units[pos.unit].options[pos.option].text, pos.offset, mass, rng, out);
    } else if (pos.unit >= script.units.length) {
      add(out, EOS, mass * 0.97);
    } else {
      const prefs = optionPrefs(persona, script, pos.unit, seed);
      script.units[pos.unit].options.forEach((opt, o) => piecesAt(persona, opt.text, 0, mass * prefs[o], rng, out));
    }
  }
  return [...out.entries()]
    .map(([token, p]) => ({ token, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 20);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface DemoOptions {
  /** Request seed: noise is reproducible per seed. */
  seed: number;
  /** Multiplies simulated latency. 0 disables it (tests). Default 1. */
  latencyScale?: number;
}

export function createDemoVoice(persona: Persona, opts: DemoOptions): Voice {
  const scale = opts.latencyScale ?? 1;
  return {
    info: persona.info,
    async next(ctx: VoiceContext): Promise<VoiceDistribution> {
      const t0 = Date.now();
      if (scale > 0) {
        const r = mulberry32(combineSeed("latency", opts.seed, persona.info.id, ctx.stepIndex))();
        const [lo, hi] = persona.latency;
        await sleep((lo + r * (hi - lo)) * scale, ctx.signal);
      } else if (ctx.signal.aborted) {
        throw ctx.signal.reason ?? new Error("aborted");
      }
      const top = demoDistribution(persona, ctx.prompt, ctx.textSoFar, opts.seed).map((c) => ({
        token: c.token,
        logprob: Math.log(c.p),
      }));
      return {
        top,
        latencyMs: Date.now() - t0,
        inputTokens: Math.ceil((ctx.prompt.length + ctx.textSoFar.length) / 4),
        outputTokens: 1,
        costUsd: 0,
      };
    },
  };
}

export function createDemoVoices(opts: DemoOptions): Voice[] {
  return PERSONAS.map((p) => createDemoVoice(p, opts));
}

export const DEMO_VOICE_INFOS: VoiceInfo[] = PERSONAS.map((p) => p.info);
