import type { VoiceInfo } from "@/lib/protocol";

/**
 * Six voice colours (Okabe–Ito derived, tuned per theme in globals.css as --v0..--v5).
 * Every colour is paired with a shape so the voice never depends on colour alone.
 */
export const VOICE_COUNT = 6;
export const SHAPES = ["circle", "square", "triangle", "diamond", "triangle-down", "cross"] as const;
export type Shape = (typeof SHAPES)[number];

export function voiceColorVar(i: number): string {
  return i < 0 ? "var(--ink-3)" : `var(--v${i % VOICE_COUNT})`;
}

export function voiceShape(i: number): Shape {
  return i < 0 ? "circle" : SHAPES[i % SHAPES.length];
}

export interface VoiceLookup {
  index: (id: string | undefined) => number;
  info: (id: string | undefined) => VoiceInfo;
}

/** Builds an id -> index/info lookup that never throws on an unknown id. */
export function makeLookup(voices: VoiceInfo[]): VoiceLookup {
  const map = new Map<string, number>();
  voices.forEach((v, i) => map.set(v.id, i));
  return {
    index: (id) => (id != null && map.has(id) ? (map.get(id) as number) : -1),
    info: (id) => {
      const i = id != null ? map.get(id) : undefined;
      if (i != null) return voices[i];
      return {
        id: id ?? "unknown",
        label: id ? shortId(id) : "Unknown voice",
        lab: "Unknown lab",
        origin: "—",
        simulated: false,
      };
    },
  };
}

function shortId(id: string): string {
  const tail = id.split(/[/:]/).pop() ?? id;
  return tail.length > 24 ? `${tail.slice(0, 22)}…` : tail;
}
