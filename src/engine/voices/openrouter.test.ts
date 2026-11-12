import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EOS } from "@/lib/protocol";
import type { VoiceContext } from "@/engine/voice";
import {
  OPENROUTER_CHAT_URL,
  createLiveVoices,
  createOpenRouterVoice,
  liveAvailable,
} from "@/engine/voices/openrouter";
import {
  DEFAULT_CHOIR,
  KNOWN_MODELS,
  describeModel,
  labelFromSlug,
  resolveChoir,
  type CatalogEntry,
} from "@/engine/voices/catalog";

// ---------------------------------------------------------------------------
// Fixtures shaped like real responses captured on 2026-11-12 (chat
// completions, logprobs.content[0] = { token, logprob, bytes, top_logprobs }).

const enc = new TextEncoder();
type Alt = { token: string; logprob: number; bytes?: number[] | null };
const alt = (token: string, p: number, bytes?: number[] | null): Alt => ({
  token,
  logprob: Math.log(p),
  bytes: bytes === undefined ? Array.from(enc.encode(token)) : bytes,
});

function chat(opts: {
  alts?: Alt[];
  sampled?: Alt;
  content?: string | null;
  finish?: string;
  entries?: unknown[] | null;
  usage?: Record<string, unknown> | null;
  provider?: string;
}) {
  const alts = opts.alts ?? [];
  const sampled = opts.sampled ?? alts[0];
  const entries = opts.entries !== undefined ? opts.entries : sampled ? [{ ...sampled, top_logprobs: alts }] : [];
  const body: Record<string, unknown> = {
    id: "gen-1794489559-abc",
    provider: opts.provider ?? "StreamLake",
    model: "deepseek/deepseek-v4-pro-0813",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: opts.finish ?? "length",
        native_finish_reason: opts.finish ?? "length",
        // Providers left-trim content ("five" for the token " five").
        message: { role: "assistant", content: opts.content !== undefined ? opts.content : (sampled?.token.trimStart() ?? null) },
        logprobs: entries === null ? null : { content: entries, refusal: null },
      },
    ],
  };
  if (opts.usage !== null) {
    body.usage = opts.usage ?? { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21, cost: 0.00001518, is_byok: false };
  }
  return body;
}
const stopEmpty = () => chat({ finish: "stop", content: null, entries: null, usage: null });

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Body = {
  model: string;
  max_tokens: number;
  messages: { role: string; content: string; partial?: boolean }[];
  [k: string]: unknown;
};
let fetchMock: ReturnType<typeof vi.fn>;
/** Answer each request from its body. Return a Response or a JSON body. */
function serve(fn: (b: Body, call: number) => unknown) {
  let n = 0;
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const r = fn(JSON.parse(init.body as string) as Body, n++);
    return r instanceof Response ? r : jsonRes(r);
  });
}
const prefillOf = (b: Body) => {
  const last = b.messages[b.messages.length - 1];
  return last.role === "assistant" ? last.content : "";
};
const bodies = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string) as Body);

const DEEPSEEK = DEFAULT_CHOIR.find((m) => m.id.startsWith("deepseek/"))!;
const KIMI = DEFAULT_CHOIR.find((m) => m.id.startsWith("moonshotai/"))!;
const QWEN = DEFAULT_CHOIR.find((m) => m.id.startsWith("qwen/"))!;
const COUNT = "Count from one to ten in words, separated by spaces.";

function ctx(over: Partial<VoiceContext> = {}): VoiceContext {
  return {
    prompt: COUNT,
    textSoFar: "Answer:",
    stepIndex: 3,
    signal: new AbortController().signal,
    ...over,
  };
}
const voice = (entry: CatalogEntry = DEEPSEEK, opts = {}) => createOpenRouterVoice(entry, { retryDelayMs: 1, ...opts });
const probs = (top: { token: string; logprob: number }[]) => Object.fromEntries(top.map((t) => [t.token, Math.exp(t.logprob)]));

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-test-key";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.CHORUS_MODELS;
});

// ---------------------------------------------------------------------------

describe("request shape", () => {
  it("pins the verified providers, asks for one token, top logprobs, temperature 0, reasoning off", async () => {
    serve(() => chat({ alts: [alt(" one", 0.9)] }));
    await voice().next(ctx({ system: "Be brief." }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENROUTER_CHAT_URL);
    expect(init.headers.Authorization).toBe("Bearer sk-or-test-key");
    const b = bodies()[0];
    expect(b).toMatchObject({
      model: "deepseek/deepseek-v4-pro-0813",
      max_tokens: 1,
      logprobs: true,
      top_logprobs: 20,
      temperature: 0,
      stream: false,
      reasoning: { enabled: false },
      provider: { order: ["novita/fp8"], allow_fallbacks: false, require_parameters: true },
    });
    expect(b.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: COUNT },
      { role: "assistant", content: "Answer:" },
    ]);
  });

  it("marks the prefill partial for Moonshot / Alibaba routes and caps top_logprobs for Alibaba", async () => {
    serve(() => chat({ alts: [alt(" one", 0.9)] }));
    await voice(KIMI).next(ctx());
    await voice(QWEN).next(ctx());
    const [k, q] = bodies();
    expect(k.messages.at(-1)).toEqual({ role: "assistant", content: "Answer:", partial: true });
    expect(k.provider).toEqual({ order: ["moonshotai"], allow_fallbacks: false, require_parameters: true });
    expect(q.top_logprobs).toBe(5);
    expect(q.provider).toEqual({ order: ["alibaba"], allow_fallbacks: false, require_parameters: true });
  });

  it("sends no assistant message on the first step", async () => {
    serve(() => chat({ alts: [alt("one", 0.95), alt("One", 0.05)] }));
    const d = await voice().next(ctx({ textSoFar: "", stepIndex: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies()[0].messages).toEqual([{ role: "user", content: COUNT }]);
    expect(d.top[0].token).toBe("one");
  });

  it("leaves routing to OpenRouter (require_parameters only) for unknown models", async () => {
    serve(() => chat({ alts: [alt(" one", 0.9)] }));
    await voice(describeModel("acme/thing-7b")).next(ctx());
    const b = bodies()[0];
    expect(b.provider).toEqual({ require_parameters: true });
    expect(b.reasoning).toBeUndefined();
  });
});

describe("parsing", () => {
  it("returns exact strings, natural-log probabilities, best first, duplicates merged, sampled token added", async () => {
    serve(() =>
      chat({
        alts: [alt(" one", 0.6), alt(" One", 0.2), alt(" one", 0.05, null), alt(" 1", 0.1)],
        sampled: alt(" uno", 0.01),
      }),
    );
    const d = await voice().next(ctx());
    expect(d.top.map((t) => t.token)).toEqual([" one", " One", " 1", " uno"]);
    expect(Math.exp(d.top[0].logprob)).toBeCloseTo(0.65, 10);
    expect(d.inputTokens).toBe(20);
    expect(d.outputTokens).toBe(1);
  });

  it("treats the token string as authoritative when bytes are wrong (measured on Novita)", async () => {
    serve(() => chat({ alts: [alt(" بار", 0.99, [32, 40, 39, 49]), alt(" مدينة", 0.01)] }));
    const d = await voice().next(ctx({ textSoFar: "عاصمة فرنسا:" }));
    expect(d.top.map((t) => t.token)).toEqual([" بار", " مدينة"]);
  });

  it("rejects a response without logprobs after one retry (provider ignored the parameter)", async () => {
    serve(() => chat({ content: "one", entries: null, provider: "SomeHost" }));
    await expect(voice().next(ctx())).rejects.toThrow(
      /deepseek\/deepseek-v4-pro-0813: response has no logprobs.*provider: SomeHost/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once when a provider drops logprobs on a single response (measured on StreamLake)", async () => {
    serve((_b, n) => (n === 0 ? chat({ content: "five", entries: null }) : chat({ alts: [alt(" five", 1)] })));
    const d = await voice().next(ctx());
    expect(d.top).toEqual([{ token: " five", logprob: 0 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a response with logprobs but empty top_logprobs", async () => {
    serve(() => chat({ entries: [{ ...alt(" one", 1), top_logprobs: [] }] }));
    await expect(voice().next(ctx())).rejects.toThrow(/no top_logprobs/);
  });
});

describe("token healing (text ending mid-word)", () => {
  it("whole word: B's mass on the held word scales A", async () => {
    serve((b) =>
      prefillOf(b) === "one two three four"
        ? chat({ alts: [alt(" five", 0.99), alt("<｜end▁of▁sentence｜>", 0.01)] })
        : chat({ alts: [alt(" four", 0.98), alt(" fourteen", 0.01), alt(" 4", 0.01)] }),
    );
    const d = await voice().next(ctx({ textSoFar: "one two three four" }));
    expect(bodies().map(prefillOf).sort()).toEqual(["one two three", "one two three four"]);
    const p = probs(d.top);
    const z = 0.99;
    expect(d.top[0].token).toBe(" five");
    expect(p[" five"]).toBeCloseTo((0.99 * 0.98) / z, 10);
    expect(p[EOS]).toBeCloseTo((0.01 * 0.98) / z, 10);
    expect(p["teen"]).toBeCloseTo(0.01 / z, 10);
    expect(p[" 4"]).toBeUndefined();
  });

  it("mid-word: 'Par' becomes 'is' even though A alone says 'ís'", async () => {
    serve((b) =>
      prefillOf(b) === "The capital of France is Par"
        ? chat({ alts: [alt("ís", 0.91), alt("ist", 0.09)] })
        : chat({ alts: [alt(" Paris", 0.97), alt(" Par", 0.01), alt(" the", 0.02)] }),
    );
    const d = await voice().next(ctx({ prompt: "Capital of France?", textSoFar: "The capital of France is Par" }));
    expect(d.top[0].token).toBe("is");
    const p = probs(d.top);
    expect(p["is"]).toBeCloseTo(0.97 / 0.98, 10);
    expect(p["ís"]).toBeCloseTo((0.91 * 0.01) / 0.98, 10);
  });

  it("finished answer: A stops (empty, no logprobs) and becomes EOS", async () => {
    serve((b) => (prefillOf(b).endsWith("ten") ? stopEmpty() : chat({ alts: [alt(" ten", 1)] })));
    const d = await voice().next(ctx({ textSoFar: "one two three four five six seven eight nine ten" }));
    expect(d.top).toEqual([{ token: EOS, logprob: 0 }]);
  });

  it("uses A alone when B fails, and B alone when A fails", async () => {
    serve((b) =>
      prefillOf(b) === "one two three four"
        ? chat({ alts: [alt(" five", 1)] })
        : jsonRes({ error: { code: 502, message: "Provider returned error" } }, 502),
    );
    expect((await voice().next(ctx({ textSoFar: "one two three four" }))).top[0].token).toBe(" five");

    fetchMock.mockReset();
    serve((b) =>
      prefillOf(b) === "one two three four"
        ? jsonRes({ error: { code: 400, message: "bad" } }, 400)
        : chat({ alts: [alt(" fourteen", 0.3), alt(" four", 0.7)] }),
    );
    // The mass on "the word is finished" (" four") is lost without A.
    expect((await voice().next(ctx({ textSoFar: "one two three four" }))).top).toEqual([
      { token: "teen", logprob: Math.log(0.3) },
    ]);
  });
});

describe("whitespace", () => {
  it("never sends a prefill ending in whitespace and strips the held-back space from candidates", async () => {
    serve(() => chat({ alts: [alt(" five", 0.9), alt(",", 0.05), alt(" ", 0.03), alt(" Five", 0.02)] }));
    const d = await voice().next(ctx({ textSoFar: "one two three four " }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prefillOf(bodies()[0])).toBe("one two three four");
    expect(d.top.map((t) => t.token)).toEqual(["five", "Five"]);
  });

  it("handles held-back newlines and falls back to the untrimmed text when nothing matches", async () => {
    serve((b) => (prefillOf(b) === "Title" ? chat({ alts: [alt(":", 0.9), alt("!", 0.1)] }) : chat({ alts: [alt("Body", 1)] })));
    const d = await voice().next(ctx({ textSoFar: "Title\n\n" }));
    expect(bodies().map(prefillOf)).toEqual(["Title", "Title\n\n"]);
    expect(d.top).toEqual([{ token: "Body", logprob: 0 }]);
  });
});

describe("end of sequence", () => {
  it("maps an empty stop response to EOS", async () => {
    serve(() => stopEmpty());
    const d = await voice().next(ctx({ textSoFar: "The capital of France is Paris." }));
    expect(d.top).toEqual([{ token: EOS, logprob: 0 }]);
  });

  it("maps end tokens and the empty string to EOS, merges them, drops other specials", async () => {
    serve(() =>
      chat({
        alts: [
          alt("<｜end▁of▁sentence｜>", 0.5),
          alt(" It", 0.2),
          alt("<|im_end|>", 0.1),
          alt("", 0.05, []),
          alt("</s>", 0.05),
          alt("<|im_start|>", 0.05),
          alt("<end_of_turn>", 0.05),
        ],
      }),
    );
    const d = await voice().next(ctx({ textSoFar: "Paris." }));
    expect(d.top.map((t) => t.token)).toEqual([EOS, " It"]);
    expect(Math.exp(d.top[0].logprob)).toBeCloseTo(0.75, 10);
  });
});

describe("partial UTF-8", () => {
  it("drops candidates that are not valid text when a valid one is best", async () => {
    serve(() => chat({ alts: [alt(" hi", 0.6), alt("token:3574", 0.2), alt("�", 0.1, [239, 191, 189]), alt("bytes:\\xe5", 0.1, null)] }));
    const d = await voice().next(ctx());
    expect(d.top).toEqual([{ token: " hi", logprob: Math.log(0.6) }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("completes a best partial candidate from a max_tokens 4 follow-up", async () => {
    serve((b) =>
      b.max_tokens === 1
        ? chat({ alts: [alt("token:3574", 0.8), alt(" hi", 0.2)] })
        : chat({ entries: [{ ...alt("token:3574", 0.8), top_logprobs: [] }], content: "🦩", finish: "stop" }),
    );
    const d = await voice().next(ctx());
    expect(bodies()[1]).toMatchObject({ max_tokens: 4, temperature: 0 });
    expect(d.top.map((t) => t.token)).toEqual(["🦩", " hi"]);
    expect(Math.exp(d.top[0].logprob)).toBeCloseTo(0.8, 10);
  });

  it("follows up when the provider returns no logprobs because the token is part of a character", async () => {
    serve((b) =>
      b.max_tokens === 1
        ? chat({ finish: "length", content: null, entries: null })
        : chat({ entries: [{ ...alt("�", 0.97, [239, 191, 189]), top_logprobs: [] }], content: "🦩", finish: "stop" }),
    );
    const d = await voice().next(ctx({ textSoFar: "" }));
    expect(d.top[0].token).toBe("🦩");
    expect(Math.exp(d.top[0].logprob)).toBeCloseTo(0.97, 10);
  });

  it("fails cleanly when the follow-up has no content (measured on Kimi)", async () => {
    serve(() => chat({ finish: "length", content: null, entries: null }));
    await expect(voice(KIMI).next(ctx({ textSoFar: "" }))).rejects.toThrow(/no usable next-token candidates/);
  });
});

describe("cost and usage", () => {
  it("sums usage.cost over all requests of a step", async () => {
    serve((b) =>
      prefillOf(b) === "one two three four"
        ? chat({ alts: [alt(" five", 1)], usage: { prompt_tokens: 20, completion_tokens: 1, cost: 0.00002 } })
        : chat({ alts: [alt(" four", 1)], usage: { prompt_tokens: 19, completion_tokens: 1, cost: 0.00001 } }),
    );
    const d = await voice().next(ctx({ textSoFar: "one two three four" }));
    expect(d.costUsd).toBeCloseTo(0.00003, 12);
    expect(d.inputTokens).toBe(39);
    expect(d.outputTokens).toBe(2);
  });

  it("falls back to tokens x catalog pricing, and 0 for unknown models", async () => {
    serve(() => chat({ alts: [alt(" one", 1)], usage: { prompt_tokens: 1000, completion_tokens: 1 } }));
    const d = await voice().next(ctx());
    expect(d.costUsd).toBeCloseTo((1000 * 0.66 + 1 * 1.98) / 1e6, 15);
    const u = await voice(describeModel("acme/thing-7b")).next(ctx());
    expect(u.costUsd).toBe(0);
  });
});

describe("errors, timeout, abort, retry", () => {
  it("retries once on 429 and succeeds", async () => {
    serve((_b, n) =>
      n === 0 ? jsonRes({ error: { code: 429, message: "Rate limit exceeded" } }, 429, { "retry-after": "0" }) : chat({ alts: [alt(" one", 1)] }),
    );
    const d = await voice().next(ctx());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(d.top[0].token).toBe(" one");
  });

  it("gives up after one retry with a clear error naming model, status and provider", async () => {
    serve(() =>
      jsonRes({ error: { code: 502, message: "Provider returned error", metadata: { provider_name: "StreamLake", raw: "upstream exploded" } } }, 502),
    );
    await expect(voice().next(ctx())).rejects.toThrow(
      "deepseek/deepseek-v4-pro-0813: OpenRouter HTTP 502: Provider returned error | upstream exploded (provider: StreamLake)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx (e.g. pinned provider unavailable) and never leaks the key", async () => {
    serve(() => jsonRes({ error: { code: 404, message: "No endpoints found for deepseek/deepseek-v4-pro-0813." } }, 404));
    const p = voice().next(ctx());
    await expect(p).rejects.toThrow(/HTTP 404: No endpoints found/);
    await p.catch((e: Error) => expect(e.message).not.toContain("sk-or-test-key"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a 200 body carrying an error as an error", async () => {
    serve(() => ({ error: { code: 503, message: "No allowed providers are available for the selected model." } }));
    await expect(voice().next(ctx())).rejects.toThrow(/HTTP 503: No allowed providers/);
  });

  it("times out instead of hanging", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await expect(voice(DEEPSEEK, { timeoutMs: 30 }).next(ctx())).rejects.toThrow(
      /deepseek\/deepseek-v4-pro-0813: request timed out after 30 ms/,
    );
  });

  it("rejects promptly when ctx.signal aborts mid-request (also with two requests in flight)", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const ac = new AbortController();
    const p = voice().next(ctx({ signal: ac.signal, textSoFar: "one two three four" }));
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately when already aborted, without calling fetch", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(voice().next(ctx({ signal: ac.signal }))).rejects.toThrow(/aborted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries once on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(jsonRes(chat({ alts: [alt(" one", 1)] })));
    const d = await voice().next(ctx());
    expect(d.top[0].token).toBe(" one");
  });
});

describe("choir", () => {
  it("is empty without a key", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(liveAvailable()).toBe(false);
    expect(createLiveVoices()).toEqual([]);
  });

  it("builds the default choir with public VoiceInfo only (routes stay server side)", () => {
    const voices = createLiveVoices();
    expect(voices.map((v) => v.info.id)).toEqual(DEFAULT_CHOIR.map((m) => m.id));
    for (const v of voices) {
      expect(v.info.simulated).toBe(false);
      expect(v.info.pricing).toBeDefined();
      expect(v.info).not.toHaveProperty("route");
    }
    expect(new Set(DEFAULT_CHOIR.map((m) => m.lab)).size).toBe(DEFAULT_CHOIR.length);
    expect(DEFAULT_CHOIR.every((m) => m.verified && m.route.providers.length > 0)).toBe(true);
  });

  it("honours CHORUS_MODELS with optional @provider pins and unknown slugs", () => {
    process.env.CHORUS_MODELS =
      " qwen/qwen3.5-397b-a17b, acme/super-model-7b-instruct@some-host ,qwen/qwen3.5-397b-a17b, moonshotai/kimi-k2.6@other";
    const entries = resolveChoir();
    expect(entries.map((e) => e.id)).toEqual(["qwen/qwen3.5-397b-a17b", "acme/super-model-7b-instruct", "moonshotai/kimi-k2.6"]);
    expect(entries[0].route).toMatchObject({ providers: ["alibaba"], partial: true, topLogprobs: 5 });
    expect(entries[1]).toMatchObject({ label: "Super Model 7b Instruct", lab: "Unknown", origin: "Unknown", route: { providers: ["some-host"] } });
    expect(entries[1].pricing).toBeUndefined();
    expect(entries[2].route.providers).toEqual(["other"]);
    // the catalog itself is not mutated by an override
    expect(KNOWN_MODELS.find((m) => m.id === "moonshotai/kimi-k2.6")!.route.providers).toEqual(["moonshotai"]);
  });

  it("derives labels from slugs", () => {
    expect(labelFromSlug("meta-llama/llama-3.3-70b-instruct")).toBe("Llama 3.3 70b Instruct");
    expect(resolveChoir("")).toHaveLength(DEFAULT_CHOIR.length);
  });
});

describe("looksLikeRestart", async () => {
  const { looksLikeRestart } = await import("@/engine/voices/openrouter");
  const so = "Yes, it can be right to break a promise when keeping it would cause harm to someone or";
  it("flags the answer's own first piece glued onto a word", () => {
    expect(looksLikeRestart(so, { token: "Yes", logprob: 0 })).toBe(true);
  });
  it("does not flag real continuations, weak candidates, short texts or word completions", () => {
    expect(looksLikeRestart(so, { token: " violate", logprob: 0 })).toBe(false);
    expect(looksLikeRestart(so, { token: "Yes", logprob: Math.log(0.2) })).toBe(false);
    expect(looksLikeRestart("Yes", { token: "Yes", logprob: 0 })).toBe(false);
    expect(looksLikeRestart("Decisions about speech are Dec", { token: "isions", logprob: 0 })).toBe(false);
    expect(looksLikeRestart("Yes, it can be right.\n\n", { token: "Yes", logprob: 0 })).toBe(false);
  });
});
