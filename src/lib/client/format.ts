import { EOS } from "@/lib/protocol";

/** True for real, finite numbers. Everything the UI prints goes through this. */
export function fin(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function clamp01(n: unknown): number {
  if (!fin(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 0.724 -> "72.4%". Tiny values read "<0.1%" instead of "0.0%". */
export function pct(p: unknown, digits = 1): string {
  if (!fin(p)) return "—";
  if (p > 0 && p * 100 < Math.pow(10, -digits)) return `<${Math.pow(10, -digits)}%`;
  return `${(p * 100).toFixed(digits)}%`;
}

export function num(n: unknown, digits = 2): string {
  if (!fin(n)) return "—";
  return n.toFixed(digits);
}

export function bits(n: unknown): string {
  if (!fin(n)) return "—";
  return `${n.toFixed(2)} bits`;
}

export function ms(n: unknown): string {
  if (!fin(n)) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  return `${m} min ${s} s`;
}

export function usd(n: unknown): string {
  if (!fin(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

/**
 * Make a token readable on its own: whitespace becomes visible glyphs.
 * "␣the", "⏎", "⇥". EOS reads "end here".
 */
export function showToken(t: string | undefined | null): string {
  if (t == null) return "—";
  if (t === EOS) return "end here";
  if (t === "") return "∅";
  const lead = t.match(/^\s*/)?.[0] ?? "";
  const trail = lead.length === t.length ? "" : (t.match(/\s*$/)?.[0] ?? "");
  const core = t.slice(lead.length, t.length - trail.length);
  return vis(lead) + core + vis(trail);
}

function vis(ws: string): string {
  return ws.replace(/ /g, "␣").replace(/\n/g, "⏎").replace(/\t/g, "⇥").replace(/\r/g, "");
}

export function isEOS(t: string): boolean {
  return t === EOS;
}

/** Plain-language reading of Step.agreement. */
export function agreementWord(a: unknown): string {
  if (!fin(a)) return "unknown";
  if (a >= 0.9) return "near-identical";
  if (a >= 0.75) return "mostly agreed";
  if (a >= 0.55) return "divided";
  return "deeply split";
}

/** Plain-language reading of mixed entropy. */
export function entropyWord(h: unknown): string {
  if (!fin(h)) return "";
  if (h < 0.5) return "the blend was nearly certain";
  if (h < 1.5) return "a handful of real options";
  if (h < 3) return "many plausible options";
  return "wide open";
}

/** 0 = calm, 1 = hot. Agreement of 0.5 or lower is fully hot. */
export function heatOf(agreement: unknown): number {
  if (!fin(agreement)) return 0;
  return clamp01((1 - agreement) / 0.5);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
