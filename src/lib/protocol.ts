/**
 * CHORUS — shared wire contract between the engine (server) and the UI (client).
 *
 * This file is the single source of truth. Engine, live-voice adapter and
 * frontend are built against it in parallel. Do NOT change shapes here without
 * the conductor's sign-off; add optional fields only if you must.
 *
 * Vocabulary
 *   voice        one LLM taking part in the performance
 *   choir        the set of voices available (live = OpenRouter calls, demo = recorded live performances)
 *   step         one emitted text piece ("token") plus everything known about how it was chosen
 *   ballot       one voice's view of one step
 *   performance  one full generation run (a stream of steps)
 */

/** Sentinel "token" meaning "stop here". Appears in candidate lists like any other token. */
export const EOS = "<|eos|>";

/** How per-voice distributions are combined into one. */
export type BlendMode =
  /** Weighted arithmetic mean: any single voice can carry a token. */
  | "mixture"
  /** Weighted geometric mean (renormalised): a token needs support from every voice. */
  | "consensus";

export interface VoiceInfo {
  /** Stable id: the OpenRouter model slug. */
  id: string;
  /** Short display name, e.g. "Llama 3.3 70B". */
  label: string;
  /** Who trained it, e.g. "Meta". */
  lab: string;
  /** Where the lab is based, e.g. "US", "China", "France". */
  origin: string;
  /** One line on what this voice tends to sound like. Shown in the UI. */
  blurb?: string;
  simulated: boolean;
  /** USD per million tokens, when known. */
  pricing?: { inputPerM: number; outputPerM: number };
}

export interface PerformSettings {
  blend: BlendMode;
  /** Applied to the MIXED distribution. 0 = always take the top token. Range 0..1.5. */
  temperature: number;
  /** Seed for the sampler, so a performance can be replayed exactly. */
  seed: number;
  maxTokens: number;
}

/** GET /api/choir */
export interface ChoirInfo {
  /** "live": real model calls. "demo": recorded live performances are replayed (no key needed, no forks). */
  mode: "demo" | "live";
  /** Every voice that can be put in the choir. */
  voices: VoiceInfo[];
  /** Ids of the voices selected to begin with. Absent = all of them. */
  defaultVoices?: string[];
  defaults: PerformSettings;
  /** Prompts the UI offers as one-click starters. In demo mode these are the recorded ones. */
  samplePrompts: string[];
  /** Human-readable note, e.g. why the choir is in demo mode. */
  note?: string;
}

/** POST /api/perform  (body)  ->  text/event-stream of PerformEvent */
export interface PerformRequest extends PerformSettings {
  prompt: string;
  system?: string;
  /**
   * Voices taking part. weight > 0: sings (influences the mix).
   * weight === 0: muted but still listening (polled and shown, zero influence).
   * Leave a voice out entirely to exclude it. Weights need not sum to 1.
   */
  voices: { id: string; weight: number }[];
  /**
   * Fork support. Text pieces already decided (from an earlier performance),
   * kept verbatim. The stream then starts at index `prefix.length`.
   */
  prefix?: string[];
  /**
   * Fork support. If set, the first new step is computed normally but its
   * pick is overridden with this token (Step.forced = true).
   */
  forcedNext?: string;
}

export interface Candidate {
  token: string;
  /** Probability in the mixed distribution, 0..1. */
  p: number;
}

export interface VoiceBallot {
  voiceId: string;
  /** This voice's own top choices for this position, best first (max 8). Raw, before mixing. */
  top: Candidate[];
  /** Probability this voice gave the chosen token (after alignment across tokenizers). */
  pChosen: number;
  /** 1-based rank of the chosen token in this voice's list; null if it was not in its list. */
  rank: number | null;
  /** This voice's share of the chosen token's mixed score. Sums to 1 across voices. */
  share: number;
  /** Weight used for this voice in this step (0 = muted). */
  weight: number;
  latencyMs: number;
  costUsd: number;
  /** The voice errored or timed out on this step and sat it out. */
  failed?: boolean;
}

export interface Step {
  index: number;
  /** The chosen text piece. May carry leading whitespace / newlines. EOS never appears here. */
  token: string;
  /** Mixed probability of the chosen token. */
  p: number;
  /** Mixed top candidates, best first (max 8). Includes the chosen token. May include EOS. */
  alternatives: Candidate[];
  ballots: VoiceBallot[];
  /** voiceId with the largest share for the chosen token. */
  lead: string;
  /**
   * 0..1. 1 = the voices' distributions were identical, 0 = maximally split.
   * Defined as 1 - (weighted Jensen-Shannon divergence / log2(number of singing voices)).
   */
  agreement: number;
  /** True when every singing voice's own top choice equals the chosen token. */
  unanimous: boolean;
  /** Entropy of the mixed distribution in bits. */
  entropy: number;
  /** True when the pick was overridden by PerformRequest.forcedNext. */
  forced?: boolean;
  /** Wall-clock time for this step. */
  elapsedMs: number;
}

export interface Summary {
  tokens: number;
  elapsedMs: number;
  costUsd: number;
  /** voiceId -> mean share across steps (sums to 1). */
  influence: Record<string, number>;
  /** voiceId -> number of steps it led. */
  led: Record<string, number>;
  /** Mean agreement across steps. */
  agreement: number;
  /** Indexes of the most contested steps (lowest agreement first, max 8). */
  contested: number[];
}

export type PerformEvent =
  | { type: "start"; runId: string; mode: "demo" | "live"; voices: VoiceInfo[]; request: PerformRequest }
  | { type: "step"; step: Step }
  | { type: "done"; reason: "eos" | "max_tokens" | "aborted"; summary: Summary }
  | { type: "error"; message: string; voiceId?: string; fatal: boolean };

/**
 * SSE framing: each event is one line `data: <JSON PerformEvent>` followed by a blank line.
 * The stream ends after a "done" event or a fatal "error" event.
 */
