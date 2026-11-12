import { describe, expect, it } from "vitest";
import { EOS } from "@/lib/protocol";
import { alignVoice, buildCandidates, overlap, toProbs } from "@/engine/align";

const lp = (p: number) => Math.log(p);

describe("toProbs", () => {
  it("exps logprobs, merges duplicates, drops empty / U+FFFD / NaN, sorts best first", () => {
    const raw = toProbs([
      { token: " a", logprob: lp(0.2) },
      { token: "", logprob: lp(0.3) },
      { token: " b", logprob: lp(0.5) },
      { token: " a", logprob: lp(0.1) },
      { token: "�", logprob: lp(0.05) },
      { token: " c", logprob: NaN },
    ]);
    expect(raw.map((r) => r.token)).toEqual([" b", " a"]);
    expect(raw[1].p).toBeCloseTo(0.3);
  });
  it("clamps positive logprobs to p = 1", () => {
    expect(toProbs([{ token: "x", logprob: 0.4 }])[0].p).toBe(1);
  });
});

describe("overlap", () => {
  it("implements exact / prefix / extension with length damping", () => {
    expect(overlap(" dec", " dec")).toBe(1);
    expect(overlap(" decentral", " dec")).toBeCloseTo(4 / 10); // t starts with c
    expect(overlap(" dec", " decentral")).toBeCloseTo(4 / 10); // c starts with t
    expect(overlap(" dog", " dec")).toBe(0);
  });
  it("EOS only matches EOS, even against a literal prefix of the sentinel string", () => {
    expect(overlap(EOS, EOS)).toBe(1);
    expect(overlap("<|", EOS)).toBe(0);
    expect(overlap(EOS, "<|")).toBe(0);
  });
  it("counts code points, not UTF-16 units", () => {
    expect(overlap("😀ab", "😀")).toBeCloseTo(1 / 3);
  });
});

describe("alignVoice", () => {
  const cands = buildCandidates([
    [{ token: " dec", p: 0.5 }],
    [{ token: " decentral", p: 0.6 }],
    [{ token: " decentralised", p: 0.9 }, { token: EOS, p: 0.05 }],
  ]);

  it("builds the union of candidates without empties", () => {
    expect(cands).toEqual([" dec", " decentral", " decentralised", EOS]);
    expect(buildCandidates([[{ token: "", p: 1 }]], ["", "x"])).toEqual(["x"]);
  });

  it("renormalises over the candidate set and spreads mass across cuts", () => {
    const P = alignVoice([{ token: " decentralised", p: 0.9 }], cands);
    const total = [...P.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    expect(P.get(" decentralised")!).toBeGreaterThan(P.get(" decentral")!);
    expect(P.get(" decentral")!).toBeGreaterThan(P.get(" dec")!);
    expect(P.get(EOS)).toBe(0);
  });

  it("damps a whitespace-only candidate so it cannot hoover up every spaced token", () => {
    const c = buildCandidates([[{ token: " ", p: 0.1 }], [{ token: " banana", p: 0.9 }]]);
    const P = alignVoice([{ token: " banana", p: 0.9 }], c);
    expect(P.get(" banana")!).toBeGreaterThan(5 * P.get(" ")!);
  });

  it("returns zeros, not NaN, when nothing lines up", () => {
    const P = alignVoice([{ token: "zzz", p: 1 }], [" a", " b"]);
    expect([...P.values()]).toEqual([0, 0]);
  });
});
