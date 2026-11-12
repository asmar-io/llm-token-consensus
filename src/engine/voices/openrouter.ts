/**
 * Live voices: one OpenRouter model = one Voice. Each `next()` asks the model
 * for exactly one next token with its top-20 logprobs, continuing the answer
 * the choir has written so far.
 *
 * ENDPOINT CHOICE (docs checked 2026-11-12)
 *   POST /api/v1/chat/completions with assistant prefill:
 *     messages = [system?, user: prompt, assistant: textSoFar]   (no assistant
 *     message on the first step), max_tokens 1, logprobs true, top_logprobs 20.
 *   - Prefill is a documented OpenRouter feature: "include a message with
 *     role: 'assistant' at the end of your messages array" and the model
 *     completes it. No extra flag is documented (the OpenAPI spec has no
 *     `continue_final_message` / `add_generation_prompt` parameter).
 *     https://openrouter.ai/docs/api_reference/overview.md#assistant-prefill
 *   - The legacy text completions endpoint (/api/v1/completions, `prompt`)
 *     is still listed in each model's `endpoints` array in /api/v1/models,
 *     but it is NOT in the current OpenAPI spec (https://openrouter.ai/openapi.json
 *     lists /chat/completions and no /completions). Using it would also mean
 *     reproducing every model's chat template by hand (Llama 3 headers,
 *     ChatML, Gemma turns, Mistral [INST], DeepSeek fullwidth-bar tokens);
 *     any template drift silently degrades the distribution. Chat + prefill
 *     lets the provider apply the right template. Trade-off: whether each
 *     provider really continues the final assistant message (rather than
 *     closing it and starting a new turn) cannot be confirmed without a key;
 *     scripts/live-smoke.mjs checks it per model.
 *
 * PROVIDER ROUTING
 *   A model's `supported_parameters` in the model list is a union over its
 *   providers; only some providers honour logprobs. We send
 *   provider.require_parameters = true ("the request won't even be routed to
 *   that provider", https://openrouter.ai/docs/guides/routing/provider-selection.md)
 *   and keep allow_fallbacks (default true) so OpenRouter can fall back among
 *   the remaining logprobs-capable providers. A response that still comes
 *   back without logprobs is rejected with a clear error, never turned into
 *   an empty distribution.
 *
 * WHITESPACE
 *   Chat templates / providers may trim trailing whitespace from the prefill
 *   ("Hello " -> "Hello"), which changes whether the next token should carry
 *   a leading space. We never send a prefill that ends in whitespace:
 *   textSoFar is split into head (trimEnd) + tail (trailing whitespace) and
 *   only head is sent. Candidates are continuations of head, so a candidate
 *   is kept only if it starts with tail, and tail is stripped from it
 *   (" world" with tail " " -> "world"). Candidates that do not start with
 *   tail contradict text already emitted and are dropped, as are candidates
 *   that are only (part of) the tail. If nothing survives, we retry once with
 *   the untrimmed prefill.
 *
 * END OF SEQUENCE
 *   - A candidate that is a known end token (<|eot_id|>, <|im_end|>, </s>,
 *     <|end|>, <|endoftext|>, <end_of_turn>, <eos>, DeepSeek's
 *     <｜end▁of▁sentence｜>, ...) or the empty string (providers that skip
 *     special tokens render the stop token as "") maps to EOS with its own
 *     logprob. Other special tokens (<|im_start|>, ...) are dropped.
 *   - finish_reason "stop" with empty content and NO logprob entries: the
 *     provider stopped without reporting the stop token; we return EOS as the
 *     only candidate with logprob 0 (its true probability is unknown).
 *   - Duplicates after mapping are merged by summing probabilities.
 *
 * PARTIAL UTF-8
 *   Logprob entries carry `bytes` (UTF-8 bytes of the token). A candidate
 *   whose bytes are not valid standalone UTF-8 (or, without bytes, whose
 *   token string contains U+FFFD, a lone surrogate or OpenAI's "bytes:\x.."
 *   form) cannot be appended and is dropped. If the voice's BEST candidate is
 *   such a partial character, we make one follow-up request (max_tokens 4,
 *   temperature 0), check that its first token is that same partial token,
 *   and concatenate token bytes until they decode; the decoded text becomes
 *   one candidate carrying the first token's logprob. If the follow-up fails
 *   or does not match, the partial candidate is just dropped.
 *
 * USAGE / COST
 *   OpenRouter returns usage on every non-streaming response, including
 *   `usage.cost` in credits (= USD)
 *   (https://openrouter.ai/docs/cookbook/administration/usage-accounting.md).
 *   costUsd uses usage.cost when present, else tokens x catalog pricing.
 *   Follow-up requests are added to the step's totals.
 *
 * ERRORS
 *   Per-request timeout (20 s), ctx.signal honoured, one retry on
 *   408/429/5xx or a network error with a short backoff (Retry-After honoured,
 *   capped at 2 s). Errors arrive either as an HTTP status or as a 200 body
 *   carrying `error` (https://openrouter.ai/docs/api_reference/errors-and-debugging.md).
 *   The API key is read only from process.env.OPENROUTER_API_KEY and is
 *   never logged or put in an error message.
 */
import { EOS, type VoiceInfo } from "@/lib/protocol";
import type { Voice, VoiceContext, VoiceDistribution } from "@/engine/voice";
import { resolveChoir } from "@/engine/voices/catalog";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const TOP_LOGPROBS = 20;
export const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 400;
const MAX_RETRY_AFTER_MS = 2_000;
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

// ---------------------------------------------------------------------------
// Public API

/** True when a live choir can be built (OPENROUTER_API_KEY is set). */
export function liveAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** The default live choir (or CHORUS_MODELS). Empty when liveAvailable() is false. */
export function createLiveVoices(): Voice[] {
  if (!liveAvailable()) return [];
  return resolveChoir().map((info) => createOpenRouterVoice(info));
}

export interface OpenRouterVoiceOptions {
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** Backoff before the single retry when no Retry-After is given. */
  retryDelayMs?: number;
}

export function createOpenRouterVoice(info: VoiceInfo, opts: OpenRouterVoiceOptions = {}): Voice {
  const client = new Client(info, opts.timeoutMs ?? REQUEST_TIMEOUT_MS, opts.retryDelayMs ?? RETRY_DELAY_MS);
  return { info, next: (ctx) => client.next(ctx) };
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
    native_finish_reason?: string | null;
    message?: { content?: string | null; role?: string; reasoning?: string | null };
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

type Cand = { token: string; logprob: number };

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Split "Hello world \n" into head "Hello world" and tail " \n". */
export function splitTrailingWhitespace(text: string): { head: string; tail: string } {
  const head = text.replace(/\s+$/u, "");
  return { head, tail: text.slice(head.length) };
}

export function buildRequestBody(
  model: string,
  ctx: Pick<VoiceContext, "system" | "prompt">,
  prefill: string,
  extra: { maxTokens?: number; temperature?: number } = {},
): Record<string, unknown> {
  const messages: { role: string; content: string }[] = [];
  if (ctx.system) messages.push({ role: "system", content: ctx.system });
  messages.push({ role: "user", content: ctx.prompt });
  if (prefill) messages.push({ role: "assistant", content: prefill });
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: extra.maxTokens ?? 1,
    logprobs: true,
    top_logprobs: TOP_LOGPROBS,
    stream: false,
    provider: { require_parameters: true, allow_fallbacks: true },
  };
  if (extra.temperature !== undefined) body.temperature = extra.temperature;
  return body;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A candidate's text, or null when it is not valid standalone UTF-8. */
export function candidateText(c: TopLogprob): string | null {
  if (Array.isArray(c.bytes) && c.bytes.length > 0) {
    try {
      return utf8.decode(new Uint8Array(c.bytes));
    } catch {
      return null;
    }
  }
  const t = c.token ?? "";
  if (t.startsWith("bytes:") || t.includes("�") || LONE_SURROGATE.test(t)) return null;
  return t;
}

type Classified =
  | { kind: "text"; text: string; logprob: number }
  | { kind: "eos"; logprob: number }
  | { kind: "partial"; logprob: number; raw: TopLogprob }
  | { kind: "drop"; logprob: number };

export function classify(c: TopLogprob, tail: string): Classified {
  const lp = c.logprob;
  const tok = c.token ?? "";
  if (END_TOKENS.has(tok) || tok === "") return { kind: "eos", logprob: lp };
  if (SPECIAL_TOKEN.test(tok)) return { kind: "drop", logprob: lp };
  const text = candidateText(c);
  if (text === null) return { kind: "partial", logprob: lp, raw: c };
  if (END_TOKENS.has(text) || text === "") return { kind: "eos", logprob: lp };
  const stripped = stripTail(text, tail);
  if (stripped === null) return { kind: "drop", logprob: lp };
  return { kind: "text", text: stripped, logprob: lp };
}

/** Remove the held-back whitespace from a continuation; null if inconsistent or empty. */
function stripTail(text: string, tail: string): string | null {
  if (!tail) return text;
  if (!text.startsWith(tail)) return null;
  const rest = text.slice(tail.length);
  return rest === "" ? null : rest;
}

function logSumExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/** Merge duplicate tokens (sum of probabilities) and sort best first. */
export function mergeCandidates(list: Cand[]): Cand[] {
  const acc = new Map<string, number>();
  for (const { token, logprob } of list) {
    if (typeof logprob !== "number" || Number.isNaN(logprob)) continue;
    acc.set(token, logSumExp(acc.get(token) ?? -Infinity, logprob));
  }
  return [...acc.entries()]
    .map(([token, logprob]) => ({ token, logprob }))
    .sort((x, y) => y.logprob - x.logprob);
}

function sameToken(a: TopLogprob, b: TopLogprob): boolean {
  if (Array.isArray(a.bytes) && Array.isArray(b.bytes)) {
    const bb = b.bytes;
    return a.bytes.length === bb.length && a.bytes.every((x, i) => x === bb[i]);
  }
  return a.token === b.token;
}

// ---------------------------------------------------------------------------
// Client

type Attempt = { ok: true; json: ChatResponse } | { ok: false; error: Error; delayMs: number };

class Client {
  constructor(
    private readonly info: VoiceInfo,
    private readonly timeoutMs: number,
    private readonly retryDelayMs: number,
  ) {}

  private get model() {
    return this.info.id;
  }

  async next(ctx: VoiceContext): Promise<VoiceDistribution> {
    const usage: Usage = { latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const { head, tail } = splitTrailingWhitespace(ctx.textSoFar);

    let top = await this.step(ctx, head, tail, usage);
    if (top.length === 0 && tail) {
      // Holding back the whitespace left nothing usable: send it verbatim once.
      top = await this.step(ctx, ctx.textSoFar, "", usage);
    }
    if (top.length === 0) {
      throw new Error(`${this.model}: no usable next-token candidates in the response`);
    }
    return { top, ...usage };
  }

  /** One main request (+ optional partial-UTF-8 follow-up). */
  private async step(ctx: VoiceContext, prefill: string, tail: string, usage: Usage): Promise<Cand[]> {
    const json = await this.post(buildRequestBody(this.model, ctx, prefill), ctx.signal, usage);
    const choice = json.choices?.[0];
    if (!choice) throw new Error(`${this.model}: response has no choices${providerSuffix(json)}`);

    const entries = choice.logprobs?.content ?? null;
    const content = choice.message?.content ?? "";
    if (!entries || entries.length === 0) {
      if (choice.finish_reason === "stop" && !content) return [{ token: EOS, logprob: 0 }];
      throw new Error(
        `${this.model}: response has no logprobs (the provider ignored logprobs/top_logprobs)${providerSuffix(json)}`,
      );
    }
    const first = entries[0];
    const alts = first.top_logprobs ?? [];
    if (alts.length === 0) {
      throw new Error(
        `${this.model}: response has no top_logprobs (the provider ignored top_logprobs)${providerSuffix(json)}`,
      );
    }
    // The sampled token may fall outside the top list; include it once.
    const raw = alts.some((a) => sameToken(a, first)) ? alts : [...alts, first];

    const classified = raw.map((c) => classify(c, tail));
    const out: Cand[] = [];
    for (const c of classified) {
      if (c.kind === "text") out.push({ token: c.text, logprob: c.logprob });
      else if (c.kind === "eos") out.push({ token: EOS, logprob: c.logprob });
    }

    const best = classified.filter((c) => c.kind !== "drop").sort((a, b) => b.logprob - a.logprob)[0];
    if (best?.kind === "partial") {
      const completed = await this.completePartial(ctx, prefill, tail, best.raw, usage);
      if (completed !== null) out.push({ token: completed, logprob: best.logprob });
    }
    return mergeCandidates(out);
  }

  /** Follow-up for a best candidate that is only part of a multi-byte character. */
  private async completePartial(
    ctx: VoiceContext,
    prefill: string,
    tail: string,
    partial: TopLogprob,
    usage: Usage,
  ): Promise<string | null> {
    let json: ChatResponse;
    try {
      const body = buildRequestBody(this.model, ctx, prefill, { maxTokens: FOLLOWUP_MAX_TOKENS, temperature: 0 });
      json = await this.post(body, ctx.signal, usage);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      return null; // best effort: the partial candidate is simply dropped
    }
    const choice = json.choices?.[0];
    const entries = choice?.logprobs?.content ?? [];
    let text: string | null = null;
    if (entries.length > 0 && entries.every((e) => Array.isArray(e.bytes))) {
      if (!sameToken(entries[0], partial)) return null;
      const bytes: number[] = [];
      for (const e of entries) {
        bytes.push(...(e.bytes as number[]));
        try {
          text = utf8.decode(new Uint8Array(bytes));
          break;
        } catch {
          /* incomplete: add the next token */
        }
      }
    } else if (choice?.message?.content) {
      // No bytes: take the content up to and including its first non-ASCII character.
      const chars = Array.from(choice.message.content);
      const i = chars.findIndex((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
      if (i >= 0) text = chars.slice(0, i + 1).join("");
    }
    if (text === null || text.includes("�")) return null;
    return stripTail(text, tail);
  }

  /** POST with timeout, abort and one retry. Adds usage of the successful attempt. */
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
    const started = Date.now();
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
      usage.latencyMs += Date.now() - started;
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
    } else if (this.info.pricing) {
      usage.costUsd += (inTok * this.info.pricing.inputPerM + outTok * this.info.pricing.outputPerM) / 1e6;
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
