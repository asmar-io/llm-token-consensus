/**
 * Script machinery for the simulated choir: a tiny template language, the
 * simulated voices' tokenizers, and "where am I?" location from textSoFar.
 *
 * Template syntax: plain text is a fixed unit; `[a|b@bl|c@k]` is a contested
 * unit with options a, b, c. Text after `@` lists the temperament letters
 * that favour that option (c cautious, b blunt, t techno-optimist,
 * k community/tradition, l legalistic). The first option is the canonical one
 * that every voice finds at least somewhat plausible. Options carry their own
 * leading spaces and may be several words long (a branch-local continuation
 * that rejoins the main line at the next unit).
 */

export type Temperament = "c" | "b" | "t" | "k" | "l";

export interface ScriptOption {
  text: string;
  tags: Temperament[];
}

export interface ScriptUnit {
  options: ScriptOption[];
  contested: boolean;
}

export interface Script {
  id: string;
  prompt: string;
  /** Extra match words beyond the prompt's own content words. */
  keywords?: string[];
  units: ScriptUnit[];
  /** Not offered as a sample prompt (the "I can only do samples" script). */
  hidden?: boolean;
}

export function parseTemplate(id: string, prompt: string, template: string, extra: Partial<Script> = {}): Script {
  const units: ScriptUnit[] = [];
  let i = 0;
  while (i < template.length) {
    if (template[i] === "[") {
      const close = template.indexOf("]", i);
      if (close < 0) throw new Error(`Script ${id}: unclosed [ at ${i}`);
      const body = template.slice(i + 1, close);
      const options = body.split("|").map((raw) => {
        const at = raw.lastIndexOf("@");
        const text = at >= 0 ? raw.slice(0, at) : raw;
        const tags = (at >= 0 ? raw.slice(at + 1) : "").split("").filter((c): c is Temperament => "cbtkl".includes(c));
        if (text.length === 0) throw new Error(`Script ${id}: empty option in [${body}]`);
        return { text, tags };
      });
      units.push({ options, contested: options.length > 1 });
      i = close + 1;
    } else {
      const next = template.indexOf("[", i);
      const end = next < 0 ? template.length : next;
      units.push({ options: [{ text: template.slice(i, end), tags: [] }], contested: false });
      i = end;
    }
  }
  return { id, prompt, units, ...extra };
}

// ---------------------------------------------------------------------------
// Tokenizers. Each simulated voice cuts words differently so alignment across
// tokenizers is exercised for real.
// ---------------------------------------------------------------------------

export type TokenizerProfile =
  | { kind: "suffix"; minLen: number; suffixes: string[] }
  | { kind: "half"; minLen: number }
  | { kind: "head"; minLen: number; head: number }
  | { kind: "whole" };

const BASE_RE = /\n+| ?[\p{L}\p{N}'’]+| ?[^\s\p{L}\p{N}]| +/gu;

function splitWord(piece: string, profile: TokenizerProfile): string[] {
  const lead = piece.startsWith(" ") ? " " : "";
  const word = piece.slice(lead.length);
  if (!/^[\p{L}]/u.test(word) || profile.kind === "whole" || word.length < profile.minLen) return [piece];
  let cut = -1;
  if (profile.kind === "suffix") {
    const lower = word.toLowerCase();
    for (const s of [...profile.suffixes].sort((a, b) => b.length - a.length)) {
      if (lower.endsWith(s) && word.length - s.length >= 3) {
        cut = word.length - s.length;
        break;
      }
    }
  } else if (profile.kind === "half") {
    cut = Math.ceil(word.length / 2);
  } else if (profile.kind === "head") {
    cut = profile.head;
  }
  if (cut <= 0 || cut >= word.length) return [piece];
  return [lead + word.slice(0, cut), word.slice(cut)];
}

const tokCache = new Map<string, number[]>();

/** Piece boundaries (end offsets) of `text` under a profile, cached. */
export function boundaries(text: string, profile: TokenizerProfile): number[] {
  const key = JSON.stringify(profile) + "\u0000" + text;
  const hit = tokCache.get(key);
  if (hit) return hit;
  const ends: number[] = [];
  let pos = 0;
  for (const m of text.matchAll(BASE_RE)) {
    if (m.index !== pos) {
      // Unmatched characters (should not happen with this regex): treat as one piece.
      pos = m.index!;
      ends.push(pos);
    }
    for (const part of splitWord(m[0], profile)) {
      pos += part.length;
      ends.push(pos);
    }
  }
  if (pos < text.length) ends.push(text.length);
  if (tokCache.size > 5000) tokCache.clear();
  tokCache.set(key, ends);
  return ends;
}

export function tokenize(text: string, profile: TokenizerProfile): string[] {
  const out: string[] = [];
  let start = 0;
  for (const e of boundaries(text, profile)) {
    out.push(text.slice(start, e));
    start = e;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** Where a voice can be after reading textSoFar. */
export type Position =
  /** At the start of unit `unit` (== units.length means the script is finished). */
  | { kind: "boundary"; unit: number; via: number | null }
  /** Inside option `option` of unit `unit`, `offset` chars in (0 < offset < text length). */
  | { kind: "inside"; unit: number; option: number; offset: number };

/**
 * All positions consistent with reading `text` (starting at char `from`) from
 * the start of unit `startUnit`. Breadth-first over unit boundaries; the set of
 * live character positions per boundary stays tiny, so this is cheap.
 */
function parseFrom(script: Script, text: string, from: number, startUnit: number): { ends: Position[]; deepest: { unit: number; pos: number } } {
  const ends: Position[] = [];
  let frontier = new Map<number, number | null>([[from, null]]);
  let deepest = { unit: startUnit, pos: from };
  for (let k = startUnit; k <= script.units.length && frontier.size > 0; k++) {
    const next = new Map<number, number | null>();
    for (const [pos, via] of frontier) {
      if (pos > deepest.pos || (pos === deepest.pos && k > deepest.unit)) deepest = { unit: k, pos };
      if (pos === text.length) ends.push({ kind: "boundary", unit: k, via });
      if (k === script.units.length) continue;
      const rest = text.length - pos;
      script.units[k].options.forEach((opt, o) => {
        if (opt.text.length <= rest) {
          if (text.startsWith(opt.text, pos)) next.set(pos + opt.text.length, o);
        } else if (rest > 0 && opt.text.startsWith(text.slice(pos))) {
          ends.push({ kind: "inside", unit: k, option: o, offset: rest });
        }
      });
    }
    frontier = next;
  }
  return { ends, deepest };
}

export interface Located {
  positions: Position[];
  /** True when textSoFar left the script and the voice had to rejoin it. */
  resynced: boolean;
}

/**
 * Locate a voice in its script from textSoFar alone.
 *
 * Normal case: every text the choir can produce is a concatenation of option
 * texts, possibly cut mid-piece (the mix chose another voice's coarser cut),
 * so an exact parse exists. After an off-script fork (a forced token nobody
 * proposed, or a prefix from another prompt) the parse fails; then the voice
 * treats the unparseable tail as a detour and rejoins at a later unit: it looks
 * for the earliest point in the tail from which the rest parses again starting
 * at one of the next few units, falling back to "start of the next unit".
 */
export function locate(script: Script, textSoFar: string): Located {
  const first = parseFrom(script, textSoFar, 0, 0);
  if (first.ends.length > 0) return { positions: first.ends, resynced: false };

  const { unit: kmax, pos: pmax } = first.deepest;
  const lastUnit = script.units.length;
  // Candidate rejoin points: just before whitespace/punctuation in the tail, and the end.
  const joins: number[] = [];
  for (let j = pmax + 1; j < textSoFar.length; j++) {
    if (/[\s\p{P}]/u.test(textSoFar[j])) joins.push(j);
  }
  joins.push(textSoFar.length);
  for (const j of joins) {
    for (let k = kmax + 1; k <= Math.min(lastUnit, kmax + 6); k++) {
      const r = parseFrom(script, textSoFar, j, k);
      if (r.ends.length > 0) return { positions: r.ends, resynced: true };
    }
  }
  return { positions: [{ kind: "boundary", unit: Math.min(lastUnit, kmax + 1), via: null }], resynced: true };
}
