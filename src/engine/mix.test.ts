import { describe, expect, it } from "vitest";
import { agreement, consensusFloor, entropyBits, mix, normaliseWeights, shares, type MixInput } from "@/engine/mix";

const P = (o: Record<string, number>) => new Map(Object.entries(o));
const cands = ["a", "b", "c"];

describe("mix", () => {
  const A = P({ a: 0.8, b: 0.2, c: 0 });
  const B = P({ a: 0.1, b: 0.1, c: 0.8 });

  it("mixture is the weighted arithmetic mean", () => {
    const M = mix([{ probs: A, weight: 0.5 }, { probs: B, weight: 0.5 }], cands, "mixture");
    expect(M.get("a")).toBeCloseTo(0.45);
    expect(M.get("c")).toBeCloseTo(0.4);
    expect([...M.values()].reduce((x, y) => x + y)).toBeCloseTo(1);
  });

  it("weights shift the mixture", () => {
    const M = mix([{ probs: A, weight: 0.9 }, { probs: B, weight: 0.1 }], cands, "mixture");
    expect(M.get("a")).toBeCloseTo(0.73);
  });

  it("consensus favours tokens both voices support and punishes unlisted ones", () => {
    const M = mix([{ probs: A, weight: 0.5 }, { probs: B, weight: 0.5 }], cands, "consensus");
    expect([...M.values()].reduce((x, y) => x + y)).toBeCloseTo(1);
    // c is unlisted by A, so it should fall well below a and b even though B loves it.
    expect(M.get("c")!).toBeLessThan(M.get("a")!);
    expect(M.get("b")!).toBeGreaterThan(0);
    for (const v of M.values()) expect(Number.isFinite(v)).toBe(true);
  });

  it("consensus floor is half the smallest listed probability, clamped to [1e-4, 1e-2]", () => {
    expect(consensusFloor(P({ a: 0.999, b: 0.001 }))).toBeCloseTo(5e-4);
    expect(consensusFloor(P({ a: 1 - 1e-7, b: 1e-7 }))).toBe(1e-4);
    expect(consensusFloor(P({ a: 1 }))).toBe(1e-2);
    expect(consensusFloor(P({}))).toBe(1e-4);
  });

  it("returns zeros rather than NaN with no mass", () => {
    const Z = P({ a: 0, b: 0, c: 0 });
    for (const mode of ["mixture", "consensus"] as const) {
      const M = mix([{ probs: Z, weight: 1 }], cands, mode);
      for (const v of M.values()) expect(Number.isNaN(v)).toBe(false);
    }
  });
});

describe("shares", () => {
  const inputs: MixInput[] = [
    { probs: P({ a: 0.8, b: 0.2 }), weight: 0.5 },
    { probs: P({ a: 0.2, b: 0.8 }), weight: 0.5 },
  ];
  it("mixture shares decompose the sum and add to 1", () => {
    const s = shares(inputs, "a", "mixture");
    expect(s[0]).toBeCloseTo(0.8);
    expect(s[0] + s[1]).toBeCloseTo(1);
  });
  it("consensus shares add to 1 and grow with support", () => {
    const s = shares(inputs, "a", "consensus");
    expect(s[0] + s[1]).toBeCloseTo(1);
    expect(s[0]).toBeGreaterThan(s[1]);
  });
  it("fall back to weights when nobody supports the token", () => {
    const s = shares(
      [
        { probs: P({ a: 1, z: 0 }), weight: 0.75 },
        { probs: P({ a: 1, z: 0 }), weight: 0.25 },
      ],
      "z",
      "mixture",
    );
    expect(s).toEqual([0.75, 0.25]);
  });
});

describe("agreement and entropy", () => {
  it("is 1 for identical voices, 0 for disjoint equal-weight voices, 1 for a solo", () => {
    const A = P({ a: 1, b: 0 });
    const B = P({ a: 0, b: 1 });
    expect(agreement([{ probs: A, weight: 0.5 }, { probs: A, weight: 0.5 }], ["a", "b"])).toBeCloseTo(1);
    expect(agreement([{ probs: A, weight: 0.5 }, { probs: B, weight: 0.5 }], ["a", "b"])).toBeCloseTo(0);
    expect(agreement([{ probs: A, weight: 1 }], ["a", "b"])).toBe(1);
  });
  it("entropy is in bits", () => {
    expect(entropyBits([0.5, 0.5])).toBeCloseTo(1);
    expect(entropyBits([1, 0])).toBe(0);
  });
  it("normaliseWeights ignores non-positive weights", () => {
    expect(normaliseWeights([2, 0, 2])).toEqual([0.5, 0, 0.5]);
    expect(normaliseWeights([0, 0])).toEqual([0, 0]);
  });
});
