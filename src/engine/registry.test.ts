import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getChoirInfo, resolveVoices } from "@/engine/registry";
import { DEMO_SAMPLE_PROMPTS } from "@/engine/demo";

describe("registry (no API key)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  });

  it("serves the simulated demo choir with a note", () => {
    const info = getChoirInfo();
    expect(info.mode).toBe("demo");
    expect(info.voices).toHaveLength(5);
    expect(info.voices.every((v) => v.simulated && v.id.startsWith("demo:") && v.blurb)).toBe(true);
    expect(info.note).toMatch(/OPENROUTER_API_KEY/);
    expect(info.samplePrompts).toEqual(DEMO_SAMPLE_PROMPTS);
    expect(info.defaults).toMatchObject({ blend: "mixture", temperature: 0.7, maxTokens: 160 });
    expect(Number.isInteger(info.defaults.seed)).toBe(true);
  });

  it("resolves known ids and rejects unknown ones", () => {
    const ok = resolveVoices(["demo:flint", "demo:aster"], { seed: 1 });
    expect(ok.ok && ok.voices.map((v) => v.info.id)).toEqual(["demo:flint", "demo:aster"]);
    const bad = resolveVoices(["demo:flint", "meta-llama/llama-3.3-70b-instruct"], { seed: 1 });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.unknown).toEqual(["meta-llama/llama-3.3-70b-instruct"]);
  });
});
