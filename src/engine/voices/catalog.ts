/**
 * The live choir: which OpenRouter models sing, and exactly how each one is
 * routed so that it CONTINUES the partial answer (see openrouter.ts header).
 *
 * Measured live on 2026-11-12 with scripts/live-smoke.mjs and probes over
 * every logprobs-capable endpoint on OpenRouter (456 model x provider pairs):
 *
 *  - On almost every provider an assistant prefill is CLOSED and a fresh
 *    reply starts ("one two three four" -> "one"/"It"/"five", never " five").
 *    That includes Llama 3.3 70B (AkashML, Parasail, CoreWeave, SambaNova),
 *    Gemma 3/4 (Parasail, NextBit, Vertex, ...), Qwen3 on Parasail/DekaLLM,
 *    Mistral Nemo/Small, GPT-4o, Kimi on Novita/Inceptron, GLM, MiniMax.
 *    The /api/v1/completions endpoint wraps `prompt` in the chat template on
 *    every provider tested, so it is no way out. vLLM pass-through flags
 *    (continue_final_message / add_generation_prompt) are not forwarded.
 *  - Only these continue verifiably (count " five", mid-word "is" via token
 *    healing, EOS after a finished answer, Arabic):
 *      DeepSeek V4 (native template) on StreamLake and Novita
 *      Kimi K2.6 on Moonshot AI's own API with `partial: true`
 *      Qwen3.x on Alibaba's own API with `partial: true` (top_logprobs <= 5)
 *    Mistral's own API honours `prefix: true` but returns no logprobs.
 *  - So every verified voice comes from a Chinese lab. No US or European
 *    open-weight model on OpenRouter passed (checked 2026-11-12).
 *
 * Pricing is the pinned provider's endpoint price (USD per million tokens),
 * used only when a response carries no usage.cost.
 */
import type { VoiceInfo } from "@/lib/protocol";

/** Date the routes below were verified live. */
export const CATALOG_CHECKED = "2026-11-12";

export interface VoiceRoute {
  /** Provider endpoint tags tried in this order, no fallback to others. Empty = OpenRouter picks (unverified). */
  providers: string[];
  /** Mark the prefill message `partial: true` (Moonshot / Alibaba partial mode). */
  partial?: boolean;
  /** Send reasoning: { enabled: false } so the single token is not spent thinking. */
  reasoningOff?: boolean;
  /** top_logprobs to request (Alibaba caps it at 5). Default 20. */
  topLogprobs?: number;
}

export type LiveVoiceInfo = VoiceInfo & { simulated: false };
export type CatalogEntry = LiveVoiceInfo & { route: VoiceRoute; verified?: string };

/** Default choir: the voices that passed every live check on CATALOG_CHECKED. */
export const DEFAULT_CHOIR: CatalogEntry[] = [
  {
    id: "deepseek/deepseek-v4-pro-0813",
    label: "DeepSeek V4 Pro",
    lab: "DeepSeek",
    origin: "China",
    blurb: "Large DeepSeek MoE; dense, confident, slightly formal prose.",
    simulated: false,
    pricing: { inputPerM: 0.66, outputPerM: 1.98 },
    // Novita only. Measured 2026-11-12, 50 identical mid-sentence requests each:
    // StreamLake ignored the prefill and restarted the answer on 4 of 50 (and
    // dropped logprobs on 2 more); Novita continued correctly on 50 of 50.
    route: { providers: ["novita/fp8"], reasoningOff: true },
    verified: CATALOG_CHECKED,
  },
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    lab: "Moonshot AI",
    origin: "China",
    blurb: "Moonshot's open MoE; lively, direct, fond of structure.",
    simulated: false,
    pricing: { inputPerM: 0.95, outputPerM: 4.0 },
    route: { providers: ["moonshotai"], partial: true, reasoningOff: true },
    verified: CATALOG_CHECKED,
  },
  {
    id: "qwen/qwen3.6-27b",
    label: "Qwen3.6 27B",
    lab: "Alibaba (Qwen)",
    origin: "China",
    blurb: "Mid-size dense Qwen; broad multilingual vocabulary, plain phrasing.",
    simulated: false,
    pricing: { inputPerM: 0.45, outputPerM: 2.7 },
    route: { providers: ["alibaba"], partial: true, reasoningOff: true, topLogprobs: 5 },
    verified: CATALOG_CHECKED,
  },
];

/** Further models with known routes, usable through CHORUS_MODELS. */
export const KNOWN_MODELS: CatalogEntry[] = [
  ...DEFAULT_CHOIR,
  {
    // Passed every check on CATALOG_CHECKED (same lab as qwen3.6-27b).
    id: "qwen/qwen3.5-397b-a17b",
    label: "Qwen3.5 397B",
    lab: "Alibaba (Qwen)",
    origin: "China",
    blurb: "Qwen's largest open MoE; careful and thorough.",
    simulated: false,
    pricing: { inputPerM: 0.39, outputPerM: 2.34 },
    route: { providers: ["alibaba"], partial: true, reasoningOff: true, topLogprobs: 5 },
    verified: CATALOG_CHECKED,
  },
  {
    // Passed every check on CATALOG_CHECKED; Novita drops logprobs now and
    // then (the adapter retries once, then falls back to the other healing request).
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash",
    lab: "DeepSeek",
    origin: "China",
    blurb: "Small, fast DeepSeek; terse.",
    simulated: false,
    pricing: { inputPerM: 0.308, outputPerM: 0.924 },
    route: { providers: ["novita/fp8"], reasoningOff: true },
    verified: CATALOG_CHECKED,
  },
  {
    // Passed every check on CATALOG_CHECKED.
    id: "qwen/qwen3.8-flash",
    label: "Qwen3.8 Flash",
    lab: "Alibaba (Qwen)",
    origin: "China",
    blurb: "Cheap, fast Qwen.",
    simulated: false,
    pricing: { inputPerM: 0.15, outputPerM: 0.47 },
    route: { providers: ["alibaba"], partial: true, reasoningOff: true, topLogprobs: 5 },
    verified: CATALOG_CHECKED,
  },
];

/** "meta-llama/llama-3.3-70b-instruct" -> "Llama 3.3 70b Instruct". */
export function labelFromSlug(slug: string): string {
  const name = slug.split("/").pop() ?? slug;
  const base = name.split(":")[0];
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Metadata + route for one CHORUS_MODELS item: "slug" or "slug@providerTag".
 * Unknown slugs get a derived label, lab "Unknown", no pricing, and an
 * unverified route (OpenRouter's choice, or the given provider tag).
 */
export function describeModel(item: string): CatalogEntry {
  const [slug, tag] = item.split("@").map((s) => s.trim());
  const known = KNOWN_MODELS.find((m) => m.id === slug);
  if (known) {
    const entry: CatalogEntry = { ...known, route: { ...known.route, providers: [...known.route.providers] } };
    if (tag) entry.route.providers = [tag];
    return entry;
  }
  return {
    id: slug,
    label: labelFromSlug(slug),
    lab: "Unknown",
    origin: "Unknown",
    simulated: false,
    route: { providers: tag ? [tag] : [] },
  };
}

/**
 * The choir to build: CHORUS_MODELS (comma-separated "slug" or "slug@providerTag")
 * when set and non-empty, otherwise DEFAULT_CHOIR. Duplicates are dropped.
 */
export function resolveChoir(env: string | undefined = process.env.CHORUS_MODELS): CatalogEntry[] {
  const items = (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return DEFAULT_CHOIR.map((m) => describeModel(m.id));
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const item of items) {
    const entry = describeModel(item);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/** The public VoiceInfo of an entry (route and verification stay server side). */
export function toVoiceInfo(entry: CatalogEntry): LiveVoiceInfo {
  const { route: _route, verified: _verified, ...info } = entry;
  void _route;
  void _verified;
  return info;
}
