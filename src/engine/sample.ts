/**
 * Sampling from the mixed distribution, plus the small deterministic PRNG
 * helpers the rest of the engine (and the simulated choir) share.
 *
 * Determinism: the random number for step k is derived only from
 * (request.seed, k), so replaying a request reproduces it exactly and a fork
 * that starts at step k draws the same numbers the original run would have
 * drawn from step k onward.
 */

/** 32-bit FNV-1a over a string. */
export function hashString(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finaliser: good avalanche for combining integers. */
export function mix32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Combine several integers / strings into one 32-bit seed. */
export function combineSeed(...parts: (number | string)[]): number {
  let h = 0x9e3779b9;
  for (const part of parts) {
    const v = typeof part === "number" ? mix32(Math.floor(part) >>> 0) ^ mix32(Math.floor(part / 2 ** 32) >>> 0) : hashString(part);
    h = mix32(h ^ v ^ (h << 6) ^ (h >>> 2));
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, good-enough PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The PRNG used to pick the token at a given step of a performance. */
export function stepRng(seed: number, stepIndex: number): () => number {
  return mulberry32(combineSeed("chorus-step", seed, stepIndex));
}

export type Dist = Map<string, number>;

/** Entries sorted best first; ties broken by token string so order never depends on insertion order. */
export function sortedEntries(dist: Dist): [string, number][] {
  return [...dist.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Apply temperature to a distribution: p^(1/T), renormalised. Computed in log
 * space so tiny temperatures do not underflow to all-zero. T <= 0 returns a
 * one-hot on the argmax.
 */
export function applyTemperature(dist: Dist, temperature: number): Dist {
  const entries = sortedEntries(dist).filter(([, p]) => p > 0 && Number.isFinite(p));
  const out: Dist = new Map();
  if (entries.length === 0) return out;
  if (!(temperature > 0)) {
    out.set(entries[0][0], 1);
    return out;
  }
  const logs = entries.map(([, p]) => Math.log(p) / temperature);
  const max = Math.max(...logs);
  let z = 0;
  const ex = logs.map((l) => {
    const e = Math.exp(l - max);
    z += e;
    return e;
  });
  entries.forEach(([t], i) => out.set(t, ex[i] / z));
  return out;
}

/**
 * Pick a token from the mixed distribution. Returns null only when the
 * distribution has no positive mass at all.
 */
export function sampleToken(dist: Dist, temperature: number, rng: () => number): string | null {
  const tempered = applyTemperature(dist, temperature);
  const entries = sortedEntries(tempered);
  if (entries.length === 0) return null;
  if (!(temperature > 0)) return entries[0][0];
  const u = rng();
  let acc = 0;
  for (const [token, p] of entries) {
    acc += p;
    if (u < acc) return token;
  }
  return entries[entries.length - 1][0];
}
