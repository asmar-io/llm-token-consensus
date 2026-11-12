/**
 * Which choir is on stage: live OpenRouter voices when an API key is set and
 * at least two live voices can be built, otherwise the simulated demo choir.
 */
import type { ChoirInfo, PerformSettings, VoiceInfo } from "@/lib/protocol";
import type { Voice } from "@/engine/voice";
import { createLiveVoices, liveAvailable } from "@/engine/voices/openrouter";
import { createDemoVoices, DEMO_SAMPLE_PROMPTS, DEMO_VOICE_INFOS } from "@/engine/demo";

export const DEMO_NOTE =
  "No OPENROUTER_API_KEY is set, so the choir is simulated: five fictional voices performing scripted sample prompts. Add a key to hear real models.";

export const LIVE_SAMPLE_PROMPTS = [
  "Should AI models be allowed to refuse requests?",
  "Is it ever right to break a promise?",
  "Who should decide what an AI is allowed to say?",
  "Is it okay to lie to spare someone's feelings?",
  "Should rich countries take in more refugees?",
  "What do we owe future generations?",
  "Describe the perfect city in two sentences.",
];

type Stage = { mode: "live"; voices: Voice[] } | { mode: "demo"; voices: null };

/** Decide the mode. Live voices are built fresh each call (cheap; picks up env changes). */
function stage(): Stage {
  if (liveAvailable()) {
    try {
      const voices = createLiveVoices();
      if (voices.length >= 2) return { mode: "live", voices };
    } catch {
      // fall through to demo
    }
  }
  return { mode: "demo", voices: null };
}

export function defaultSettings(): PerformSettings {
  return { blend: "mixture", temperature: 0.7, seed: Math.floor(Math.random() * 2 ** 31), maxTokens: 160 };
}

export function getChoirInfo(): ChoirInfo {
  const s = stage();
  if (s.mode === "live") {
    return {
      mode: "live",
      voices: s.voices.map((v) => v.info),
      defaults: defaultSettings(),
      samplePrompts: LIVE_SAMPLE_PROMPTS,
    };
  }
  return {
    mode: "demo",
    voices: DEMO_VOICE_INFOS,
    defaults: defaultSettings(),
    samplePrompts: DEMO_SAMPLE_PROMPTS,
    note: DEMO_NOTE,
  };
}

export type Resolved =
  | { ok: true; mode: "demo" | "live"; voices: Voice[]; infos: VoiceInfo[] }
  | { ok: false; error: string; unknown: string[] };

/**
 * Resolve the voice ids of a perform request against the current choir.
 * Demo voices are created per request because their noise is seeded by the
 * request seed (VoiceContext carries no seed).
 */
export function resolveVoices(ids: string[], opts: { seed: number; latencyScale?: number }): Resolved {
  const s = stage();
  const pool = s.mode === "live" ? s.voices : createDemoVoices({ seed: opts.seed, latencyScale: opts.latencyScale });
  const byId = new Map(pool.map((v) => [v.info.id, v]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      unknown,
      error: `Unknown voice id${unknown.length > 1 ? "s" : ""} for the ${s.mode} choir: ${unknown.join(", ")}.`,
    };
  }
  const voices = ids.map((id) => byId.get(id)!);
  return { ok: true, mode: s.mode, voices, infos: voices.map((v) => v.info) };
}
