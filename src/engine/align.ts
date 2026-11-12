/**
 * Cross-tokenizer alignment.
 *
 * Different voices cut text differently: one proposes " dec", another
 * " decentral", a third " decentralised". To mix them we need every voice's
 * probability for the same set of candidate strings.
 *
 * Scheme: EXACT STRING MATCH ONLY.
 *   - the candidate set is the union of the token strings the voices proposed
 *   - for voice m and candidate c, P_m(c) is the probability m gave that exact
 *     string (0 if it did not list it); EOS only ever matches EOS
 *   - P_m is then renormalised over the candidate set.
 *
 * Why no partial credit between cuts of different length. Two earlier versions
 * shared mass between a token and its prefixes/extensions, scaled by length
 * ratio. Both were measured against live models on 2026-11-12 and both
 * corrupted text:
 *   - crediting a SHORTER candidate from longer tokens let a fragment such as
 *     "'" collect the mass of every voice that wanted "'t"; it was sampled and
 *     the word was left broken ("shouldn' be").
 *   - crediting a LONGER candidate from shorter tokens gave one voice's
 *     low-probability " cans" 4/5 of every other voice's " can", so wrong
 *     inflections won ("cans undermine trusts").
 *   A voice's top-k list simply does not say how likely "s" is after " can",
 *   so any ratio is invented mass. With exact matching, voices that cut the
 *   same word differently split their vote across the cuts; whichever cut
 *   wins, the next step continues the word, so the text is unaffected and the
 *   only cost is that such a step reads as less agreed than it really was.
 *
 * Failure cases guarded here:
 *   - empty-string tokens would be a prefix of everything (and length 0 makes
 *     the ratio degenerate): they are dropped.
 *   - tokens containing U+FFFD are partial UTF-8 byte pieces from byte-level
 *     tokenizers; appending them would corrupt the text, so they are dropped.
 *   - NaN / non-finite / positive logprobs are dropped or clamped.
 *   - duplicate tokens in one voice's list are summed, not double-listed.
 *   - a literal token that is a prefix of the EOS sentinel string (e.g. "<|")
 *     never matches EOS, because EOS is handled before any prefix test.
 *   - a voice whose listed tokens relate to no candidate at all gets an
 *     all-zero vector rather than a 0/0 NaN.
 * Whitespace-only candidates are kept (a newline is a legitimate piece).
 */
import type { VoiceDistribution } from "@/engine/voice";

export interface RawCandidate {
  token: string;
  p: number;
}

/** Convert a voice's logprob list to clean probabilities, best first. */
export function toProbs(top: VoiceDistribution["top"]): RawCandidate[] {
  const acc = new Map<string, number>();
  for (const entry of top ?? []) {
    if (!entry || typeof entry.token !== "string") continue;
    const token = entry.token;
    if (token.length === 0 || token.includes("�")) continue;
    const lp = Number(entry.logprob);
    if (Number.isNaN(lp)) continue;
    const p = lp >= 0 ? 1 : Math.exp(lp);
    if (!(p > 0)) continue;
    acc.set(token, (acc.get(token) ?? 0) + p);
  }
  return [...acc.entries()]
    .map(([token, p]) => ({ token, p: Math.min(p, 1) }))
    .sort((a, b) => b.p - a.p || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
}

/** Union of all proposed tokens, in first-seen order, plus any extras (e.g. a forced token). */
export function buildCandidates(lists: RawCandidate[][], extra: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string) => {
    if (t.length === 0 || t.includes("�") || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const list of lists) for (const c of list) add(c.token);
  for (const t of extra) add(t);
  return out;
}

/** How much of voice token t's mass counts toward candidate c: all of it on an exact match, else none. */
export function overlap(t: string, c: string): number {
  return t === c ? 1 : 0;
}

/**
 * Aligned, renormalised probability of each candidate under one voice.
 * Returns zeros (never NaN) when nothing lines up.
 */
export function alignVoice(raw: RawCandidate[], candidates: string[]): Map<string, number> {
  const out = new Map<string, number>();
  let z = 0;
  for (const c of candidates) {
    let s = 0;
    for (const { token, p } of raw) {
      const o = overlap(token, c);
      if (o > 0) s += p * o;
    }
    out.set(c, s);
    z += s;
  }
  if (z > 0 && Number.isFinite(z)) for (const c of candidates) out.set(c, out.get(c)! / z);
  return out;
}
