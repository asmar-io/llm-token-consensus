/**
 * Live voices: one OpenRouter model = one Voice. Each `next()` returns the
 * model's distribution over the next piece of the answer written so far.
 *
 * WHAT WAS MEASURED (live, 2026-11-12; details in catalog.ts and the report)
 *   POST /api/v1/chat/completions with messages [user: prompt, assistant:
 *   textSoFar] is the documented prefill shape
 *   (https://openrouter.ai/docs/api_reference/overview.md#assistant-prefill),
 *   but on nearly every provider the assistant message is closed and a fresh
 *   reply begins. Probed with prompt "Count from one to ten in words" and
 *   so-far "one two three four": a continuation must say " five"; a fresh
 *   reply says "one" / "It" / "five" (no space). Only these continued:
 *     - DeepSeek V4 on StreamLake / Novita: plain prefill + reasoning off
 *     - Kimi K2.6 on Moonshot AI: prefill message marked `partial: true`
 *     - Qwen3.x on Alibaba: prefill message marked `partial: true`
 *   The legacy /api/v1/completions endpoint (not in the OpenAPI spec) wraps
 *   `prompt` in the chat template on every provider tested (raw "one two three
 *   four five six" -> "seven", no space), so raw templates are not an option.
 *   Each voice is therefore PINNED to the providers it was verified on
 *   (provider.order + allow_fallbacks false + require_parameters), with its
 *   own flags; see VoiceRoute in catalog.ts.
 *
 * TOKEN HEALING (mid-word)
 *   A prefill ending mid-word ("...is Par") is tokenised unnaturally, and even
 *   a true continuation then goes astray ("Par" -> "ís", i.e. "París", 91%).
 *   When the text ends in a letter/digit we send two requests in parallel:
 *     A: prefill = full text            -> what follows if the word is done
 *     B: prefill = text minus last word -> the model re-picks that word
 *   B's candidates that extend the held-back word (" Paris" for " Par") give
 *   "is"; B's mass on exactly the held word (" Par") is the chance the word is
 *   finished, and scales A. Measured: "Par" -> "is" 100% for all voices,
 *   "one two three four" -> " five" 100% (B puts ~1.0 on " four").
 *   If one of the two requests fails, the other is used alone.
 *
 * WHITESPACE
 *   Measured: a prefill ending in a space confuses DeepSeek on StreamLake
 *   ("four " -> "五" 30%, EOS 18%, " five" 8%); Moonshot and Alibaba trim it.
 *   So a prefill never ends in whitespace: the trailing whitespace is held
 *   back, only candidates starting with it are kept, and it is stripped from
 *   them. If nothing survives, one retry with the untrimmed text.
 *   Note: message.content is sometimes left-trimmed (Novita returns "five"
 *   for the token " five"); token strings in logprobs are authoritative.
 *
 * END OF SEQUENCE
 *   - End tokens in the candidate list (<｜end▁of▁sentence｜>, <|im_end|>,
 *     <|eot_id|>, </s>, <end_of_turn>, ...) and "" map to EOS; duplicates merge
 *     (probabilities summed). Other special tokens are dropped.
 *   - Measured: when the model's choice IS the end token, every verified
 *     provider returns finish_reason "stop", empty content, NO logprobs and
 *     often no usage. With temperature 0 that means EOS is the argmax; we
 *     return EOS with logprob 0 (its exact probability is not reported).
 *
 * BYTES / PARTIAL UTF-8
 *   Measured: `bytes` is unreliable (StreamLake returns code points, Novita
 *   returned corrupted Arabic bytes, Alibaba returns the bytes of U+FFFD for
 *   partial tokens). So the token STRING is authoritative; bytes are used only
 *   to repair a string that is not valid text. Candidates that are not valid
 *   text (U+FFFD, lone surrogates, "bytes:\x..", vLLM's "token:123") are
 *   dropped. If the best candidate is such a partial character, or the
 *   provider returned no logprobs because the chosen token is one (measured
 *   with an emoji answer), one follow-up with max_tokens 4 completes the
 *   character from message.content and returns it as one candidate (with the
 *   partial token's probability when known, else logprob 0). Kimi returned
 *   null content for an emoji answer; that step then fails cleanly.
 *
 * REQUEST
 *   max_tokens 1, logprobs, top_logprobs 20 (5 on Alibaba, its cap),
 *   temperature 0 (measured: logprobs are the same at temperature 1 and 1.5,
 *   so they are pre-temperature; 0 makes the sampled token the argmax),
 *   reasoning { enabled: false } where the route says so.
 *
 * USAGE / COST
 *   usage.cost (credits = USD) when present; else tokens x catalog pricing.
 *   All requests of a step (healing pair, follow-ups, retries) are summed.
 *
 * ERRORS
 *   20 s timeout per request, ctx.signal honoured, one retry on
 *   408/429/5xx/network error (Retry-After honoured, capped at 2 s). Errors
 *   name the model, HTTP status and provider. A response without logprobs
 *   (that is not an end-of-sequence or partial-character case) is an error,
 *   never an empty distribution. The key is read only from
 *   process.env.OPENROUTER_API_KEY and never logged.
 */
import { EOS } from "@/lib/protocol";
import type { Voice, VoiceContext, VoiceDistribution } from "@/engine/voice";
import { resolveChoir, toVoiceInfo, type CatalogEntry, type VoiceRoute } from "@/engine/voices/catalog";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_TOP_LOGPROBS = 20;
const MAX_CANDIDATES = 20;
const RETRY_DELAY_MS = 400;
const MAX_RETRY_AFTER_MS = 2_000;
/** B's consistent mass at or above which the healed distribution is used as is. */
const HEAL_FULL_TRUST = 0.25;
const FOLLOWUP_MAX_TOKENS = 4;

/** Known end-of-turn / end-of-text tokens across chat templates. */
export const END_TOKENS: ReadonlySet<string> = new Set([
  "<|eot_id|>",
  "<|eom_id|>",
  "<|end_of_text|>",
  "<|im_end|>",
  "<|endoftext|>",
  "</s>",
  "<|end|>",
  "<|return|>",
  "<end_of_turn>",
  "<eos>",
  "<|end▁of▁sentence|>",
  "<｜end▁of▁sentence｜>",
]);

/** Any other special-looking token, e.g. <|im_start|>, <start_of_turn>, <｜Assistant｜>. */
const SPECIAL_TOKEN = /^(<\|[^<>|\s]+\|>|<｜[^<>\s]+｜>|<(start|end)_of_[a-z_]+>)$/;
/** Last word of the text (with the whitespace before it), for token healing. */
const WORD_TAIL = /\s*[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*$/u;

// ---------------------------------------------------------------------------
// Public API

/** True when a live choir can be built (OPENROUTER_API_KEY is set). */
export function liveAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** The default live choir (or CHORUS_MODELS). Empty when liveAvailable() is false. */
export function createLiveVoices(): Voice[] {
  if (!liveAvailable()) return [];
  return resolveChoir().map((entry) => createOpenRouterVoice(entry));
}

export interface OpenRouterVoiceOptions {
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** Backoff before the single retry when no Retry-After is given. */
  retryDelayMs?: number;
}

export function createOpenRouterVoice(entry: CatalogEntry, opts: OpenRouterVoiceOptions = {}): Voice {
  const client = new Client(entry, opts.timeoutMs ?? REQUEST_TIMEOUT_MS, opts.retryDelayMs ?? RETRY_DELAY_MS);
  return { info: toVoiceInfo(entry), next: (ctx) => client.next(ctx) };
}

// ---------------------------------------------------------------------------
// Wire types (subset of the documented Chat Completions response)

interface TopLogprob {
  token: string;
  logprob: number;
  bytes?: number[] | null;
}
interface TokenLogprob extends TopLogprob {
  top_logprobs?: TopLogprob[];
}
interface ApiError {
  code?: number | string;
  message?: string;
  metadata?: Record<string, unknown>;
}
interface ChatResponse {
  id?: string;
  model?: string;
  provider?: string;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; role?: string };
    logprobs?: { content?: TokenLogprob[] | null } | null;
    error?: ApiError;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: ApiError;
}

interface Usage {
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Candidate in probability space (internal). */
type Cand = { token: string; p: number };

/** One request's view, relative to a held-back suffix of the text. */
interface Partial1 {
  /** Continuations beyond the held-back text (held stripped). */
  list: Cand[];
  /** Mass on candidates equal to the held-back text exactly. */
  exact: number;
  /** Mass on all candidates consistent with the held-back text. */
  consistent: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

export function buildRequestBody(
  model: string,
  route: VoiceRoute,
  ctx: Pick<VoiceContext, "system" | "prompt">,
  prefill: string,
  maxTokens = 1,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (ctx.system) messages.push({ role: "system", content: ctx.system });
  messages.push({ role: "user", content: ctx.prompt });
  if (prefill) {
    messages.push(route.partial ? { role: "assistant", content: prefill, partial: true } : { role: "assistant", content: prefill });
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    logprobs: true,
    top_logprobs: route.topLogprobs ?? DEFAULT_TOP_LOGPROBS,
    temperature: 0,
    stream: false,
    provider:
      route.providers.length > 0
        ? { order: route.providers, allow_fallbacks: false, require_parameters: true }
        : { require_parameters: true },
  };
  if (route.reasoningOff) body.reasoning = { enabled: false };
  return body;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function validText(t: string): boolean {
  return !t.includes("�") && !LONE_SURROGATE.test(t) && !t.startsWith("bytes:") && !/^token:\d+$/.test(t);
}

/**
 * A candidate's text, or null when it is not valid standalone text. The token
 * string is authoritative; bytes only repair a string that is not valid text.
 */
export function candidateText(c: TopLogprob): string | null {
  const t = c.token ?? "";
  if (validText(t)) return t;
  if (Array.isArray(c.bytes) && c.bytes.length > 0 && c.bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    try {
      const s = utf8.decode(new Uint8Array(c.bytes));
      return validText(s) ? s : null;
    } catch {
      return null;
    }
  }
  return null;
}

export type Classified =
  | { kind: "text"; text: string }
  | { kind: "eos" }
  | { kind: "partial" }
  | { kind: "drop" };

export function classify(c: TopLogprob): Classified {
  const tok = c.token ?? "";
  if (END_TOKENS.has(tok) || tok === "") return { kind: "eos" };
  if (SPECIAL_TOKEN.test(tok)) return { kind: "drop" };
  const text = candidateText(c);
  if (text === null) return { kind: "partial" };
  if (text === "") return { kind: "eos" };
  return { kind: "text", text };
}

/** Merge duplicates (sum of probabilities), best first, as natural-log logprobs. */
export function finalize(list: Cand[]): { token: string; logprob: number }[] {
  const acc = new Map<string, number>();
  for (const { token, p } of list) {
    if (!(p > 0)) continue;
    acc.set(token, (acc.get(token) ?? 0) + p);
  }
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([token, p]) => ({ token, logprob: Math.log(Math.min(p, 1)) }));
}

/**
 * A provider that ignores the prefill answers from scratch, so its top
 * candidate is the answer's own first piece glued straight onto a word
 * ("...harm to someone or" -> "Yes"). Measured on StreamLake 2026-11-12 (4 of
 * 50 requests). Such a ballot would corrupt the text, so the voice sits out.
 */
export function looksLikeRestart(textSoFar: string, best: { token: string; logprob: number }): boolean {
  const t = best.token;
  if (textSoFar.length < 12 || t.length < 2 || t === EOS) return false;
  if (best.logprob < Math.log(0.5)) return false;
  if (!/^[\p{L}\p{N}]/u.test(t) || !/[\p{L}\p{N}]$/u.test(textSoFar)) return false;
  return textSoFar.startsWith(t);
}

/** Combine token-healing requests A (full text) and B (last word held back). */
export function combineHealing(a: Partial1, b: Partial1): Cand[] {
  if (!(b.consistent > 0)) return a.list;
  const z = b.consistent;
  const healed = [...b.list.map((c) => ({ token: c.token, p: c.p / z })), ...a.list.map((c) => ({ token: c.token, p: (c.p * b.exact) / z }))];
  // z is how much of B's probability agrees with the word the choir actually
  // wrote. When the voice would not have written that word, z is tiny and the
  // ratios above are noise from the tail of its top-k: live runs on 2026-11-12
  // produced "such asc" and "shouldn'thing" that way. Trust the healed view in
  // proportion to z and fall back to the plain continuation (A) for the rest.
  const trust = a.list.length === 0 ? 1 : Math.min(1, z / HEAL_FULL_TRUST);
  if (trust >= 1) return healed;
  return [...healed.map((c) => ({ token: c.token, p: c.p * trust })), ...a.list.map((c) => ({ token: c.token, p: c.p * (1 - trust) }))];
}

/** First character unit of a completion: up to and including its first non-ASCII code point. */
function firstUnit(s: string): string | null {
  const chars = Array.from(s);
  const i = chars.findIndex((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
  return i >= 0 ? chars.slice(0, i + 1).join("") : null;
}

// ---------------------------------------------------------------------------
// Client

type Attempt = { ok: true; json: ChatResponse } | { ok: false; error: Error; delayMs: number };

class Client {
  constructor(
    private readonly entry: CatalogEntry,
    private readonly timeoutMs: number,
    private readonly retryDelayMs: number,
  ) {}

  private get model() {
    return this.entry.id;
  }

  async next(ctx: VoiceContext): Promise<VoiceDistribution> {
    const usage: Usage = { latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const t0 = Date.now();
    const so = ctx.textSoFar;
    let list: Cand[];

    const tailWs = /\s+$/.exec(so)?.[0] ?? "";
    const heal = tailWs ? "" : (WORD_TAIL.exec(so)?.[0] ?? "");
    if (tailWs) {
      list = (await this.single(ctx, so.slice(0, -tailWs.length), tailWs, usage)).list;
      if (list.length === 0) list = (await this.single(ctx, so, "", usage)).list;
    } else if (heal) {
      const [a, b] = await Promise.allSettled([
        this.single(ctx, so, "", usage),
        this.single(ctx, so.slice(0, -heal.length), heal, usage),
      ]);
      if (ctx.signal.aborted) throw abortError(this.model, ctx.signal);
      if (a.status === "fulfilled" && b.status === "fulfilled") list = combineHealing(a.value, b.value);
      else if (a.status === "fulfilled") list = a.value.list;
      else if (b.status === "fulfilled" && b.value.list.length > 0) list = combineHealing({ list: [], exact: 0, consistent: 0 }, b.value);
      else throw a.reason;
    } else {
      list = (await this.single(ctx, so, "", usage)).list;
    }

    const top = finalize(list);
    if (top.length === 0) throw new Error(`${this.model}: no usable next-token candidates in the response`);
    if (looksLikeRestart(so, top[0])) {
      throw new Error(`${this.model}: ignored the answer so far and restarted it (top candidate ${JSON.stringify(top[0].token)}); sitting this step out`);
    }
    // Requests of a step may run in parallel: report wall time, not the sum.
    return { top, ...usage, latencyMs: Date.now() - t0 };
  }

  /** One request; candidates relative to `held` (text held back from the prefill). */
  private async single(ctx: VoiceContext, prefill: string, held: string, usage: Usage): Promise<Partial1> {
    const body = buildRequestBody(this.model, this.entry.route, ctx, prefill);
    let json = await this.post(body, ctx.signal, usage);
    let choice = json.choices?.[0];
    // Measured: DeepSeek on StreamLake / Novita now and then returns the token
    // without logprobs; the same request repeated returns them. Retry once.
    if (choice && !choice.logprobs?.content?.length && choice.message?.content) {
      json = await this.post(body, ctx.signal, usage);
      choice = json.choices?.[0];
    }
    if (!choice) throw new Error(`${this.model}: response has no choices${providerSuffix(json)}`);
    const entries = choice.logprobs?.content ?? null;
    const content = choice.message?.content ?? "";

    if (!entries || entries.length === 0) {
      if (choice.finish_reason === "stop" && !content) {
        // The model's (argmax) choice was the end token.
        return held ? { list: [], exact: 0, consistent: 0 } : { list: [{ token: EOS, p: 1 }], exact: 0, consistent: 1 };
      }
      if (choice.finish_reason === "length" && !content) {
        // The chosen token is not printable on its own (part of a character).
        const done = await this.completePartial(ctx, prefill, held, usage);
        return done === null ? { list: [], exact: 0, consistent: 0 } : { list: [{ token: done.text, p: done.p }], exact: 0, consistent: done.p };
      }
      throw new Error(`${this.model}: response has no logprobs (the provider ignored logprobs)${providerSuffix(json)}`);
    }
    const first = entries[0];
    const alts = first.top_logprobs ?? [];
    if (alts.length === 0) {
      throw new Error(`${this.model}: response has no top_logprobs (the provider ignored top_logprobs)${providerSuffix(json)}`);
    }
    const raw = alts.some((a) => a.token === first.token) ? alts : [...alts, first];

    const out: Partial1 = { list: [], exact: 0, consistent: 0 };
    let bestPartial = -1;
    let bestOther = -1;
    for (const a of raw) {
      const p = Math.exp(a.logprob);
      if (!Number.isFinite(p)) continue;
      const c = classify(a);
      if (c.kind === "drop") continue;
      if (c.kind === "partial") {
        bestPartial = Math.max(bestPartial, p);
        continue;
      }
      bestOther = Math.max(bestOther, p);
      if (c.kind === "eos") {
        if (!held) {
          out.list.push({ token: EOS, p });
          out.consistent += p;
        }
        continue;
      }
      if (!held) {
        out.list.push({ token: c.text, p });
        out.consistent += p;
      } else if (c.text === held) {
        out.exact += p;
        out.consistent += p;
      } else if (c.text.startsWith(held)) {
        out.list.push({ token: c.text.slice(held.length), p });
        out.consistent += p;
      }
    }
    if (bestPartial > bestOther) {
      const done = await this.completePartial(ctx, prefill, held, usage);
      if (done) {
        out.list.push({ token: done.text, p: bestPartial });
        out.consistent += bestPartial;
      }
    }
    return out;
  }

  /** Follow-up that completes a character split across tokens; text relative to `held`. */
  private async completePartial(
    ctx: VoiceContext,
    prefill: string,
    held: string,
    usage: Usage,
  ): Promise<{ text: string; p: number } | null> {
    let json: ChatResponse;
    try {
      json = await this.post(buildRequestBody(this.model, this.entry.route, ctx, prefill, FOLLOWUP_MAX_TOKENS), ctx.signal, usage);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      return null;
    }
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (!content) return null;
    // content may be left-trimmed; recover a leading space from the first token string.
    const lead = /^\s+/.exec(choice?.logprobs?.content?.[0]?.token ?? "")?.[0] ?? "";
    const unit = firstUnit(content.trimStart());
    if (unit === null) return null;
    let text = lead + unit;
    if (held) {
      if (!text.startsWith(held) || text === held) return null;
      text = text.slice(held.length);
    }
    const lp = choice?.logprobs?.content?.[0]?.logprob;
    return { text, p: typeof lp === "number" && Number.isFinite(lp) ? Math.exp(lp) : 1 };
  }

  /** POST with timeout, abort and one retry. Adds usage of successful attempts. */
  private async post(body: Record<string, unknown>, signal: AbortSignal, usage: Usage): Promise<ChatResponse> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error(`${this.model}: OPENROUTER_API_KEY is not set`);
    const first = await this.attempt(key, body, signal, usage);
    if (first.ok) return first.json;
    await sleep(first.delayMs, signal, this.model);
    const second = await this.attempt(key, body, signal, usage);
    if (second.ok) return second.json;
    throw second.error;
  }

  /**
   * One HTTP attempt. Resolves ok, or not-ok for retryable failures
   * (408/429/5xx, network error); throws for abort, timeout and other errors.
   */
  private async attempt(key: string, body: Record<string, unknown>, signal: AbortSignal, usage: Usage): Promise<Attempt> {
    if (signal.aborted) throw abortError(this.model, signal);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, this.timeoutMs);
    const onAbort = () => ctl.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    // Rejects as soon as our controller fires, even if fetch ignores the signal.
    const aborted = new Promise<never>((_, reject) => {
      ctl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    aborted.catch(() => {});

    const fail = (err: unknown): Attempt => {
      if (signal.aborted) throw abortError(this.model, signal);
      if (timedOut) throw new Error(`${this.model}: request timed out after ${this.timeoutMs} ms`);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: new Error(`${this.model}: network error: ${msg}`), delayMs: this.retryDelayMs };
    };

    try {
      let res: Response;
      let text: string;
      try {
        res = await Promise.race([
          fetch(OPENROUTER_CHAT_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctl.signal,
          }),
          aborted,
        ]);
        text = await Promise.race([res.text(), aborted]);
      } catch (err) {
        return fail(err);
      }

      let json: ChatResponse | null = null;
      try {
        json = text ? (JSON.parse(text) as ChatResponse) : null;
      } catch {
        json = null;
      }
      const err = json?.error ?? json?.choices?.[0]?.error;
      if (!res.ok || err) {
        const code = !res.ok ? res.status : Number(err?.code) || 500;
        const error = new Error(
          `${this.model}: OpenRouter HTTP ${code}: ${describeError(err, text)}${providerSuffix(json, err)}`,
        );
        if (code === 408 || code === 429 || code >= 500) {
          const ra = parseRetryAfter(res.headers?.get?.("retry-after") ?? null);
          return { ok: false, error, delayMs: Math.min(ra ?? this.retryDelayMs, MAX_RETRY_AFTER_MS) };
        }
        throw error;
      }
      if (!json) throw new Error(`${this.model}: OpenRouter HTTP ${res.status}: response body is not JSON`);
      this.addUsage(json, usage);
      return { ok: true, json };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private addUsage(json: ChatResponse, usage: Usage) {
    const u = json.usage ?? {};
    const inTok = Number(u.prompt_tokens) || 0;
    const outTok = Number(u.completion_tokens) || 0;
    usage.inputTokens += inTok;
    usage.outputTokens += outTok;
    if (typeof u.cost === "number" && Number.isFinite(u.cost)) {
      usage.costUsd += u.cost;
    } else if (this.entry.pricing) {
      usage.costUsd += (inTok * this.entry.pricing.inputPerM + outTok * this.entry.pricing.outputPerM) / 1e6;
    }
  }
}

function providerSuffix(json: ChatResponse | null, err?: ApiError): string {
  const meta = err?.metadata?.provider_name;
  const name = typeof meta === "string" ? meta : json?.provider;
  return name ? ` (provider: ${name})` : "";
}

function describeError(err: ApiError | undefined, rawText: string): string {
  let msg = err?.message ?? (rawText ? rawText.slice(0, 200) : "no response body");
  const raw = err?.metadata?.raw;
  if (typeof raw === "string" && raw && !msg.includes(raw)) msg += ` | ${raw.slice(0, 200)}`;
  return msg;
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

function abortError(model: string, signal: AbortSignal): Error {
  const e = new Error(`${model}: request aborted`, { cause: signal.reason });
  e.name = "AbortError";
  return e;
}

function sleep(ms: number, signal: AbortSignal, model: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(model, signal));
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(model, signal));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
