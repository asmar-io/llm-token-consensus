import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EOS } from "@/lib/protocol";
import type { VoiceContext } from "@/engine/voice";
import {
  OPENROUTER_CHAT_URL,
  createLiveVoices,
  createOpenRouterVoice,
  liveAvailable,
  splitTrailingWhitespace,
} from "@/engine/voices/openrouter";
import { DEFAULT_CHOIR, describeModel, labelFromSlug, resolveChoir } from "@/engine/voices/catalog";

// ---------------------------------------------------------------------------
// Fixtures shaped like the documented Chat Completions response
// (https://openrouter.ai/docs/api_reference/overview.md, ChatTokenLogprob in
// https://openrouter.ai/openapi.json: { token, logprob, bytes, top_logprobs }).

const enc = new TextEncoder();
type Alt = { token: string; logprob: number; bytes?: number[] | null };
const alt = (token: string, logprob: number, bytes?: number[] | null): Alt => ({
  token,
  logprob,
  bytes: bytes === undefined ? Array.from(enc.encode(token)) : bytes,
});

function chatResponse(opts: {
  alts?: Alt[];
  sampled?: Alt;
  content?: string;
  finish?: string;
  entries?: unknown[] | null;
  usage?: Record<string, unknown>;
  provider?: string;
}) {
  const alts = opts.alts ?? [];
  const sampled = opts.sampled ?? alts[0];
  const entries =
    opts.entries !== undefined ? opts.entries : sampled ? [{ ...sampled, top_logprobs: alts }] : [];
  return {
    id: "gen-1762950000-abc",
    provider: opts.provider ?? "Parasail",
    model: "meta-llama/llama-3.3-70b-instruct",
    object: "chat.completion",
    created: 1762950000,
    choices: [
      {
        index: 0,
        finish_reason: opts.finish ?? "length",
        native_finish_reason: opts.finish ?? "length",
        message: { role: "assistant", content: opts.content ?? sampled?.token ?? "" },
        logprobs: entries === null ? null : { content: entries, refusal: null },
      },
    ],
    usage: opts.usage ?? {
      prompt_tokens: 42,
      completion_tokens: 1,
      total_tokens: 43,
      cost: 0.0000312,
      is_byok: false,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const REALISTIC = chatResponse({
  alts: [
    alt(" Paris", -0.0312),
    alt(" the", -3.9),
    alt(" a", -5.2),
    alt(" located", -6.1),
    alt(" Paris", -9.0, null), // duplicate surface form (different token id)
    alt(" known", -7.3),
  ],
});

const info = DEFAULT_CHOIR[0];
let fetchMock: ReturnType<typeof vi.fn>;

function ctx(over: Partial<VoiceContext> = {}): VoiceContext {
  return {
    prompt: "What is the capital of France?",
    textSoFar: "The capital of France is",
    stepIndex: 5,
    signal: new AbortController().signal,
    ...over,
  };
}
const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body as string);

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-test-key";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.CHORUS_MODELS;
});

// ---------------------------------------------------------------------------

describe("request shape", () => {
  it("asks for one token with top 20 logprobs, provider routing, and the prefill", async () => {
    fetchMock.mockResolvedValue(jsonRes(REALISTIC));
    await createOpenRouterVoice(info).next(ctx({ system: "Be brief." }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENROUTER_CHAT_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-or-test-key");
    const body = bodyOf(0);
    expect(body).toMatchObject({
      model: info.id,
      max_tokens: 1,
      logprobs: true,
      top_logprobs: 20,
      stream: false,
      provider: { require_parameters: true, allow_fallbacks: true },
    });
    expect(body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "What is the capital of France?" },
      { role: "assistant", content: "The capital of France is" },
    ]);
  });

  it("sends no assistant message on the first step", async () => {
    fetchMock.mockResolvedValue(jsonRes(chatResponse({ alts: [alt("The", -0.1)] })));
    await createOpenRouterVoice(info).next(ctx({ textSoFar: "", stepIndex: 0 }));
    expect(bodyOf(0).messages).toEqual([{ role: "user", content: "What is the capital of France?" }]);
  });
});

describe("parsing", () => {
  it("parses a realistic response: exact strings, natural-log logprobs, best first, duplicates merged", async () => {
    fetchMock.mockResolvedValue(jsonRes(REALISTIC));
    const d = await createOpenRouterVoice(info).next(ctx());
    expect(d.top.map((t) => t.token)).toEqual([" Paris", " the", " a", " located", " known"]);
    const paris = d.top[0].logprob;
    expect(Math.exp(paris)).toBeCloseTo(Math.exp(-0.0312) + Math.exp(-9.0), 10);
    expect(d.top[1].logprob).toBe(-3.9);
    expect(d.inputTokens).toBe(42);
    expect(d.outputTokens).toBe(1);
    expect(d.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("includes the sampled token when it is outside the top list", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(chatResponse({ alts: [alt(" Paris", -0.1), alt(" the", -2.5)], sampled: alt(" Lyon", -8) })),
    );
    const d = await createOpenRouterVoice(info).next(ctx());
    expect(d.top.map((t) => t.token)).toEqual([" Paris", " the", " Lyon"]);
  });

  it("rejects a response without logprobs (provider ignored the parameter)", async () => {
    fetchMock.mockResolvedValue(jsonRes(chatResponse({ content: " Paris", entries: null, provider: "SomeHost" })));
    await expect(createOpenRouterVoice(info).next(ctx())).rejects.toThrow(
      /meta-llama\/llama-3\.3-70b-instruct: response has no logprobs.*SomeHost/,
    );
  });

  it("rejects a response with logprobs but empty top_logprobs", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(chatResponse({ entries: [{ ...alt(" Paris", -0.1), top_logprobs: [] }], content: " Paris" })),
    );
    await expect(createOpenRouterVoice(info).next(ctx())).rejects.toThrow(/no top_logprobs/);
  });
});

describe("end of sequence", () => {
  it("maps finish_reason stop with empty content and no entries to EOS", async () => {
    fetchMock.mockResolvedValue(jsonRes(chatResponse({ finish: "stop", content: "", entries: [] })));
    const d = await createOpenRouterVoice(info).next(ctx({ textSoFar: "Paris." }));
    expect(d.top).toEqual([{ token: EOS, logprob: 0 }]);
  });

  it("maps an empty-string stop token (finish stop) to EOS with its logprob", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(
        chatResponse({
          finish: "stop",
          content: "",
          alts: [alt("", -0.2, []), alt(" It", -2.1)],
        }),
      ),
    );
    const d = await createOpenRouterVoice(info).next(ctx({ textSoFar: "Paris." }));
    expect(d.top).toEqual([
      { token: EOS, logprob: -0.2 },
      { token: " It", logprob: -2.1 },
    ]);
  });

  it("maps special end tokens to EOS and merges them (sum of probabilities)", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(
        chatResponse({
          alts: [
            alt("<|eot_id|>", -0.7),
            alt(" It", -1.5),
            alt("<|end_of_text|>", -3.0),
            alt("</s>", -4.0),
            alt("<|im_start|>", -5.0), // other special token: dropped
            alt("<end_of_turn>", -6.0),
          ],
        }),
      ),
    );
    const d = await createOpenRouterVoice(info).next(ctx({ textSoFar: "Paris." }));
    expect(d.top.map((t) => t.token)).toEqual([EOS, " It"]);
    const p = Math.exp(-0.7) + Math.exp(-3) + Math.exp(-4) + Math.exp(-6);
    expect(Math.exp(d.top[0].logprob)).toBeCloseTo(p, 10);
  });

  it("recognises DeepSeek fullwidth-bar end token", async () => {
    fetchMock.mockResolvedValue(jsonRes(chatResponse({ alts: [alt("<｜end▁of▁sentence｜>", -0.1), alt("\n", -3)] })));
    const d = await createOpenRouterVoice(info).next(ctx({ textSoFar: "Paris." }));
    expect(d.top[0]).toEqual({ token: EOS, logprob: -0.1 });
  });
});

describe("partial UTF-8", () => {
  // "مر" : م = d9 85, ر = d8 b1. Byte-level tokenisers can split a character.
  const meemHead = alt("�", -0.4, [0xd9]); // first byte of م only
  const meemTail = { token: "�", logprob: -0.01, bytes: [0x85], top_logprobs: [] };

  it("drops partial candidates that are not the best", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(chatResponse({ alts: [alt(" hello", -0.2), alt("�", -2, [0xf0, 0x9f]), alt("bytes:\\xe5", -3, null)] })),
    );
    const d = await createOpenRouterVoice(info).next(ctx());
    expect(d.top).toEqual([{ token: " hello", logprob: -0.2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("completes a best partial candidate with one follow-up request", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(chatResponse({ alts: [meemHead, alt("ر", -1.5)], usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.001 } })),
      )
      .mockResolvedValueOnce(
        jsonRes(
          chatResponse({
            entries: [{ ...meemHead, top_logprobs: [] }, meemTail, { ...alt("ر", -0.3), top_logprobs: [] }],
            content: "مر",
            usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.002 },
          }),
        ),
      );
    const d = await createOpenRouterVoice(info).next(ctx({ textSoFar: "كلمة" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const follow = bodyOf(1);
    expect(follow.max_tokens).toBe(4);
    expect(follow.temperature).toBe(0);
    expect(d.top).toEqual([
      { token: "م", logprob: -0.4 },
      { token: "ر", logprob: -1.5 },
    ]);
    expect(d.inputTokens).toBe(20);
    expect(d.outputTokens).toBe(4);
    expect(d.costUsd).toBeCloseTo(0.003, 12);
  });

  it("drops the partial candidate when the follow-up starts differently", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(chatResponse({ alts: [meemHead, alt("ر", -1.5)] })))
      .mockResolvedValueOnce(jsonRes(chatResponse({ entries: [{ ...alt("ر", -0.3), top_logprobs: [] }], content: "ر" })));
    const d = await createOpenRouterVoice(info).next(ctx({ textSoFar: "كلمة" }));
    expect(d.top).toEqual([{ token: "ر", logprob: -1.5 }]);
  });
});

describe("whitespace", () => {
  it("splits trailing whitespace", () => {
    expect(splitTrailingWhitespace("Hello world \n")).toEqual({ head: "Hello world", tail: " \n" });
    expect(splitTrailingWhitespace("Hi")).toEqual({ head: "Hi", tail: "" });
    expect(splitTrailingWhitespace("  ")).toEqual({ head: "", tail: "  " });
  });

  it("never sends a prefill ending in whitespace and re-attaches it to candidates", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(chatResponse({ alts: [alt(" Paris", -0.1), alt(",", -2), alt(" the", -3), alt(" ", -4)] })),
    );
    const d = await createOpenRouterVoice(info).next(ctx({ textSoFar: "The capital of France is " }));
    expect(bodyOf(0).messages.at(-1)).toEqual({ role: "assistant", content: "The capital of France is" });
    // " Paris" -> "Paris" (space already emitted); "," contradicts the emitted space; " " alone is dropped.
    expect(d.top.map((t) => t.token)).toEqual(["Paris", "the"]);
  });

  it("handles held-back newlines", async () => {
    fetchMock.mockResolvedValue(jsonRes(chatResponse({ alts: [alt("\n\n", -0.5), alt("\n\nThe", -1), alt("\n", -2)] })));
    const d = await createOpenRouterVoice(info).next(ctx({ textSoFar: "Title\n" }));
    expect(bodyOf(0).messages.at(-1).content).toBe("Title");
    expect(d.top).toEqual([
      { token: "\n", logprob: -0.5 },
      { token: "\nThe", logprob: -1 },
    ]);
  });

  it("falls back to the untrimmed prefill when no candidate matches the held-back whitespace", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(chatResponse({ alts: [alt(",", -0.1), alt(".", -1)] })))
      .mockResolvedValueOnce(jsonRes(chatResponse({ alts: [alt("Paris", -0.2)] })));
    const d = await createOpenRouterVoice(info).next(ctx({ textSoFar: "It is " }));
    expect(bodyOf(1).messages.at(-1).content).toBe("It is ");
    expect(d.top).toEqual([{ token: "Paris", logprob: -0.2 }]);
  });
});

describe("cost", () => {
  it("uses usage.cost when the response carries it", async () => {
    fetchMock.mockResolvedValue(jsonRes(REALISTIC));
    const d = await createOpenRouterVoice(info).next(ctx());
    expect(d.costUsd).toBe(0.0000312);
  });

  it("falls back to tokens x catalog pricing", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(chatResponse({ alts: [alt(" Paris", -0.1)], usage: { prompt_tokens: 1000, completion_tokens: 1 } })),
    );
    const voice = createOpenRouterVoice({ ...info, pricing: { inputPerM: 0.5, outputPerM: 2 } });
    const d = await voice.next(ctx());
    expect(d.costUsd).toBeCloseTo((1000 * 0.5 + 1 * 2) / 1e6, 15);
  });

  it("is 0 for unknown models without usage.cost", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(chatResponse({ alts: [alt(" Paris", -0.1)], usage: { prompt_tokens: 1000, completion_tokens: 1 } })),
    );
    const d = await createOpenRouterVoice(describeModel("acme/unknown-7b")).next(ctx());
    expect(d.costUsd).toBe(0);
  });
});

describe("errors, timeout, abort, retry", () => {
  it("retries once on 429 and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ error: { code: 429, message: "Rate limit exceeded" } }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonRes(REALISTIC));
    const d = await createOpenRouterVoice(info, { retryDelayMs: 1 }).next(ctx());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(d.top[0].token).toBe(" Paris");
  });

  it("gives up after one retry with a clear error naming model, status and provider", async () => {
    const err = { error: { code: 502, message: "Provider returned error", metadata: { provider_name: "GMICloud", raw: "upstream exploded" } } };
    fetchMock.mockImplementation(async () => jsonRes(err, 502));
    await expect(createOpenRouterVoice(info, { retryDelayMs: 1 }).next(ctx())).rejects.toThrow(
      "meta-llama/llama-3.3-70b-instruct: OpenRouter HTTP 502: Provider returned error | upstream exploded (provider: GMICloud)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry 400/401/402 and never leaks the key", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: { code: 401, message: "No auth credentials found" } }, 401));
    const p = createOpenRouterVoice(info, { retryDelayMs: 1 }).next(ctx());
    await expect(p).rejects.toThrow(/HTTP 401: No auth credentials found/);
    await p.catch((e: Error) => expect(e.message).not.toContain("sk-or-test-key"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a 200 body carrying an error as an error (and retries 5xx codes)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ error: { code: 503, message: "No allowed providers are available for the selected model." } }))
      .mockResolvedValueOnce(jsonRes({ error: { code: 503, message: "No allowed providers are available for the selected model." } }));
    await expect(createOpenRouterVoice(info, { retryDelayMs: 1 }).next(ctx())).rejects.toThrow(/HTTP 503: No allowed providers/);
  });

  it("times out instead of hanging", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // never settles, ignores signal
    await expect(createOpenRouterVoice(info, { timeoutMs: 30 }).next(ctx())).rejects.toThrow(
      /meta-llama\/llama-3\.3-70b-instruct: request timed out after 30 ms/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects promptly when ctx.signal aborts mid-request", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const ac = new AbortController();
    const p = createOpenRouterVoice(info).next(ctx({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately when already aborted, without calling fetch", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(createOpenRouterVoice(info).next(ctx({ signal: ac.signal }))).rejects.toThrow(/aborted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries once on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(jsonRes(REALISTIC));
    const d = await createOpenRouterVoice(info, { retryDelayMs: 1 }).next(ctx());
    expect(d.top[0].token).toBe(" Paris");
  });
});

describe("choir", () => {
  it("is empty without a key", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(liveAvailable()).toBe(false);
    expect(createLiveVoices()).toEqual([]);
  });

  it("builds one voice per default catalog entry with a key", () => {
    const voices = createLiveVoices();
    expect(voices.map((v) => v.info.id)).toEqual(DEFAULT_CHOIR.map((m) => m.id));
    expect(voices.every((v) => v.info.simulated === false && v.info.pricing)).toBe(true);
  });

  it("honours CHORUS_MODELS, deriving metadata for unknown slugs", () => {
    process.env.CHORUS_MODELS = " mistralai/mistral-nemo, acme/super-model-7b-instruct:free ,mistralai/mistral-nemo,";
    const voices = createLiveVoices();
    expect(voices.map((v) => v.info.id)).toEqual(["mistralai/mistral-nemo", "acme/super-model-7b-instruct:free"]);
    expect(voices[0].info.lab).toBe("Mistral AI");
    expect(voices[1].info).toEqual({
      id: "acme/super-model-7b-instruct:free",
      label: "Super Model 7b Instruct",
      lab: "Unknown",
      origin: "Unknown",
      simulated: false,
    });
  });

  it("derives labels and resolves the default choir", () => {
    expect(labelFromSlug("meta-llama/llama-3.3-70b-instruct")).toBe("Llama 3.3 70b Instruct");
    expect(resolveChoir("")).toHaveLength(DEFAULT_CHOIR.length);
    expect(new Set(DEFAULT_CHOIR.map((m) => m.lab)).size).toBe(DEFAULT_CHOIR.length);
  });
});
