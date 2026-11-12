import { describe, expect, it } from "vitest";
import { EOS, type BlendMode, type PerformEvent, type PerformRequest, type Step } from "@/lib/protocol";
import { perform } from "@/engine/perform";
import { createDemoVoices, demoDistribution, PERSONAS, DEMO_SAMPLE_PROMPTS } from "./choir";
import { FALLBACK_SCRIPT, SCRIPTS, scriptForPrompt } from "./scripts";
import { locate, tokenize } from "./script";

function expectAllFinite(v: unknown, path = "step"): void {
  if (typeof v === "number") expect(Number.isFinite(v), path).toBe(true);
  else if (v === undefined) expect.fail(`${path} is undefined`);
  else if (Array.isArray(v)) v.forEach((x, i) => expectAllFinite(x, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) expectAllFinite(x, `${path}.${k}`);
}

function checkStep(s: Step) {
  expectAllFinite(s);
  expect(s.token.length).toBeGreaterThan(0);
  expect(s.token).not.toBe(EOS);
  expect(s.agreement).toBeGreaterThanOrEqual(0);
  expect(s.agreement).toBeLessThanOrEqual(1);
  expect(s.alternatives.some((a) => a.token === s.token)).toBe(true);
  expect(Math.abs(s.ballots.reduce((a, b) => a + b.share, 0) - 1)).toBeLessThan(1e-9);
}

const ALL = [...SCRIPTS, FALLBACK_SCRIPT];
const promptOf = (id: string) => (id === "fallback" ? "What is the boiling point of tungsten?" : SCRIPTS.find((s) => s.id === id)!.prompt);

async function run(over: Partial<PerformRequest> & { prompt: string }, signal = new AbortController().signal) {
  const seed = over.seed ?? 1;
  const voices = createDemoVoices({ seed, latencyScale: 0 });
  const request: PerformRequest = {
    voices: voices.map((v) => ({ id: v.info.id, weight: 1 })),
    blend: "mixture",
    temperature: 0.7,
    seed,
    maxTokens: 400,
    ...over,
  };
  const events: PerformEvent[] = [];
  for await (const e of perform(request, voices, signal)) events.push(e);
  const steps = events.filter((e): e is Extract<PerformEvent, { type: "step" }> => e.type === "step").map((e) => e.step);
  return { events, steps, text: (request.prefix ?? []).join("") + steps.map((s) => s.token).join(""), last: events[events.length - 1] };
}

/** Every complete text a script can produce with its first option at every slot. */
const canonical = (id: string) => ALL.find((s) => s.id === id)!.units.map((u) => u.options[0].text).join("");

describe("scripts", () => {
  it("parse into units, with a healthy share of contested slots", () => {
    for (const s of ALL) {
      expect(s.units.length).toBeGreaterThan(5);
      expect(s.units.filter((u) => u.contested).length).toBeGreaterThanOrEqual(7);
    }
  });

  it("sample prompts are the visible scripts, and they map to themselves", () => {
    expect(DEMO_SAMPLE_PROMPTS).toHaveLength(SCRIPTS.length);
    for (const s of SCRIPTS) expect(scriptForPrompt(s.prompt).id).toBe(s.id);
  });

  it("free-typed prompts go to the nearest script or to the honest fallback", () => {
    expect(scriptForPrompt("is breaking a promise ever okay?").id).toBe("promise");
    expect(scriptForPrompt("what makes teachers good").id).toBe("teacher");
    expect(scriptForPrompt("perfect city?").id).toBe("city");
    expect(scriptForPrompt("What is the boiling point of tungsten?").id).toBe("fallback");
    expect(scriptForPrompt("").id).toBe("fallback");
  });

  it("voices cut some words differently", () => {
    const cuts = PERSONAS.map((p) => tokenize(" responsibility and decentralisation", p.tokenizer).join("|"));
    expect(new Set(cuts).size).toBeGreaterThanOrEqual(3);
  });
});

describe("locate", () => {
  const s = SCRIPTS.find((x) => x.id === "refuse")!;
  it("finds the start, the middle of a piece, and the end", () => {
    expect(locate(s, "").positions).toEqual([{ kind: "boundary", unit: 0, via: null }]);
    const mid = locate(s, "Yes — but rar");
    expect(mid.resynced).toBe(false);
    expect(mid.positions[0]).toMatchObject({ kind: "inside", offset: " — but rar".length });
    const full = canonical("refuse");
    expect(locate(s, full).positions.some((p) => p.kind === "boundary" && p.unit === s.units.length)).toBe(true);
  });
  it("keeps every option alive while a shared prefix is ambiguous", () => {
    // ", within limits" and ", and often" both start with ","
    expect(locate(s, "Yes,").positions.length).toBe(2);
  });
  it("rejoins the script after an off-script detour", () => {
    const loc = locate(s, "Yes, but only on Tuesdays");
    expect(loc.resynced).toBe(true);
    const d = demoDistribution(PERSONAS[0], s.prompt, "Yes, but only on Tuesdays", 1);
    expect(d.length).toBeGreaterThan(0);
  });
});

describe("demo distributions", () => {
  it("are believable: proper probabilities, a clear favourite, deterministic per seed", () => {
    for (const p of PERSONAS) {
      const d = demoDistribution(p, SCRIPTS[0].prompt, "Yes", 3);
      const total = d.reduce((a, c) => a + c.p, 0);
      expect(total).toBeLessThanOrEqual(1 + 1e-9);
      expect(total).toBeGreaterThan(0.8);
      expect(d[0].p).toBeGreaterThan(d[d.length - 1].p - 1e-12);
      expect(demoDistribution(p, SCRIPTS[0].prompt, "Yes", 3)).toEqual(d);
    }
  });

  it("temperaments disagree at contested slots", () => {
    const tops = PERSONAS.map((p) => demoDistribution(p, SCRIPTS[0].prompt, "Yes, within limits. A model that can never say no can be turned into a tool for", 5)[0].token);
    expect(new Set(tops).size).toBeGreaterThan(1);
  });

  it("simulated latency is applied and abortable", async () => {
    const [v] = createDemoVoices({ seed: 1 });
    const ac = new AbortController();
    const t0 = Date.now();
    const d = await v.next({ prompt: SCRIPTS[0].prompt, textSoFar: "", stepIndex: 0, signal: ac.signal });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(d.costUsd).toBe(0);
    const p = v.next({ prompt: SCRIPTS[0].prompt, textSoFar: "", stepIndex: 1, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeDefined();
  });
});

describe("demo performances end to end", () => {
  for (const s of ALL) {
    for (const blend of ["mixture", "consensus"] as BlendMode[]) {
      it(`${s.id} (${blend}) performs to EOS`, async () => {
        const { steps, text, last } = await run({ prompt: promptOf(s.id), blend });
        expect(text.trim().length).toBeGreaterThan(40);
        expect(last.type === "done" && last.reason).toBe("eos");
        steps.forEach(checkStep);
        // contested but not chaotic
        const contested = steps.filter((x) => x.agreement < 0.9).length / steps.length;
        expect(contested).toBeGreaterThan(0.05);
        expect(contested).toBeLessThan(0.45);
        // text ends with the script's final punctuation
        expect(/[.!?]$/.test(text)).toBe(true);
      });
    }
  }

  it("the fallback says plainly what the demo is", async () => {
    const { text } = await run({ prompt: "What is the boiling point of tungsten?" });
    expect(text).toContain("simulated demo choir");
    expect(text).toContain("OPENROUTER_API_KEY");
  });

  it("temperature 0 replays identically and different seeds can differ", async () => {
    const a = await run({ prompt: SCRIPTS[0].prompt, seed: 4 });
    const b = await run({ prompt: SCRIPTS[0].prompt, seed: 4 });
    expect(a.text).toBe(b.text);
    const texts = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) texts.add((await run({ prompt: SCRIPTS[0].prompt, seed })).text);
    expect(texts.size).toBeGreaterThan(1);
  });

  it("a fork with prefix replays the original from that point when nothing is forced", async () => {
    const orig = await run({ prompt: SCRIPTS[1].prompt, seed: 9 });
    const k = 20;
    const fork = await run({ prompt: SCRIPTS[1].prompt, seed: 9, prefix: orig.steps.slice(0, k).map((s) => s.token) });
    expect(fork.text).toBe(orig.text);
    expect(fork.steps[0].index).toBe(k);
  });

  it("aborting mid-performance ends with done(aborted)", async () => {
    const ac = new AbortController();
    const voices = createDemoVoices({ seed: 1, latencyScale: 0.2 });
    const request: PerformRequest = {
      prompt: SCRIPTS[2].prompt,
      voices: voices.map((v) => ({ id: v.info.id, weight: 1 })),
      blend: "mixture",
      temperature: 0.7,
      seed: 1,
      maxTokens: 400,
    };
    const events: PerformEvent[] = [];
    for await (const e of perform(request, voices, ac.signal)) {
      events.push(e);
      if (e.type === "step" && e.step.index === 3) ac.abort();
    }
    const last = events[events.length - 1];
    expect(last.type === "done" && last.reason).toBe("aborted");
  });
});

describe("property: every script, many seeds, both blends, forced forks", () => {
  it("never produces NaN/undefined and always terminates", async () => {
    let runs = 0;
    for (const s of ALL) {
      for (let seed = 1; seed <= 6; seed++) {
        for (const blend of ["mixture", "consensus"] as BlendMode[]) {
          const temperature = [0, 0.4, 0.7, 1.0, 1.5][(seed + runs) % 5];
          const base = await run({ prompt: promptOf(s.id), seed, blend, temperature, maxTokens: 300 });
          runs++;
          expect(base.last.type).toBe("done");
          base.steps.forEach(checkStep);
          expect(base.text.length).toBeGreaterThan(0);

          // Fork at a contested step to a non-chosen alternative (the UI's fork path).
          const contested = base.steps.filter((x) => x.alternatives.length > 1);
          if (contested.length === 0) continue;
          const at = contested[(seed * 7) % contested.length];
          const alt = at.alternatives.find((a) => a.token !== at.token && a.token !== EOS);
          if (!alt) continue;
          const prefix = base.steps.filter((x) => x.index < at.index).map((x) => x.token);
          const fork = await run({ prompt: promptOf(s.id), seed, blend, temperature, maxTokens: 300, prefix, forcedNext: alt.token });
          expect(fork.last.type).toBe("done");
          expect(fork.steps[0].forced).toBe(true);
          expect(fork.steps[0].token).toBe(alt.token);
          expect(fork.steps[0].index).toBe(at.index);
          fork.steps.forEach(checkStep);
          if (temperature <= 1) expect(fork.last.type === "done" && fork.last.reason).toBe("eos");

          // And an off-script fork: a token nobody proposed.
          const wild = await run({ prompt: promptOf(s.id), seed, blend, temperature, maxTokens: 300, prefix, forcedNext: " purple" });
          expect(wild.last.type).toBe("done");
          wild.steps.forEach(checkStep);
        }
      }
    }
    expect(runs).toBe(ALL.length * 12);
  }, 120_000);
});
