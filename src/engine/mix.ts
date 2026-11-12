/**
 * Mixing aligned per-voice distributions into one, and the distribution-level
 * metrics reported per step (shares, agreement, entropy).
 */
import type { BlendMode } from "@/lib/protocol";
import type { Dist } from "@/engine/sample";

export interface MixInput {
  /** Aligned, renormalised P_m over the candidate set (see align.ts). */
  probs: Map<string, number>;
  /** Weight, already normalised across the singing, non-failed voices. */
  weight: number;
}

/**
 * Consensus floor for one voice: half its smallest non-zero aligned
 * probability, clamped to [1e-4, 1e-2]. A token the voice did not list is
 * lifted to the floor, so one voice cannot zero a token outright, but it is
 * punished hard. The upper clamp (my addition) keeps the punishment hard when a
 * voice lists only one or two tokens and its smallest probability is large.
 */
export function consensusFloor(probs: Map<string, number>): number {
  let min = Infinity;
  for (const p of probs.values()) if (p > 0 && p < min) min = p;
  if (!Number.isFinite(min)) return 1e-4;
  return Math.min(1e-2, Math.max(1e-4, min / 2));
}

/** Normalise weights to sum to 1. Returns zeros when the total is not positive. */
export function normaliseWeights(weights: number[]): number[] {
  const total = weights.reduce((a, w) => a + (w > 0 && Number.isFinite(w) ? w : 0), 0);
  if (!(total > 0)) return weights.map(() => 0);
  return weights.map((w) => (w > 0 && Number.isFinite(w) ? w / total : 0));
}

/**
 * Mix aligned distributions.
 *   mixture:   M(c) = Σ w_m P_m(c)
 *   consensus: M(c) ∝ exp(Σ w_m ln max(P_m(c), floor_m))
 * Inputs' weights must already be normalised. Result sums to 1 (or is all
 * zeros if there is no mass anywhere).
 */
export function mix(inputs: MixInput[], candidates: string[], mode: BlendMode): Dist {
  const out: Dist = new Map();
  if (mode === "consensus") {
    const floors = inputs.map((i) => consensusFloor(i.probs));
    const logs = candidates.map((c) =>
      inputs.reduce((s, inp, k) => s + inp.weight * Math.log(Math.max(inp.probs.get(c) ?? 0, floors[k])), 0),
    );
    const max = Math.max(...logs);
    let z = 0;
    const ex = logs.map((l) => {
      const e = Number.isFinite(max) ? Math.exp(l - max) : 0;
      z += e;
      return e;
    });
    candidates.forEach((c, i) => out.set(c, z > 0 ? ex[i] / z : 0));
    return out;
  }
  let z = 0;
  for (const c of candidates) {
    const v = inputs.reduce((s, inp) => s + inp.weight * (inp.probs.get(c) ?? 0), 0);
    out.set(c, v);
    z += v;
  }
  // Already sums to 1 when every input sums to 1; renormalise to absorb float drift
  // and inputs whose aligned vector was all-zero.
  if (z > 0) for (const c of candidates) out.set(c, out.get(c)! / z);
  return out;
}

/**
 * Each singing voice's share of the chosen token's mixed score. Sums to 1.
 *
 *   mixture:   share_m = w_m P_m(c) / M(c)  (exact decomposition of the sum)
 *   consensus: the geometric mean has no additive decomposition, so we use each
 *              voice's weighted log-lift above its floor,
 *                 share_m ∝ w_m · ln(max(P_m(c), floor_m) / floor_m),
 *              which is 0 for a voice that did not support the token at all and
 *              grows monotonically with that voice's support.
 * Falls back to the weights when nobody supported the token (e.g. a forced
 * token no voice listed), so shares never become NaN.
 */
export function shares(inputs: MixInput[], chosen: string, mode: BlendMode): number[] {
  const raw = inputs.map((inp) => {
    const p = inp.probs.get(chosen) ?? 0;
    if (mode === "consensus") {
      const f = consensusFloor(inp.probs);
      return inp.weight * Math.log(Math.max(p, f) / f);
    }
    return inp.weight * p;
  });
  const z = raw.reduce((a, b) => a + b, 0);
  if (z > 0 && Number.isFinite(z)) return raw.map((r) => r / z);
  const wz = inputs.reduce((a, i) => a + i.weight, 0);
  return inputs.map((i) => (wz > 0 ? i.weight / wz : 1 / inputs.length));
}

/** Shannon entropy in bits. */
export function entropyBits(dist: Iterable<number>): number {
  let h = 0;
  for (const p of dist) if (p > 0) h -= p * Math.log2(p);
  return h;
}

/**
 * Agreement = 1 − weighted JSD / log2(n), clamped to 0..1; 1 with one voice.
 * JSD uses the arithmetic (mixture) mean whatever the blend mode, since that is
 * how Jensen-Shannon divergence is defined. Note that with unequal weights the
 * maximum possible JSD is H(w) < log2(n), so agreement never reaches 0 then.
 */
export function agreement(inputs: MixInput[], candidates: string[]): number {
  const n = inputs.length;
  if (n <= 1) return 1;
  const m = candidates.map((c) => inputs.reduce((s, i) => s + i.weight * (i.probs.get(c) ?? 0), 0));
  const hm = entropyBits(m);
  const hAvg = inputs.reduce((s, i) => s + i.weight * entropyBits(candidates.map((c) => i.probs.get(c) ?? 0)), 0);
  const jsd = hm - hAvg;
  const a = 1 - jsd / Math.log2(n);
  if (!Number.isFinite(a)) return 1;
  return Math.min(1, Math.max(0, a));
}
