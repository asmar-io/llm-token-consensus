"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { Summary } from "@/lib/protocol";
import { makeLookup } from "./palette";
import type { Take } from "./store";
import { computeSummary } from "./summary";

const subs = new Map<string, (cb: () => void) => () => void>();

function subscribeMedia(query: string) {
  const hit = subs.get(query);
  if (hit) return hit;
  const fn = (cb: () => void) => {
    const m = window.matchMedia(query);
    m.addEventListener("change", cb);
    return () => m.removeEventListener("change", cb);
  };
  subs.set(query, fn);
  return fn;
}

export function useMedia(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    subscribeMedia(query),
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

export function useIsDesktop() {
  return useMedia("(min-width: 1024px)", true);
}

export function useReducedMotionPref() {
  return useMedia("(prefers-reduced-motion: reduce)");
}

export function useLookup(take: Take | undefined) {
  const voices = take?.voices;
  return useMemo(() => makeLookup(voices ?? []), [voices]);
}

/**
 * Running influence. Derived from the steps while streaming; the server's
 * Summary takes over once the take is done.
 */
export function useTakeSummary(take: Take | undefined, upTo?: number): Summary | null {
  const steps = take?.steps;
  const voices = take?.voices;
  const server = take?.summary;
  const n = upTo ?? steps?.length ?? 0;
  return useMemo(() => {
    if (!steps || !voices) return null;
    if (server && n >= steps.length) return server;
    return computeSummary(steps.slice(0, n), voices.map((v) => v.id));
  }, [steps, voices, server, n]);
}
