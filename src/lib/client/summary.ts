import type { Step, Summary } from "@/lib/protocol";
import { fin } from "./format";

/**
 * Summary derived on the client from the steps seen so far. Used mid-stream
 * for running influence, and as a fallback when the server sends none.
 */
export function computeSummary(steps: Step[], voiceIds: string[]): Summary {
  const shareSum: Record<string, number> = {};
  const led: Record<string, number> = {};
  for (const id of voiceIds) {
    shareSum[id] = 0;
    led[id] = 0;
  }
  let agreeSum = 0;
  let agreeN = 0;
  let elapsed = 0;
  let cost = 0;
  let counted = 0;

  for (const s of steps) {
    if (!s) continue;
    let stepTotal = 0;
    for (const b of s.ballots ?? []) {
      if (fin(b.share)) stepTotal += b.share;
      if (fin(b.costUsd)) cost += b.costUsd;
    }
    if (stepTotal > 0) {
      counted++;
      for (const b of s.ballots ?? []) {
        if (!fin(b.share)) continue;
        shareSum[b.voiceId] = (shareSum[b.voiceId] ?? 0) + b.share / stepTotal;
      }
    }
    if (s.lead) led[s.lead] = (led[s.lead] ?? 0) + 1;
    if (fin(s.agreement)) {
      agreeSum += s.agreement;
      agreeN++;
    }
    if (fin(s.elapsedMs)) elapsed += s.elapsedMs;
  }

  const influence: Record<string, number> = {};
  for (const [id, v] of Object.entries(shareSum)) influence[id] = counted ? v / counted : 0;

  const contested = steps
    .filter((s) => s && fin(s.agreement))
    .sort((a, b) => a.agreement - b.agreement)
    .slice(0, 8)
    .map((s) => s.index);

  return {
    tokens: steps.length,
    elapsedMs: elapsed,
    costUsd: cost,
    influence,
    led,
    agreement: agreeN ? agreeSum / agreeN : 0,
    contested,
  };
}
