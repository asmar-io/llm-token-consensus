/**
 * The default live choir and model metadata for OpenRouter voices.
 *
 * Source: the public model list https://openrouter.ai/api/v1/models and the
 * per-model provider lists https://openrouter.ai/api/v1/models/{slug}/endpoints,
 * checked on CATALOG_CHECKED below.
 *
 * Selection rules
 *  - open-weight chat models whose `supported_parameters` list both
 *    `logprobs` and `top_logprobs`;
 *  - NOT reasoning models (no `reasoning` / `include_reasoning` parameter):
 *    a reasoning model would spend the single output token on hidden thinking;
 *  - different labs, different countries where the list allows it;
 *  - cheap and fast (one request per voice per output token).
 *
 * Important caveat found while checking: the model-level `supported_parameters`
 * is a union over providers. Only some providers of each model honour
 * logprobs (see the per-endpoint lists noted on each entry). The adapter sends
 * `provider.require_parameters: true` so OpenRouter only routes to those.
 *
 * Pricing is the model-list figure (USD per million tokens). The provider that
 * actually serves a logprobs request can differ, so the adapter prefers the
 * `usage.cost` that OpenRouter returns and falls back to these figures.
 */
import type { VoiceInfo } from "@/lib/protocol";

/** Date the model list and endpoint lists were checked. */
export const CATALOG_CHECKED = "2026-11-12";

export type LiveVoiceInfo = VoiceInfo & { simulated: false };

/** The default choir (5 voices, 5 labs, 3 countries). */
export const DEFAULT_CHOIR: LiveVoiceInfo[] = [
  {
    // logprobs-capable providers on CATALOG_CHECKED: AkashML, Parasail,
    // Cloudflare, SambaNova, CoreWeave ($0.20-0.71 in / $0.50-2.25 out).
    id: "meta-llama/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B",
    lab: "Meta",
    origin: "US",
    blurb: "Plain-spoken American generalist; steady, conventional phrasing.",
    simulated: false,
    pricing: { inputPerM: 0.71, outputPerM: 0.71 },
  },
  {
    // logprobs-capable providers: Io Net, DekaLLM, Parasail.
    id: "mistralai/mistral-nemo",
    label: "Mistral Nemo 12B",
    lab: "Mistral AI",
    origin: "France",
    blurb: "Small, quick European model (built with NVIDIA); terse and direct.",
    simulated: false,
    pricing: { inputPerM: 0.029, outputPerM: 0.03 },
  },
  {
    // logprobs-capable providers: NextBit, Parasail.
    id: "google/gemma-3-27b-it",
    label: "Gemma 3 27B",
    lab: "Google",
    origin: "US",
    blurb: "Google's open model; polished, list-friendly, a little formal.",
    simulated: false,
    pricing: { inputPerM: 0.08, outputPerM: 0.35 },
  },
  {
    // logprobs-capable providers: Parasail only (single point of failure).
    id: "qwen/qwen3-235b-a22b-2507",
    label: "Qwen3 235B (2507)",
    lab: "Alibaba (Qwen)",
    origin: "China",
    blurb: "Large non-thinking Qwen MoE; broad multilingual vocabulary.",
    simulated: false,
    pricing: { inputPerM: 0.14, outputPerM: 0.8 },
  },
  {
    // logprobs-capable providers: GMICloud only (single point of failure).
    id: "deepseek/deepseek-chat-v3-0324",
    label: "DeepSeek V3 (0324)",
    lab: "DeepSeek",
    origin: "China",
    blurb: "DeepSeek's non-reasoning chat model; confident, dense prose.",
    simulated: false,
    pricing: { inputPerM: 0.29, outputPerM: 1.14 },
  },
];

/**
 * Extra models with known metadata, usable through CHORUS_MODELS. All list
 * logprobs + top_logprobs and are not reasoning models (CATALOG_CHECKED).
 */
export const KNOWN_MODELS: LiveVoiceInfo[] = [
  ...DEFAULT_CHOIR,
  {
    // logprobs-capable provider: CoreWeave only ($0.22 / $0.22).
    id: "meta-llama/llama-3.1-8b-instruct",
    label: "Llama 3.1 8B",
    lab: "Meta",
    origin: "US",
    blurb: "Tiny, fast Llama; simple and predictable.",
    simulated: false,
    pricing: { inputPerM: 0.02, outputPerM: 0.04 },
  },
  {
    // logprobs-capable provider: Parasail only.
    id: "mistralai/mistral-small-3.2-24b-instruct",
    label: "Mistral Small 3.2 24B",
    lab: "Mistral AI",
    origin: "France",
    blurb: "Mid-size Mistral; crisp instruction following.",
    simulated: false,
    pricing: { inputPerM: 0.1, outputPerM: 0.3 },
  },
  {
    // logprobs-capable provider: DekaLLM only.
    id: "qwen/qwen3-30b-a3b-instruct-2507",
    label: "Qwen3 30B A3B (2507)",
    lab: "Alibaba (Qwen)",
    origin: "China",
    blurb: "Small, fast non-thinking Qwen MoE.",
    simulated: false,
    pricing: { inputPerM: 0.1, outputPerM: 0.3 },
  },
  {
    // logprobs-capable provider: Parasail only.
    id: "qwen/qwen3-next-80b-a3b-instruct",
    label: "Qwen3 Next 80B A3B",
    lab: "Alibaba (Qwen)",
    origin: "China",
    blurb: "Sparse hybrid-attention Qwen; fast, non-thinking.",
    simulated: false,
    pricing: { inputPerM: 0.09, outputPerM: 1.1 },
  },
  {
    // logprobs-capable provider: Parasail only.
    id: "google/gemma-3-4b-it",
    label: "Gemma 3 4B",
    lab: "Google",
    origin: "US",
    blurb: "Very small Gemma; cheap, sometimes naive.",
    simulated: false,
    pricing: { inputPerM: 0.05, outputPerM: 0.1 },
  },
  {
    // logprobs-capable provider: Novita only.
    id: "moonshotai/kimi-k2-0905",
    label: "Kimi K2 (0905)",
    lab: "Moonshot AI",
    origin: "China",
    blurb: "Large MoE from Moonshot; lively, opinionated style.",
    simulated: false,
    pricing: { inputPerM: 0.6, outputPerM: 2.5 },
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

/** Metadata for one slug; unknown slugs get a derived label, lab "Unknown", no pricing. */
export function describeModel(slug: string): LiveVoiceInfo {
  const known = KNOWN_MODELS.find((m) => m.id === slug);
  if (known) return { ...known };
  return {
    id: slug,
    label: labelFromSlug(slug),
    lab: "Unknown",
    origin: "Unknown",
    simulated: false,
  };
}

/**
 * The choir to build: CHORUS_MODELS (comma-separated OpenRouter slugs) when
 * set and non-empty, otherwise DEFAULT_CHOIR. Duplicates are dropped.
 */
export function resolveChoir(env: string | undefined = process.env.CHORUS_MODELS): LiveVoiceInfo[] {
  const slugs = (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (slugs.length === 0) return DEFAULT_CHOIR.map((m) => ({ ...m }));
  return [...new Set(slugs)].map(describeModel);
}
