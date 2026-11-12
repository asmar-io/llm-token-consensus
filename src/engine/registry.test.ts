import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getChoirInfo, resolveVoices } from "@/engine/registry";
import { DEMO_SAMPLE_PROMPTS } from "@/engine/demo";
import { DEFAULT_CHOIR, KNOWN_MODELS } from "@/engine/voices/catalog";

let savedKey: string | undefined;
let savedModels: string | undefined;
beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  savedModels = process.env.CHORUS_MODELS;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.CHORUS_MODELS;
});
afterEach(() => {
  if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
  else delete process.env.OPENROUTER_API_KEY;
  if (savedModels !== undefined) process.env.CHORUS_MODELS = savedModels;
});

describe("registry without an API key", () => {
  it("serves the recorded demo choir: real models, a note, the recorded prompts", () => {
    const info = getChoirInfo();
    expect(info.mode).toBe("demo");
    expect(info.voices.length).toBeGreaterThanOrEqual(2);
    expect(info.voices.every((v) => !v.simulated && v.id.includes("/"))).toBe(true);
    expect(info.note).toMatch(/OPENROUTER_API_KEY/);
    expect(info.note).toMatch(/recorded/);
    expect(info.samplePrompts).toEqual(DEMO_SAMPLE_PROMPTS);
    expect(info.defaults).toMatchObject({ blend: "mixture", temperature: 0.7 });
    expect(Number.isInteger(info.defaults.seed)).toBe(true);
  });

  it("has no live voices to resolve", () => {
    const r = resolveVoices(["qwen/qwen3.6-27b"]);
    expect(r.ok).toBe(false);
  });
});

describe("registry with an API key", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  it("offers every verified model and preselects the default choir", () => {
    const info = getChoirInfo();
    expect(info.mode).toBe("live");
    expect(info.voices.map((v) => v.id)).toEqual(KNOWN_MODELS.map((m) => m.id));
    expect(info.defaultVoices).toEqual(DEFAULT_CHOIR.map((m) => m.id));
    expect(info.voices.every((v) => !("route" in v))).toBe(true);
  });

  it("resolves any offered id in request order and rejects unknown ones", () => {
    const ids = [KNOWN_MODELS[4].id, KNOWN_MODELS[0].id];
    const ok = resolveVoices(ids);
    expect(ok.ok && ok.voices.map((v) => v.info.id)).toEqual(ids);
    const bad = resolveVoices([KNOWN_MODELS[0].id, "meta-llama/llama-3.3-70b-instruct"]);
    expect(!bad.ok && bad.unknown).toEqual(["meta-llama/llama-3.3-70b-instruct"]);
  });

  it("CHORUS_MODELS narrows what is on offer and selects all of it", () => {
    process.env.CHORUS_MODELS = "qwen/qwen3.8-flash,deepseek/deepseek-v4-flash-0731";
    const info = getChoirInfo();
    expect(info.voices.map((v) => v.id)).toEqual(["qwen/qwen3.8-flash", "deepseek/deepseek-v4-flash-0731"]);
    expect(info.defaultVoices).toEqual(info.voices.map((v) => v.id));
  });
});
