import { describe, expect, it } from "vitest";
import { applyTemperature, mulberry32, sampleToken, stepRng } from "@/engine/sample";

const dist = new Map([
  ["a", 0.5],
  ["b", 0.3],
  ["c", 0.2],
]);

describe("sampling", () => {
  it("temperature 0 is argmax, ties broken by token", () => {
    expect(sampleToken(dist, 0, mulberry32(1))).toBe("a");
    expect(sampleToken(new Map([["y", 0.5], ["x", 0.5]]), 0, mulberry32(1))).toBe("x");
  });

  it("is deterministic for the same seed and step, and varies across seeds", () => {
    const run = (seed: number) => Array.from({ length: 40 }, (_, k) => sampleToken(dist, 1, stepRng(seed, k)));
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it("the draw for step k does not depend on earlier steps (forks replay)", () => {
    expect(stepRng(9, 17)()).toBe(stepRng(9, 17)());
  });

  it("temperature sharpens and flattens without underflow", () => {
    const cold = applyTemperature(dist, 0.01);
    expect(cold.get("a")).toBeCloseTo(1);
    const hot = applyTemperature(dist, 1.5);
    expect(hot.get("c")!).toBeGreaterThan(0.2);
    expect([...hot.values()].reduce((x, y) => x + y)).toBeCloseTo(1);
  });

  it("matches the tempered distribution empirically", () => {
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let k = 0; k < 20000; k++) counts[sampleToken(dist, 1, stepRng(5, k))!]++;
    expect(counts.a / 20000).toBeCloseTo(0.5, 1);
    expect(counts.c / 20000).toBeCloseTo(0.2, 1);
  });

  it("returns null for an empty distribution and ignores zero-mass tokens", () => {
    expect(sampleToken(new Map(), 1, mulberry32(1))).toBeNull();
    expect(sampleToken(new Map([["z", 0], ["a", 1]]), 1, mulberry32(1))).toBe("a");
  });
});
