"use client";

import { create } from "zustand";
import type { ChoirInfo, PerformRequest, PerformSettings, Step, Summary, VoiceInfo } from "@/lib/protocol";

export type Lens = "agreement" | "voice" | "confidence" | "plain";
export const LENSES: { id: Lens; label: string; hint: string }[] = [
  { id: "agreement", label: "Agreement", hint: "Calm where the voices agreed, hot where they split" },
  { id: "voice", label: "Voice", hint: "Tinted by the voice that carried each word" },
  { id: "confidence", label: "Confidence", hint: "Stronger tint where the blend was less sure" },
  { id: "plain", label: "Plain", hint: "Just the text" },
];

export type TakeStatus = "connecting" | "performing" | "stopped" | "finished" | "error";

export interface Notice {
  voiceId?: string;
  message: string;
}

export interface Take {
  id: string;
  n: number;
  prompt: string;
  request: PerformRequest | null;
  voices: VoiceInfo[];
  steps: Step[];
  status: TakeStatus;
  reason?: "eos" | "max_tokens" | "aborted";
  summary?: Summary;
  error?: string;
  notices: Notice[];
  parentId?: string;
  /** Index of the first step that differs from the parent take. */
  forkIndex?: number;
  forkToken?: string;
  startedAt: number;
  endedAt?: number;
  mode: "demo" | "live";
  mock: boolean;
}

export interface ChannelState {
  gain: number;
  muted: boolean;
}

export interface Replay {
  takeId: string;
  cursor: number;
  playing: boolean;
  speed: number;
  session: number;
}

export type Theme = "dark" | "light";

interface State {
  boot: "loading" | "ready";
  choir: ChoirInfo | null;
  mock: boolean;
  mockReason: string | null;
  settings: PerformSettings;
  channels: Record<string, ChannelState>;
  solo: string | null;
  prompt: string;

  takes: Take[];
  activeTakeId: string | null;

  selected: number | null;
  hover: number | null;
  hoverSource: "text" | "score" | null;
  lens: Lens;
  panel: "inspector" | "mixer";
  mixerSheet: boolean;
  sound: boolean;
  theme: Theme;
  replay: Replay | null;
  announce: string;
}

interface Actions {
  set: (p: Partial<State>) => void;
  setChoir: (c: ChoirInfo, mock: boolean, reason?: string | null) => void;
  setSettings: (p: Partial<PerformSettings>) => void;
  setChannel: (id: string, p: Partial<ChannelState>) => void;
  toggleSolo: (id: string) => void;
  addTake: (t: Take, reset: boolean) => void;
  updateTake: (id: string, fn: (t: Take) => Take) => void;
  pushStep: (id: string, s: Step) => void;
  select: (i: number | null) => void;
  setHover: (i: number | null, src?: "text" | "score") => void;
}

export const useChorus = create<State & Actions>()((set, get) => ({
  boot: "loading",
  choir: null,
  mock: false,
  mockReason: null,
  settings: { blend: "mixture", temperature: 0.7, seed: 1729, maxTokens: 200 },
  channels: {},
  solo: null,
  prompt: "",
  takes: [],
  activeTakeId: null,
  selected: null,
  hover: null,
  hoverSource: null,
  lens: "agreement",
  panel: "mixer",
  mixerSheet: false,
  sound: false,
  theme: "dark",
  replay: null,
  announce: "",

  set: (p) => set(p),
  setChoir: (c, mock, reason = null) =>
    set({
      choir: c,
      mock,
      mockReason: reason,
      boot: "ready",
      settings: { ...c.defaults },
      channels: Object.fromEntries(c.voices.map((v) => [v.id, { gain: 1, muted: false }])),
      solo: null,
    }),
  setSettings: (p) => set({ settings: { ...get().settings, ...p } }),
  setChannel: (id, p) => {
    const cur = get().channels[id] ?? { gain: 1, muted: false };
    set({ channels: { ...get().channels, [id]: { ...cur, ...p } } });
  },
  toggleSolo: (id) => set({ solo: get().solo === id ? null : id }),
  addTake: (t, reset) =>
    set({
      takes: reset ? [t] : [...get().takes, t],
      activeTakeId: t.id,
      replay: null,
    }),
  updateTake: (id, fn) => set({ takes: get().takes.map((t) => (t.id === id ? fn(t) : t)) }),
  pushStep: (id, s) =>
    set({
      takes: get().takes.map((t) => {
        if (t.id !== id) return t;
        const steps = s.index === t.steps.length ? [...t.steps, s] : [...t.steps.slice(0, Math.max(0, s.index)), s];
        return { ...t, steps, status: "performing" };
      }),
    }),
  select: (i) => set(i == null ? { selected: null } : { selected: i, panel: "inspector" }),
  setHover: (i, src) => set({ hover: i, hoverSource: i == null ? null : (src ?? "text") }),
}));

export function getActiveTake(s: { takes: Take[]; activeTakeId: string | null }): Take | undefined {
  return s.takes.find((t) => t.id === s.activeTakeId);
}

export function useActiveTake(): Take | undefined {
  return useChorus((s) => getActiveTake(s));
}

/** Steps currently shown (replay can hide the tail). */
export function visibleCount(take: Take | undefined, replay: Replay | null): number {
  if (!take) return 0;
  if (replay && replay.takeId === take.id) return Math.min(replay.cursor, take.steps.length);
  return take.steps.length;
}

/** The weights the next performance will use. */
export function buildVoiceWeights(s: Pick<State, "choir" | "channels" | "solo">): { id: string; weight: number }[] {
  const voices = s.choir?.voices ?? [];
  return voices.map((v) => {
    const ch = s.channels[v.id] ?? { gain: 1, muted: false };
    let w = ch.muted ? 0 : ch.gain;
    if (s.solo) w = v.id === s.solo ? Math.max(ch.gain, 0.05) : 0;
    return { id: v.id, weight: Math.round(Math.max(0, w) * 100) / 100 };
  });
}

export function singingCount(s: Pick<State, "choir" | "channels" | "solo">): number {
  return buildVoiceWeights(s).filter((v) => v.weight > 0).length;
}
