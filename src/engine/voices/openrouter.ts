/**
 * STUB written by the conductor so the rest of the engine compiles.
 * The live-voice worker replaces the bodies; the exported signatures stay.
 */
import type { Voice } from "@/engine/voice";

/** True when a live choir can be built (OPENROUTER_API_KEY is set). */
export function liveAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** The default live choir. Empty when liveAvailable() is false. */
export function createLiveVoices(): Voice[] {
  return [];
}
