/**
 * Which choir is on stage.
 *   live: an OPENROUTER_API_KEY is set and at least two live voices can be
 *         built. Every verified model is on offer; the UI picks which sing.
 *   demo: no key. Recorded live performances are replayed (see demo/recorded.ts).
 */
import type { ChoirInfo, PerformSettings, VoiceInfo } from "@/lib/protocol";
import type { Voice } from "@/engine/voice";
import { createLiveVoices, liveAvailable } from "@/engine/voices/openrouter";
import { defaultVoiceIds } from "@/engine/voices/catalog";
import { DEMO_RECORDED_ON, DEMO_SAMPLE_PROMPTS, DEMO_VOICE_INFOS } from "@/engine/demo";

export const DEMO_NOTE = `No OPENROUTER_API_KEY is set, so this is a replay: real performances recorded from the live choir on ${DEMO_RECORDED_ON}, shown exactly as they happened. Add a key to ask your own questions, choose the models and fork.`;

export const LIVE_NOTE =
  "Every token is decided by real model calls through OpenRouter. Expect about two seconds per token and roughly one to three US cents per short answer.";

export const LIVE_SAMPLE_PROMPTS = [
  "Should AI models be allowed to refuse requests? Answer in two sentences.",
  "Is it ever right to break a promise? Answer in two sentences.",
  "Who should decide what an AI is allowed to say? Answer in two sentences.",
  "Is it okay to lie to spare someone's feelings? Answer in two sentences.",
  "What do we owe future generations? Answer in two sentences.",
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

export function currentMode(): "demo" | "live" {
  return stage().mode;
}

export function defaultSettings(): PerformSettings {
  return { blend: "mixture", temperature: 0.7, seed: Math.floor(Math.random() * 2 ** 31), maxTokens: 120 };
}

export function getChoirInfo(): ChoirInfo {
  const s = stage();
  if (s.mode === "live") {
    const voices = s.voices.map((v) => v.info);
    return {
      mode: "live",
      voices,
      defaultVoices: defaultVoiceIds(voices),
      defaults: defaultSettings(),
      samplePrompts: LIVE_SAMPLE_PROMPTS,
      note: LIVE_NOTE,
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
  | { ok: true; voices: Voice[]; infos: VoiceInfo[] }
  | { ok: false; error: string; unknown: string[] };

/** Resolve the voice ids of a live perform request against the voices on offer. */
export function resolveVoices(ids: string[]): Resolved {
  const s = stage();
  const pool = s.mode === "live" ? s.voices : [];
  const byId = new Map(pool.map((v) => [v.info.id, v]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      unknown,
      error: `Unknown voice id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`,
    };
  }
  const voices = ids.map((id) => byId.get(id)!);
  return { ok: true, voices, infos: voices.map((v) => v.info) };
}
