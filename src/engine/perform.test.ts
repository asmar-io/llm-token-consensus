import { describe, expect, it } from "vitest";
import { EOS, type PerformEvent, type PerformRequest, type Step } from "@/lib/protocol";
import type { Voice, VoiceContext } from "@/engine/voice";
import { computeStep, perform, validateRequest } from "@/engine/perform";

type Top = { token: string; p: number }[];

function fake(id: string, fn: (ctx: VoiceContext) => Top | Promise<Top>, opts: { costUsd?: number } = {}): Voice {
  return {
    info: { id, label: id.toUpperCase(), lab: "Test", origin: "Nowhere", simulated: true },
    async next(ctx) {
      const top = await fn(ctx);
      return {
        top: top.map((t) => ({ token: t.token, logprob: Math.log(t.p) })),
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: opts.costUsd ?? 0,
      };
    },
  };
}

/** Speaks `words` in order (by stepIndex), then EOS. */
const speaker = (id: string, words: string[], conf = 0.9) =>
  fake(id, (ctx) => (ctx.stepIndex < words.length ? [{ token: words[ctx.stepIndex], p: conf }, { token: " um", p: 1 - conf }] : [{ token: EOS, p: 0.99 }]));

const req = (over: Partial<PerformRequest> = {}): PerformRequest => ({
  prompt: "test",
  voices: [
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
  ],
  blend: "mixture",
  temperature: 0,
  seed: 1,
  maxTokens: 50,
  ...over,
});

async function collect(gen: AsyncGenerator<PerformEvent>) {
  const events: PerformEvent[] = [];
  for await (const e of gen) events.push(e);
  const steps = events.filter((e): e is Extract<PerformEvent, { type: "step" }> => e.type === "step").map((e) => e.step);
  return { events, steps, last: events[events.length - 1] };
}

/** Every number anywhere in the value is finite; nothing is undefined. */
function expectAllFinite(v: unknown, path = "step"): void {
  if (typeof v === "number") expect(Number.isFinite(v), path).toBe(true);
  else if (v === undefined) expect.fail(`${path} is undefined`);
  else if (Array.isArray(v)) v.forEach((x, i) => expectAllFinite(x, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (x !== undefined || k !== "forced") expectAllFinite(x, `${path}.${k}`);
}

function assertStepInvariants(s: Step) {
  expectAllFinite(s);
  expect(s.token.length).toBeGreaterThan(0);
  expect(s.token).not.toBe(EOS);
  expect(Number.isFinite(s.p)).toBe(true);
  expect(s.agreement).toBeGreaterThanOrEqual(0);
  expect(s.agreement).toBeLessThanOrEqual(1);
  expect(Number.isFinite(s.entropy)).toBe(true);
  expect(s.alternatives.length).toBeLessThanOrEqual(8);
  expect(s.alternatives.some((a) => a.token === s.token)).toBe(true);
  const sum = s.ballots.reduce((a, b) => a + b.share, 0);
  expect(sum).toBeCloseTo(1, 6);
  for (const b of s.ballots) {
    expect(Number.isFinite(b.share) && Number.isFinite(b.pChosen)).toBe(true);
    expect(b.top.length).toBeLessThanOrEqual(8);
    if (b.weight === 0 || b.failed) expect(b.share).toBe(0);
  }
  expect(s.ballots.some((b) => b.voiceId === s.lead)).toBe(true);
}

describe("validateRequest", () => {
  it("accepts a good body and fills defaults", () => {
    const v = validateRequest({ prompt: "hi", voices: [{ id: "x", weight: 1 }] });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.request.blend).toBe("mixture");
      expect(v.request.temperature).toBe(0.7);
      expect(v.request.maxTokens).toBe(160);
    }
  });
  it("clamps maxTokens and temperature", () => {
    const v = validateRequest({ prompt: "hi", voices: [{ id: "x", weight: 1 }], maxTokens: 99999, temperature: 9 });
    expect(v.ok && v.request.maxTokens).toBe(400);
    expect(v.ok && v.request.temperature).toBe(1.5);
  });
  it.each([
    [null],
    [{}],
    [{ prompt: "", voices: [{ id: "x", weight: 1 }] }],
    [{ prompt: "hi", voices: [] }],
    [{ prompt: "hi", voices: [{ id: "x", weight: 0 }] }],
    [{ prompt: "hi", voices: [{ id: "x", weight: -1 }] }],
    [{ prompt: "hi", voices: [{ id: "x", weight: 1 }, { id: "x", weight: 1 }] }],
    [{ prompt: "hi", voices: [{ id: "x", weight: 1 }], blend: "median" }],
    [{ prompt: "hi", voices: [{ id: "x", weight: 1 }], temperature: "hot" }],
    [{ prompt: "hi", voices: [{ id: "x", weight: 1 }], prefix: ["ok", ""] }],
    [{ prompt: "hi", voices: [{ id: "x", weight: 1 }], prefix: [EOS] }],
    [{ prompt: "hi", voices: [{ id: "x", weight: 1 }], forcedNext: EOS }],
  ])("rejects %j", (body) => {
    expect(validateRequest(body).ok).toBe(false);
  });
});

describe("computeStep", () => {
  it("aligns different cuts and reports a coherent step", () => {
    const out = computeStep({
      index: 0,
      blend: "mixture",
      temperature: 0,
      seed: 1,
      results: [
        { voiceId: "a", weight: 1, raw: [{ token: " decentral", p: 0.9 }], latencyMs: 1, costUsd: 0 },
        { voiceId: "b", weight: 1, raw: [{ token: " decentralised", p: 0.9 }], latencyMs: 1, costUsd: 0 },
        { voiceId: "c", weight: 0, raw: [{ token: " dec", p: 0.9 }], latencyMs: 1, costUsd: 0 },
      ],
    })!;
    assertStepInvariants({ ...out.step, elapsedMs: 0 });
    // the muted voice's token is not a candidate at all
    expect(out.step.alternatives.some((a) => a.token === " dec")).toBe(false);
    expect(out.step.ballots[2].pChosen).toBeGreaterThan(0); // but it is still aligned for display
    expect(out.step.ballots[2].rank).toBeNull();
  });

  it("forced token missing from every list gets p 0 and weight-based shares, no NaN", () => {
    for (const blend of ["mixture", "consensus"] as const) {
      const out = computeStep({
        index: 3,
        blend,
        temperature: 0.7,
        seed: 1,
        forced: " zebra",
        results: [
          { voiceId: "a", weight: 3, raw: [{ token: " cat", p: 0.9 }], latencyMs: 1, costUsd: 0 },
          { voiceId: "b", weight: 1, raw: [{ token: " dog", p: 0.9 }], latencyMs: 1, costUsd: 0 },
        ],
      })!;
      expect(out.token).toBe(" zebra");
      expect(out.step.forced).toBe(true);
      assertStepInvariants({ ...out.step, elapsedMs: 0 });
      if (blend === "mixture") {
        expect(out.step.p).toBe(0);
        expect(out.step.ballots.map((b) => b.share)).toEqual([0.75, 0.25]);
      }
    }
  });

  it("returns null when no singing voice answered", () => {
    expect(
      computeStep({
        index: 0,
        blend: "mixture",
        temperature: 0,
        seed: 1,
        results: [{ voiceId: "a", weight: 1, raw: null, latencyMs: 1, costUsd: 0 }],
      }),
    ).toBeNull();
  });
});

describe("perform", () => {
  const words = [" The", " sky", " is", " blue", "."];

  it("streams start, steps, then done(eos) without emitting EOS", async () => {
    const voices = [speaker("a", words), speaker("b", words)];
    const { events, steps, last } = await collect(perform(req(), voices, new AbortController().signal));
    expect(events[0].type).toBe("start");
    expect(steps.map((s) => s.token).join("")).toBe(" The sky is blue.");
    steps.forEach(assertStepInvariants);
    expect(steps.every((s) => s.unanimous)).toBe(true);
    expect(last.type).toBe("done");
    if (last.type === "done") {
      expect(last.reason).toBe("eos");
      expect(last.summary.tokens).toBe(5);
      expect(Object.values(last.summary.influence).reduce((a, b) => a + b)).toBeCloseTo(1);
    }
  });

  it("stops at maxTokens", async () => {
    const forever = fake("a", () => [{ token: " la", p: 0.9 }]);
    const { steps, last } = await collect(
      perform(req({ voices: [{ id: "a", weight: 1 }], maxTokens: 7 }), [forever], new AbortController().signal),
    );
    expect(steps).toHaveLength(7);
    expect(last.type === "done" && last.reason).toBe("max_tokens");
  });

  it("muted voices are polled but have no influence", async () => {
    const a = speaker("a", words);
    const b = fake("b", () => [{ token: " NO", p: 0.99 }]);
    const { steps, last } = await collect(
      perform(req({ voices: [{ id: "a", weight: 1 }, { id: "b", weight: 0 }] }), [a, b], new AbortController().signal),
    );
    expect(steps.map((s) => s.token).join("")).toBe(" The sky is blue.");
    expect(steps[0].ballots[1].top[0].token).toBe(" NO");
    expect(steps.every((s) => s.ballots[1].share === 0)).toBe(true);
    expect(last.type === "done" && last.summary.influence.b).toBe(0);
  });

  it("weights decide a split vote", async () => {
    const a = fake("a", (c) => (c.stepIndex ? [{ token: EOS, p: 1 }] : [{ token: " yes", p: 0.9 }, { token: " no", p: 0.1 }]));
    const b = fake("b", (c) => (c.stepIndex ? [{ token: EOS, p: 1 }] : [{ token: " no", p: 0.9 }, { token: " yes", p: 0.1 }]));
    const heavyA = await collect(perform(req({ voices: [{ id: "a", weight: 3 }, { id: "b", weight: 1 }] }), [a, b], new AbortController().signal));
    const heavyB = await collect(perform(req({ voices: [{ id: "a", weight: 1 }, { id: "b", weight: 3 }] }), [a, b], new AbortController().signal));
    expect(heavyA.steps[0].token).toBe(" yes");
    expect(heavyA.steps[0].lead).toBe("a");
    expect(heavyB.steps[0].token).toBe(" no");
    expect(heavyA.steps[0].agreement).toBeLessThan(0.6);
  });

  it("a failing voice sits out with one non-fatal error, the rest carry on", async () => {
    const bad = fake("b", () => {
      throw new Error("boom");
    });
    const { events, steps, last } = await collect(perform(req(), [speaker("a", words), bad], new AbortController().signal));
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].type === "error" && errors[0].fatal).toBe(false);
    expect(steps.map((s) => s.token).join("")).toBe(" The sky is blue.");
    expect(steps.every((s) => s.ballots[1].failed && s.ballots[1].share === 0)).toBe(true);
    steps.forEach(assertStepInvariants);
    expect(last.type === "done" && last.reason).toBe("eos");
  });

  it("a voice that hangs is timed out", async () => {
    const hang = fake("b", () => new Promise<Top>(() => {}));
    const { steps, last } = await collect(perform(req(), [speaker("a", words), hang], new AbortController().signal, { voiceTimeoutMs: 30 }));
    expect(steps).toHaveLength(5);
    expect(steps[0].ballots[1].failed).toBe(true);
    expect(last.type).toBe("done");
  });

  it("all singing voices failing is fatal", async () => {
    const bad = fake("a", () => {
      throw new Error("down");
    });
    const listener = speaker("b", words);
    const { last } = await collect(
      perform(req({ voices: [{ id: "a", weight: 1 }, { id: "b", weight: 0 }] }), [bad, listener], new AbortController().signal),
    );
    expect(last.type === "error" && last.fatal).toBe(true);
  });

  it("aborting ends with done(aborted) and aborts in-flight calls", async () => {
    const ac = new AbortController();
    let sawAbort = false;
    const slow = fake("a", (ctx) =>
      ctx.stepIndex < 2
        ? [{ token: " x", p: 1 }]
        : new Promise<Top>((_, reject) =>
            ctx.signal.addEventListener("abort", () => {
              sawAbort = true;
              reject(new Error("aborted"));
            }),
          ),
    );
    const gen = perform(req({ voices: [{ id: "a", weight: 1 }] }), [slow], ac.signal);
    const events: PerformEvent[] = [];
    for await (const e of gen) {
      events.push(e);
      if (e.type === "step" && e.step.index === 1) setTimeout(() => ac.abort(), 10);
    }
    const last = events[events.length - 1];
    expect(last.type === "done" && last.reason).toBe("aborted");
    expect(sawAbort).toBe(true);
    expect(last.type === "done" && last.summary.tokens).toBe(2);
  });

  it("fork: prefix sets textSoFar and the index; forcedNext overrides the first pick", async () => {
    const seen: string[] = [];
    const v = fake("a", (ctx) => {
      seen.push(ctx.textSoFar);
      return ctx.stepIndex < 4 ? [{ token: " more", p: 0.9 }] : [{ token: EOS, p: 1 }];
    });
    const { steps, last, events } = await collect(
      perform(req({ voices: [{ id: "a", weight: 1 }], prefix: [" The", " sky"], forcedNext: " was" }), [v], new AbortController().signal),
    );
    expect(seen[0]).toBe(" The sky");
    expect(steps[0].index).toBe(2);
    expect(steps[0].token).toBe(" was");
    expect(steps[0].forced).toBe(true);
    expect(steps[1].forced).toBeUndefined();
    expect(seen[1]).toBe(" The sky was");
    expect(steps.map((s) => s.token)).toEqual([" was", " more"]);
    steps.forEach(assertStepInvariants);
    expect(last.type === "done" && last.summary.tokens).toBe(2);
    expect(events[0].type === "start" && events[0].request.prefix).toEqual([" The", " sky"]);
  });

  it("is deterministic for the same seed at temperature > 0", async () => {
    const noisy = (id: string) =>
      fake(id, (ctx) =>
        ctx.stepIndex > 12
          ? [{ token: EOS, p: 1 }]
          : [
              { token: " a", p: 0.4 },
              { token: " b", p: 0.35 },
              { token: " c", p: 0.25 },
            ],
      );
    const run = async (seed: number) =>
      (await collect(perform(req({ temperature: 1, seed }), [noisy("a"), noisy("b")], new AbortController().signal))).steps
        .map((s) => s.token)
        .join("");
    expect(await run(11)).toBe(await run(11));
    const all = new Set(await Promise.all([1, 2, 3, 4, 5].map(run)));
    expect(all.size).toBeGreaterThan(1);
  });
});
