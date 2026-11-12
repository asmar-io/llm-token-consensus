/**
 * Client-side mock of /api/choir and /api/perform.
 *
 * Used when the API is unreachable or the URL carries ?mock=1. It emits
 * protocol-conformant events: the voices really do hold separate
 * distributions, they are really mixed (mixture or consensus), and the pick is
 * really sampled from the blend with the seed and temperature you set.
 * Only the "knowledge" is scripted.
 */
import {
  EOS,
  type Candidate,
  type ChoirInfo,
  type PerformEvent,
  type PerformRequest,
  type Step,
  type VoiceBallot,
  type VoiceInfo,
} from "@/lib/protocol";
import { computeSummary } from "./summary";

const VOICES: VoiceInfo[] = [
  { id: "demo:atlas", label: "Atlas", lab: "Mock Lab North", origin: "US", blurb: "Plain and direct; reaches for the common word.", simulated: true },
  { id: "demo:lumen", label: "Lumen", lab: "Mock Lab East", origin: "China", blurb: "Precise, a little formal, fond of technical terms.", simulated: true },
  { id: "demo:mistral", label: "Mistral", lab: "Mock Lab West", origin: "France", blurb: "Literary; prefers the vivid word over the safe one.", simulated: true },
  { id: "demo:kestrel", label: "Kestrel", lab: "Mock Lab South", origin: "UK", blurb: "Cautious; hedges when the others commit.", simulated: true },
  { id: "demo:orca", label: "Orca", lab: "Mock Lab Pacific", origin: "Canada", blurb: "Concise; often wants to stop early.", simulated: true },
];

/** Each script: plain text, with [a|b|c] marking a contested slot (first option = the usual pick). */
const SCRIPTS: { prompt: string; text: string }[] = [
  {
    prompt: "Why is the sky blue?",
    text:
      "Sunlight looks white, but it is a mix of every colour. When it [enters| reaches| hits] the atmosphere, it [collides| interacts] with nitrogen and oxygen molecules that are much smaller than its wavelength. Those molecules [scatter| redirect| bounce] short wavelengths far more strongly than long ones, so blue light is thrown across the whole sky while red and yellow mostly pass straight through.\n\nViolet is scattered even more, but the sun emits less of it and our eyes are [less| far less] sensitive to it, so the sky reads as blue. At sunset the light crosses much more air, the blue is scattered away before it reaches you, and the [reds| oranges| warm colours] are what is left.",
  },
  {
    prompt: "Write a haiku about a lighthouse.",
    text:
      "[Salt|Grey|Cold] wind on the stone,\none [patient| steady| tireless] eye turns all night,\nships [it| she| we] will never [meet| see| know].",
  },
  {
    prompt: "Is it ever right to break a promise?",
    text:
      "[Yes|Sometimes|Usually not], but rarely, and the bar should be high. A promise is a way of handing someone else a [claim| say| stake] on your future choices, which is why breaking one [feels| is] like a small betrayal.\n\nThe clearest case is when keeping it would cause serious harm that the promise was never meant to [cover| allow| permit]: you promised to keep a secret, and keeping it now puts someone in danger. Circumstances can also change so much that the promise no longer means what both people [thought| understood| intended].\n\nEven then, the honest move is to tell the person, explain why, and [take responsibility| own the cost| make amends] rather than quietly letting it lapse.",
  },
  {
    prompt: "Explain recursion to a ten-year-old.",
    text:
      "Imagine you are standing in a long line and want to know your place in it. You [ask| tap] the person in front of you, \"What number are you?\" They don't know either, so they ask the person in front of them, and so on.\n\nFinally the question reaches the very first person, who [simply| just] says, \"I'm number one!\" That answer travels back down the line, and everyone adds one as they pass it on, until it reaches you.\n\nThat is recursion: solving a big problem by asking a [smaller| slightly smaller| tinier] version of the same question, until you hit one so small the answer is [obvious| easy| known].",
  },
  {
    prompt: "What is the best way to learn a new language?",
    text:
      "[Use it|Speak it|Practise it] every day, even badly. Most people stall because they study the language instead of living in it.\n\nPick material you would enjoy in your own language, such as shows, podcasts or games, and consume it with subtitles in the [target| new| learning] language. Learn the thousand most common words first; they cover most of everyday speech. Then find a person to talk to, a tutor or an exchange partner, and [aim| try] for short, frequent conversations rather than long, rare ones.\n\nMistakes are the [point| method| price], not a sign of failure.",
  },
];

const FALLBACK =
  "This is a rehearsal: Chorus is running on mock data, so the words are scripted rather than [real| live| genuine]. Each piece is still chosen the way the engine chooses: [five| several| a few] voices offer their odds, the odds are blended, and one token is drawn from the blend.\n\nClick any word to see who carried it, how [strongly| firmly| confidently] the others agreed, and what the choir would have said instead. Forking from an alternative starts a new take from that point.";

export const MOCK_CHOIR: ChoirInfo = {
  mode: "demo",
  voices: VOICES,
  defaults: { blend: "mixture", temperature: 0.7, seed: 1729, maxTokens: 220 },
  samplePrompts: SCRIPTS.map((s) => s.prompt),
  note: "Mock data: the API was not reachable (or ?mock=1 is set), so a scripted choir is performing in your browser.",
};

// ---------------------------------------------------------------------------

interface Slot {
  options: string[];
  contested: boolean;
}

function tokenizeText(text: string): string[] {
  const out: string[] = [];
  const re = /\n|[ ]?[A-Za-z']+|[ ]?[0-9]+|[ ]?[^\sA-Za-z0-9]/g;
  for (const m of text.matchAll(re)) {
    const piece = m[0];
    const word = piece.trimStart();
    // Long words become sub-word pieces, as real tokenizers do.
    if (/^[A-Za-z']{9,}$/.test(word)) {
      const lead = piece.slice(0, piece.length - word.length);
      const cut = Math.ceil(word.length * 0.6);
      out.push(lead + word.slice(0, cut), word.slice(cut));
    } else out.push(piece);
  }
  return out;
}

function parseScript(text: string): Slot[] {
  const slots: Slot[] = [];
  const re = /\[([^\]]+)\]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const before = text.slice(last, m.index);
    for (const t of tokenizeText(before)) slots.push({ options: [t], contested: false });
    // "a [claim| say]": the space before the bracket belongs to the options.
    const lead = /[ ]$/.test(before) ? " " : "";
    slots.push({ options: m[1].split("|").map((o) => (lead && !o.startsWith(" ") ? lead + o : o)), contested: true });
    last = (m.index ?? 0) + m[0].length;
  }
  for (const t of tokenizeText(text.slice(last))) slots.push({ options: [t], contested: false });
  return slots;
}

function scriptFor(prompt: string): Slot[] {
  const p = prompt.trim().toLowerCase();
  const hit = SCRIPTS.find((s) => s.prompt.toLowerCase() === p) ?? SCRIPTS.find((s) => p.includes(s.prompt.toLowerCase().slice(0, 18)));
  return parseScript(hit ? hit.text : FALLBACK);
}

const WORD_DISTRACTORS = [" the", " a", " it", " this", " and", " of", " to", " is", " that", " so", " but", " with"];
const PUNCT_DISTRACTORS = [",", ".", " —", ";", ":"];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e37;
  }
  return h >>> 0;
}

type Dist = Map<string, number>;

function voiceDist(slot: Slot, next: Slot | undefined, vi: number, stepIndex: number, rand: () => number, shared: () => number): Dist {
  const d: Dist = new Map();
  const base = slot.options[0];
  if (slot.contested) {
    // Each voice has its own favourite among the contested options.
    const fav = vi <= 1 ? (rand() < 0.75 ? 0 : 1) : hash(vi, stepIndex) % slot.options.length;
    const favP = 0.42 + rand() * 0.38;
    d.set(slot.options[fav], favP);
    let rest = 1 - favP - 0.06;
    slot.options.forEach((o, i) => {
      if (i === fav) return;
      const p = rest * (0.45 + rand() * 0.35);
      d.set(o, (d.get(o) ?? 0) + p);
      rest -= p;
    });
  } else {
    // Distractors are shared across voices (they are the same plausible slips), the odds are not.
    const strayP = rand();
    const pBase = strayP < 0.03 ? 0.4 + rand() * 0.15 : 0.86 + rand() * 0.13;
    d.set(base, pBase);
    const pool = /^[ ]?[A-Za-z']/.test(base) ? WORD_DISTRACTORS : PUNCT_DISTRACTORS;
    let rest = 1 - pBase;
    const picks = [0, 1, 2].map(() => pool[Math.floor(shared() * pool.length)]);
    picks.forEach((t, k) => {
      if (t === base || rest < 0.004) return;
      const p = rest * (strayP < 0.03 && k === 0 ? 0.75 : 0.3 + rand() * 0.3);
      d.set(t, (d.get(t) ?? 0) + p);
      rest -= p;
    });
  }
  // After a full stop, ending is always a (small) possibility.
  if (next && /[.!?]$/.test(base) && !slot.contested) {
    d.set(EOS, vi === 4 ? 0.06 + rand() * 0.08 : 0.005 + rand() * 0.02);
  }
  return d;
}

function sortedTop(d: Dist, max: number): Candidate[] {
  const total = [...d.values()].reduce((a, b) => a + b, 0) || 1;
  return [...d.entries()]
    .map(([token, p]) => ({ token, p: p / Math.max(1, total) }))
    .sort((a, b) => b.p - a.p)
    .slice(0, max);
}

function entropyBits(ps: number[]): number {
  let h = 0;
  for (const p of ps) if (p > 0) h -= p * Math.log2(p);
  return h;
}

function sleep(msec: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, msec);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/** Mock of POST /api/perform as an async stream of PerformEvents. */
export async function* mockPerform(req: PerformRequest, signal: AbortSignal): AsyncGenerator<PerformEvent> {
  const slots = scriptFor(req.prompt);
  const voices = VOICES.filter((v) => req.voices.some((rv) => rv.id === v.id));
  const weights = new Map(req.voices.map((v) => [v.id, Math.max(0, v.weight)]));
  const runId = `mock-${hash(req.prompt, req.seed, req.prefix?.length ?? 0).toString(36)}`;

  await sleep(260, signal);
  yield { type: "start", runId, mode: "demo", voices, request: req };

  const start = req.prefix?.length ?? 0;
  const steps: Step[] = [];
  let reason: "eos" | "max_tokens" = "max_tokens";

  for (let i = start; i < req.maxTokens; i++) {
    const rand = mulberry32(hash(req.seed, i, req.prompt.length));
    const slot = slots[i] ?? { options: [EOS], contested: false };
    const next = slots[i + 1];
    const delay = 60 + Math.floor(rand() * 90);
    await sleep(delay, signal);

    // Per-voice distributions.
    const singing = voices.filter((v) => (weights.get(v.id) ?? 0) > 0);
    const dists = new Map<string, Dist>();
    const failed = new Set<string>();
    voices.forEach((v, vi) => {
      const vr = mulberry32(hash(req.seed, i, v.id));
      if (vr() < 0.006 && singing.length > 1 && i > start) failed.add(v.id);
      const shared = mulberry32(hash(req.prompt, i, "slips"));
      dists.set(v.id, slots[i] ? voiceDist(slot, next, vi, i, vr, shared) : new Map<string, number>([[EOS, 0.8 + vr() * 0.15], ["\n\n", 0.04 + vr() * 0.05]]));
    });

    const live = singing.filter((v) => !failed.has(v.id));
    const pool = live.length ? live : singing;
    const wSum = pool.reduce((a, v) => a + (weights.get(v.id) ?? 0), 0) || 1;
    const union = new Set<string>();
    for (const v of pool) for (const t of dists.get(v.id)!.keys()) union.add(t);

    const pOf = (vid: string, t: string) => {
      const d = dists.get(vid)!;
      const tot = [...d.values()].reduce((a, b) => a + b, 0) || 1;
      return (d.get(t) ?? 0) / tot;
    };

    const mixed: Dist = new Map();
    for (const t of union) {
      if (req.blend === "consensus") {
        let lg = 0;
        for (const v of pool) lg += ((weights.get(v.id) ?? 0) / wSum) * Math.log(Math.max(pOf(v.id, t), 1e-3));
        mixed.set(t, Math.exp(lg));
      } else {
        let m = 0;
        for (const v of pool) m += ((weights.get(v.id) ?? 0) / wSum) * pOf(v.id, t);
        mixed.set(t, m);
      }
    }
    const mTot = [...mixed.values()].reduce((a, b) => a + b, 0) || 1;
    for (const [t, p] of mixed) mixed.set(t, p / mTot);

    // Sample from the blend.
    let chosen: string;
    if (i === start && req.forcedNext != null) chosen = req.forcedNext;
    else if (req.temperature <= 0.01) chosen = [...mixed.entries()].sort((a, b) => b[1] - a[1])[0][0];
    else {
      const ws = [...mixed.entries()].map(([t, p]) => [t, Math.pow(p, 1 / req.temperature)] as const);
      const tot = ws.reduce((a, [, w]) => a + w, 0);
      let r = rand() * tot;
      chosen = ws[ws.length - 1][0];
      for (const [t, w] of ws) {
        r -= w;
        if (r <= 0) {
          chosen = t;
          break;
        }
      }
    }
    if (chosen === EOS) {
      reason = "eos";
      break;
    }

    // Agreement: 1 - weighted JSD / log2(n).
    let agreement = 1;
    if (pool.length > 1) {
      const toks = [...union];
      const hMix = entropyBits(toks.map((t) => pool.reduce((a, v) => a + ((weights.get(v.id) ?? 0) / wSum) * pOf(v.id, t), 0)));
      const hEach = pool.reduce((a, v) => a + ((weights.get(v.id) ?? 0) / wSum) * entropyBits(toks.map((t) => pOf(v.id, t))), 0);
      agreement = Math.max(0, Math.min(1, 1 - (hMix - hEach) / Math.log2(pool.length)));
    }

    const raw = voices.map((v) => {
      const w = weights.get(v.id) ?? 0;
      return { v, w, pc: failed.has(v.id) ? 0 : pOf(v.id, chosen) };
    });
    const shareTot = raw.reduce((a, r) => a + r.w * r.pc, 0);
    const ballots: VoiceBallot[] = raw.map(({ v, w, pc }) => {
      const vr = mulberry32(hash(req.seed, i, v.id, "lat"));
      if (failed.has(v.id)) {
        return { voiceId: v.id, top: [], pChosen: 0, rank: null, share: 0, weight: w, latencyMs: 2000 + Math.round(vr() * 500), costUsd: 0, failed: true };
      }
      const top = sortedTop(dists.get(v.id)!, 8);
      const r = top.findIndex((c) => c.token === chosen);
      return {
        voiceId: v.id,
        top,
        pChosen: pc,
        rank: r >= 0 ? r + 1 : null,
        share: shareTot > 0 ? (w * pc) / shareTot : w > 0 ? 1 / Math.max(1, pool.length) : 0,
        weight: w,
        latencyMs: 70 + Math.round(vr() * 420),
        costUsd: 0,
      };
    });
    const lead = ballots.reduce((best, b) => (b.share > best.share ? b : best), ballots[0]).voiceId;
    const alternatives = sortedTop(mixed, 8);
    if (!alternatives.some((a) => a.token === chosen)) alternatives.push({ token: chosen, p: mixed.get(chosen) ?? 0 });

    const step: Step = {
      index: i,
      token: chosen,
      p: mixed.get(chosen) ?? 0,
      alternatives,
      ballots,
      lead,
      agreement,
      unanimous: pool.every((v) => sortedTop(dists.get(v.id)!, 1)[0]?.token === chosen),
      entropy: entropyBits([...mixed.values()]),
      forced: i === start && req.forcedNext != null ? true : undefined,
      elapsedMs: delay,
    };
    steps.push(step);
    yield { type: "step", step };

    for (const id of failed) {
      const v = voices.find((x) => x.id === id);
      yield { type: "error", fatal: false, voiceId: id, message: `${v?.label ?? id} timed out on step ${i + 1} and sat it out.` };
    }
  }

  const summary = computeSummary(steps, voices.map((v) => v.id));
  yield { type: "done", reason, summary };
}
