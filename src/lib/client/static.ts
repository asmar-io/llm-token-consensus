/**
 * Static build (GitHub Pages): there is no server, so the demo choir runs in
 * the browser. Set NEXT_PUBLIC_STATIC=1 at build time to turn this on.
 * Only the recorded demo is bundled; nothing here touches OpenRouter.
 */
import type { ChoirInfo, PerformEvent, PerformRequest } from "@/lib/protocol";
import { DEMO_RECORDED_ON, DEMO_SAMPLE_PROMPTS, DEMO_VOICE_INFOS, replay } from "@/engine/demo";

export const STATIC_BUILD = process.env.NEXT_PUBLIC_STATIC === "1";

export function staticChoir(): ChoirInfo {
  return {
    mode: "demo",
    voices: DEMO_VOICE_INFOS,
    defaults: { blend: "mixture", temperature: 0.7, seed: Math.floor(Math.random() * 2 ** 31), maxTokens: 120 },
    samplePrompts: DEMO_SAMPLE_PROMPTS,
    note: `This hosted demo replays real performances recorded from the live choir on ${DEMO_RECORDED_ON}, exactly as they happened. To ask your own questions and fork, run Chorus locally with an OpenRouter key (see the README).`,
  };
}

export function staticPerform(req: PerformRequest, signal: AbortSignal): AsyncGenerator<PerformEvent> {
  return replay(req, signal);
}
