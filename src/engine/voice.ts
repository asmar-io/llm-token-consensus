/**
 * The seam between the mixing engine and whatever produces next-token
 * distributions (simulated demo voices, OpenRouter models, ...).
 *
 * Owned by the conductor. Engine and live-voice workers both build against it.
 */
import type { VoiceInfo } from "@/lib/protocol";

export interface VoiceContext {
  system?: string;
  prompt: string;
  /** Everything the choir has emitted so far, concatenated. "" on the first step. */
  textSoFar: string;
  /** 0-based index of the step being decided. */
  stepIndex: number;
  signal: AbortSignal;
}

export interface VoiceDistribution {
  /**
   * The voice's top next-piece candidates, best first, with natural-log
   * probabilities. Token strings are raw text exactly as they would be
   * appended (leading spaces preserved). Use the EOS sentinel from
   * "@/lib/protocol" for "stop here". Up to ~20 entries; need not sum to 1.
   */
  top: { token: string; logprob: number }[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Voice {
  info: VoiceInfo;
  /** Must reject (not hang) on abort, timeout or provider error. */
  next(ctx: VoiceContext): Promise<VoiceDistribution>;
}
