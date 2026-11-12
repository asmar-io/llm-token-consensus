/**
 * The performance loop: poll every voice, align, mix, sample, emit, repeat.
 *
 * `perform(request, voices, signal)` is an async generator of PerformEvent so it
 * can be unit-tested without HTTP; the /api/perform route only validates the
 * body, resolves voices and pipes this generator into an SSE response.
 */
import { EOS } from "@/lib/protocol";
import type {
  BlendMode,
  Candidate,
  PerformEvent,
  PerformRequest,
  Step,
  Summary,
  VoiceBallot,
  VoiceInfo,
} from "@/lib/protocol";
import type { Voice, VoiceDistribution } from "@/engine/voice";
import { alignVoice, buildCandidates, toProbs, type RawCandidate } from "@/engine/align";
import { agreement, entropyBits, mix, normaliseWeights, shares, type MixInput } from "@/engine/mix";
import { sampleToken, sortedEntries, stepRng } from "@/engine/sample";

export const MAX_TOKENS_CEILING = 400;
export const MAX_PREFIX = 400;
export const DEFAULT_VOICE_TIMEOUT_MS = 20_000;
const TOP_N = 8;

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type Validation = { ok: true; request: PerformRequest } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Validate and normalise a POST /api/perform body. Settings that are missing
 * fall back to defaults (blend mixture, temperature 0.7, a random seed,
 * maxTokens 160); settings that are present but malformed are rejected.
 * temperature is clamped to 0..1.5 and maxTokens to 1..MAX_TOKENS_CEILING.
 */
export function validateRequest(body: unknown): Validation {
  const fail = (error: string): Validation => ({ ok: false, error });
  if (!isObj(body)) return fail("Body must be a JSON object.");

  const { prompt, system, voices, blend, temperature, seed, maxTokens, prefix, forcedNext } = body;
  if (typeof prompt !== "string" || prompt.trim().length === 0) return fail("prompt must be a non-empty string.");
  if (prompt.length > 8000) return fail("prompt is too long (max 8000 characters).");
  if (system !== undefined && typeof system !== "string") return fail("system must be a string.");
  if (typeof system === "string" && system.length > 8000) return fail("system is too long (max 8000 characters).");

  if (!Array.isArray(voices) || voices.length === 0) return fail("voices must be a non-empty array.");
  if (voices.length > 16) return fail("Too many voices (max 16).");
  const seen = new Set<string>();
  const outVoices: PerformRequest["voices"] = [];
  for (const v of voices) {
    if (!isObj(v) || typeof v.id !== "string" || v.id.length === 0) return fail("Each voice needs a string id.");
    if (!finite(v.weight) || v.weight < 0) return fail(`Voice ${v.id}: weight must be a finite number >= 0.`);
    if (seen.has(v.id)) return fail(`Voice ${v.id} is listed twice.`);
    seen.add(v.id);
    outVoices.push({ id: v.id, weight: v.weight });
  }
  if (!outVoices.some((v) => v.weight > 0)) return fail("At least one voice must have weight > 0.");

  let outBlend: BlendMode = "mixture";
  if (blend !== undefined) {
    if (blend !== "mixture" && blend !== "consensus") return fail('blend must be "mixture" or "consensus".');
    outBlend = blend;
  }
  let outTemp = 0.7;
  if (temperature !== undefined) {
    if (!finite(temperature)) return fail("temperature must be a finite number.");
    outTemp = Math.min(1.5, Math.max(0, temperature));
  }
  let outSeed = Math.floor(Math.random() * 2 ** 31);
  if (seed !== undefined) {
    if (!finite(seed)) return fail("seed must be a finite number.");
    outSeed = Math.floor(Math.abs(seed)) % 2 ** 32;
  }
  let outMax = 160;
  if (maxTokens !== undefined) {
    if (!finite(maxTokens)) return fail("maxTokens must be a finite number.");
    outMax = Math.min(MAX_TOKENS_CEILING, Math.max(1, Math.floor(maxTokens)));
  }

  let outPrefix: string[] | undefined;
  if (prefix !== undefined && prefix !== null) {
    if (!Array.isArray(prefix)) return fail("prefix must be an array of strings.");
    if (prefix.length > MAX_PREFIX) return fail(`prefix is too long (max ${MAX_PREFIX} pieces).`);
    for (const piece of prefix) {
      if (typeof piece !== "string" || piece.length === 0) return fail("prefix pieces must be non-empty strings.");
      if (piece === EOS) return fail("prefix may not contain the EOS sentinel.");
    }
    outPrefix = prefix as string[];
  }
  let outForced: string | undefined;
  if (forcedNext !== undefined && forcedNext !== null) {
    if (typeof forcedNext !== "string" || forcedNext.length === 0) return fail("forcedNext must be a non-empty string.");
    if (forcedNext === EOS) return fail("forcedNext may not be the EOS sentinel.");
    if (forcedNext.length > 400) return fail("forcedNext is too long.");
    if (forcedNext.includes("�")) return fail("forcedNext contains an invalid character.");
    outForced = forcedNext;
  }

  const request: PerformRequest = {
    prompt,
    voices: outVoices,
    blend: outBlend,
    temperature: outTemp,
    seed: outSeed,
    maxTokens: outMax,
  };
  if (typeof system === "string" && system.length > 0) request.system = system;
  if (outPrefix && outPrefix.length > 0) request.prefix = outPrefix;
  if (outForced !== undefined) request.forcedNext = outForced;
  return { ok: true, request };
}

// ---------------------------------------------------------------------------
// One step, as a pure function
// ---------------------------------------------------------------------------

export interface VoiceResult {
  voiceId: string;
  weight: number;
  /** null = failed / timed out / unusable this step. */
  raw: RawCandidate[] | null;
  latencyMs: number;
  costUsd: number;
}

export interface StepOutcome {
  /** The picked token. May be EOS (then the performance stops and no step is emitted). */
  token: string;
  step: Omit<Step, "elapsedMs">;
}

/**
 * Decide one step from the voices' results. Returns null when no singing voice
 * produced a usable distribution.
 *
 * The candidate set is built from SINGING voices only (plus forcedNext), so a
 * muted voice has truly zero influence: its tokens would otherwise enter the
 * candidate set and, in consensus mode, take floor-level mass. Muted voices are
 * still aligned onto that set so their pChosen and rank are reported.
 */
export function computeStep(input: {
  index: number;
  results: VoiceResult[];
  blend: BlendMode;
  temperature: number;
  seed: number;
  forced?: string;
}): StepOutcome | null {
  const { index, results, blend, temperature, seed, forced } = input;
  const singingIdx = results.map((r, i) => (r.raw && r.raw.length > 0 && r.weight > 0 ? i : -1)).filter((i) => i >= 0);
  if (singingIdx.length === 0) return null;

  const candidates = buildCandidates(
    singingIdx.map((i) => results[i].raw!),
    forced !== undefined ? [forced] : [],
  );
  const aligned = results.map((r) => (r.raw && r.raw.length > 0 ? alignVoice(r.raw, candidates) : null));
  const w = normaliseWeights(singingIdx.map((i) => results[i].weight));
  const inputs: MixInput[] = singingIdx.map((i, k) => ({ probs: aligned[i]!, weight: w[k] }));

  const mixed = mix(inputs, candidates, blend);
  let token: string | null;
  if (forced !== undefined) token = forced;
  else token = sampleToken(mixed, temperature, stepRng(seed, index));
  if (token === null) {
    // No positive mass anywhere (cannot happen with valid inputs); fall back to the
    // first singing voice's own top token rather than inventing one.
    token = results[singingIdx[0]].raw![0].token;
  }

  const sh = shares(inputs, token, blend);
  const shareById = new Map<string, number>();
  singingIdx.forEach((i, k) => shareById.set(results[i].voiceId, sh[k]));

  const ballots: VoiceBallot[] = results.map((r, i) => {
    const failed = !r.raw || r.raw.length === 0;
    const rankIdx = failed ? -1 : r.raw!.findIndex((c) => c.token === token);
    const ballot: VoiceBallot = {
      voiceId: r.voiceId,
      top: failed ? [] : r.raw!.slice(0, TOP_N).map((c) => ({ token: c.token, p: c.p })),
      pChosen: failed ? 0 : (aligned[i]!.get(token!) ?? 0),
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      share: shareById.get(r.voiceId) ?? 0,
      weight: r.weight,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    };
    if (failed) ballot.failed = true;
    return ballot;
  });

  let lead = results[singingIdx[0]].voiceId;
  let best = -1;
  for (const i of singingIdx) {
    const s = shareById.get(results[i].voiceId) ?? 0;
    if (s > best) {
      best = s;
      lead = results[i].voiceId;
    }
  }

  const sorted = sortedEntries(mixed);
  const alternatives: Candidate[] = sorted.slice(0, TOP_N).map(([t, p]) => ({ token: t, p }));
  if (!alternatives.some((a) => a.token === token)) {
    const chosen = { token: token!, p: mixed.get(token!) ?? 0 };
    if (alternatives.length >= TOP_N) alternatives[TOP_N - 1] = chosen;
    else alternatives.push(chosen);
  }

  const unanimous = singingIdx.every((i) => results[i].raw![0].token === token);

  return {
    token,
    step: {
      index,
      token,
      p: mixed.get(token) ?? 0,
      alternatives,
      ballots,
      lead,
      agreement: agreement(inputs, candidates),
      unanimous,
      entropy: entropyBits(mixed.values()),
      ...(forced !== undefined ? { forced: true } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

export interface PerformOptions {
  mode?: "demo" | "live";
  voiceTimeoutMs?: number;
  runId?: string;
}

class StepTimeout extends Error {}

/** Call one voice with a per-call timeout, linked to the run's abort signal. Never hangs. */
async function callVoice(
  voice: Voice,
  ctx: Omit<Parameters<Voice["next"]>[0], "signal">,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ dist: VoiceDistribution; latencyMs: number }> {
  const ac = new AbortController();
  const onAbort = () => ac.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t0 = Date.now();
  try {
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort(new StepTimeout(`timed out after ${timeoutMs} ms`));
        reject(new StepTimeout(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      ac.signal.addEventListener("abort", () => reject(ac.signal.reason ?? new Error("aborted")), { once: true });
      if (signal.aborted) reject(new Error("aborted"));
    });
    const dist = await Promise.race([voice.next({ ...ctx, signal: ac.signal }), guard]);
    return { dist, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (!ac.signal.aborted) ac.abort(); // release anything the voice left listening
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function summarise(
  steps: Step[],
  voiceIds: string[],
  weights: number[],
  costUsd: number,
  elapsedMs: number,
): Summary {
  const influence: Record<string, number> = {};
  const led: Record<string, number> = {};
  for (const id of voiceIds) {
    influence[id] = 0;
    led[id] = 0;
  }
  if (steps.length === 0) {
    const w = normaliseWeights(weights);
    voiceIds.forEach((id, i) => (influence[id] = w[i]));
  } else {
    for (const s of steps) {
      for (const b of s.ballots) influence[b.voiceId] = (influence[b.voiceId] ?? 0) + b.share / steps.length;
      led[s.lead] = (led[s.lead] ?? 0) + 1;
    }
  }
  const meanAgreement = steps.length ? steps.reduce((a, s) => a + s.agreement, 0) / steps.length : 1;
  // Contested: lowest agreement first. Steps where the voices were essentially
  // identical (agreement >= 0.999) are never listed, so a calm run lists few.
  const contested = steps
    .filter((s) => s.agreement < 0.999)
    .sort((a, b) => a.agreement - b.agreement || a.index - b.index)
    .slice(0, 8)
    .map((s) => s.index);
  return { tokens: steps.length, elapsedMs, costUsd, influence, led, agreement: meanAgreement, contested };
}

/**
 * Run one performance. `voices` must contain a Voice for every id in
 * request.voices (extra voices are ignored). The request is assumed to have
 * passed validateRequest.
 *
 * maxTokens counts the whole performance INCLUDING the prefix: a fork at step k
 * of a run with maxTokens N continues until index N at most. A forced step is
 * always produced, even if the prefix already reached maxTokens.
 */
export async function* perform(
  request: PerformRequest,
  voices: Voice[],
  signal: AbortSignal,
  options: PerformOptions = {},
): AsyncGenerator<PerformEvent, void, undefined> {
  const t0 = Date.now();
  const byId = new Map(voices.map((v) => [v.info.id, v]));
  const roster = request.voices.map((rv) => {
    const voice = byId.get(rv.id);
    if (!voice) throw new Error(`Unknown voice ${rv.id}`);
    return { voice, weight: rv.weight };
  });
  const infos: VoiceInfo[] = roster.map((r) => r.voice.info);
  const mode = options.mode ?? (infos.every((i) => i.simulated) ? "demo" : "live");
  const timeoutMs = options.voiceTimeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
  const runId = options.runId ?? `run_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const maxTokens = Math.min(MAX_TOKENS_CEILING, Math.max(1, Math.floor(request.maxTokens)));

  yield { type: "start", runId, mode, voices: infos, request };

  const prefix = request.prefix ?? [];
  let textSoFar = prefix.join("");
  let index = prefix.length;
  const steps: Step[] = [];
  let cost = 0;
  const reported = new Set<string>();
  const ids = roster.map((r) => r.voice.info.id);
  const weights = roster.map((r) => r.weight);
  const done = (reason: "eos" | "max_tokens" | "aborted"): PerformEvent => ({
    type: "done",
    reason,
    summary: summarise(steps, ids, weights, cost, Date.now() - t0),
  });

  let forced = request.forcedNext;
  while (true) {
    if (signal.aborted) {
      yield done("aborted");
      return;
    }
    if (index >= maxTokens && forced === undefined) {
      yield done("max_tokens");
      return;
    }
    const stepStart = Date.now();
    const ctx = { system: request.system, prompt: request.prompt, textSoFar, stepIndex: index };
    const settled = await Promise.allSettled(roster.map((r) => callVoice(r.voice, ctx, signal, timeoutMs)));
    if (signal.aborted) {
      yield done("aborted");
      return;
    }

    const results: VoiceResult[] = [];
    const newErrors: PerformEvent[] = [];
    settled.forEach((s, i) => {
      const { voice, weight } = roster[i];
      const id = voice.info.id;
      let raw: RawCandidate[] | null = null;
      let latencyMs = Date.now() - stepStart;
      let c = 0;
      let reason = "";
      if (s.status === "fulfilled") {
        latencyMs = s.value.latencyMs;
        c = Number.isFinite(s.value.dist.costUsd) ? s.value.dist.costUsd : 0;
        raw = toProbs(s.value.dist.top);
        if (raw.length === 0) {
          raw = null;
          reason = "returned no usable candidates";
        }
      } else {
        reason = errMsg(s.reason);
      }
      cost += c;
      if (raw === null && !reported.has(id)) {
        reported.add(id);
        newErrors.push({
          type: "error",
          voiceId: id,
          fatal: false,
          message: `${voice.info.label} sat out step ${index}: ${reason}. It will sit out any step it cannot answer.`,
        });
      }
      results.push({ voiceId: id, weight, raw, latencyMs, costUsd: c });
    });
    for (const e of newErrors) yield e;

    const outcome = computeStep({
      index,
      results,
      blend: request.blend,
      temperature: request.temperature,
      seed: request.seed,
      forced,
    });
    if (!outcome) {
      yield { type: "error", fatal: true, message: `Every singing voice failed on step ${index}; the performance stopped.` };
      return;
    }
    forced = undefined;
    if (outcome.token === EOS) {
      yield done("eos");
      return;
    }
    const step: Step = { ...outcome.step, elapsedMs: Date.now() - stepStart };
    steps.push(step);
    textSoFar += outcome.token;
    index += 1;
    yield { type: "step", step };
  }
}
