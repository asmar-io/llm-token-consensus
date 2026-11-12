/**
 * The demo choir: real performances recorded from the live choir, replayed
 * event for event. Nothing here is simulated or scripted. Each recording is
 * the exact PerformEvent stream that POST /api/perform produced with real
 * model calls (see scripts/record-demo.mjs), so every probability, ballot,
 * latency and cost shown in demo mode is what actually happened.
 *
 * What a recording cannot do: answer a new prompt, or fork. Those need live
 * calls, so the demo says so instead of pretending.
 */
import type { PerformEvent, PerformRequest, Step, Summary, VoiceInfo } from "@/lib/protocol";
import { RECORDINGS as RAW } from "./recordings";

export interface Recording {
  prompt: string;
  /** ISO timestamp of the live run. */
  recordedAt: string;
  events: PerformEvent[];
}

export const RECORDINGS: Recording[] = RAW as unknown as Recording[];

export const DEMO_SAMPLE_PROMPTS: string[] = RECORDINGS.map((r) => r.prompt);

function startOf(r: Recording) {
  const e = r.events.find((x) => x.type === "start");
  return e && e.type === "start" ? e : undefined;
}

/** The voices heard in the recordings (the live choir at recording time). */
export const DEMO_VOICE_INFOS: VoiceInfo[] = (() => {
  const seen = new Map<string, VoiceInfo>();
  for (const r of RECORDINGS) for (const v of startOf(r)?.voices ?? []) if (!seen.has(v.id)) seen.set(v.id, v);
  return [...seen.values()];
})();

/** Day of the oldest recording, e.g. "2026-11-12". */
export const DEMO_RECORDED_ON: string = RECORDINGS.map((r) => r.recordedAt.slice(0, 10)).sort()[0] ?? "";

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z']{4,}/g) ?? []);

/** The recording for a prompt: exact match if there is one, else the closest by shared words. */
export function matchRecording(prompt: string): { recording: Recording; exact: boolean } {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const exact = RECORDINGS.find((r) => norm(r.prompt) === norm(prompt));
  if (exact) return { recording: exact, exact: true };
  const want = words(prompt);
  let best = RECORDINGS[0];
  let bestScore = -1;
  for (const r of RECORDINGS) {
    let score = 0;
    for (const w of words(r.prompt)) if (want.has(w)) score++;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return { recording: best, exact: false };
}

function summarise(steps: Step[], voiceIds: string[], elapsedMs: number): Summary {
  const influence: Record<string, number> = Object.fromEntries(voiceIds.map((id) => [id, 0]));
  const led: Record<string, number> = Object.fromEntries(voiceIds.map((id) => [id, 0]));
  let costUsd = 0;
  let agreement = 0;
  for (const s of steps) {
    agreement += s.agreement;
    if (s.lead in led) led[s.lead] += 1;
    for (const b of s.ballots) {
      costUsd += b.costUsd;
      if (b.voiceId in influence) influence[b.voiceId] += b.share / steps.length;
    }
  }
  return {
    tokens: steps.length,
    elapsedMs,
    costUsd,
    influence,
    led,
    agreement: steps.length ? agreement / steps.length : 1,
    contested: [...steps]
      .filter((s) => s.agreement < 0.999)
      .sort((a, b) => a.agreement - b.agreement)
      .slice(0, 8)
      .map((s) => s.index),
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export interface ReplayOptions {
  /** Pause before each token. The live run took about 2 s per token; the replay does not make you wait for that. */
  stepDelayMs?: number;
  runId?: string;
}

/** Replay the recording that matches the request, as the same event stream the live engine emits. */
export async function* replay(request: PerformRequest, signal: AbortSignal, opts: ReplayOptions = {}): AsyncGenerator<PerformEvent> {
  const delay = opts.stepDelayMs ?? 110;
  const { recording, exact } = matchRecording(request.prompt);
  const start = startOf(recording);
  const voices = start?.voices ?? DEMO_VOICE_INFOS;

  yield {
    type: "start",
    runId: opts.runId ?? `demo-${Date.now().toString(36)}`,
    mode: "demo",
    voices,
    request: start?.request ?? request,
  };

  if (request.prefix?.length || request.forcedNext) {
    yield {
      type: "error",
      fatal: true,
      message: "Forking needs live model calls. The demo replays recorded performances; add an OPENROUTER_API_KEY to fork.",
    };
    return;
  }
  if (!exact) {
    yield {
      type: "error",
      fatal: false,
      message: `The demo replays recorded live performances, so it cannot answer a new prompt. Playing the recording for “${recording.prompt}”. Add an OPENROUTER_API_KEY to ask anything.`,
    };
  }

  const played: Step[] = [];
  const t0 = Date.now();
  for (const ev of recording.events) {
    if (ev.type === "start") continue;
    if (ev.type === "step") {
      await sleep(delay, signal);
      if (signal.aborted) break;
      played.push(ev.step);
    }
    if (signal.aborted) break;
    yield ev;
    if (ev.type === "done") return;
  }
  yield {
    type: "done",
    reason: "aborted",
    summary: summarise(played, voices.map((v) => v.id), Date.now() - t0),
  };
}
