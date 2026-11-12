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
  it("is exact string match only: no credit between cuts of different length", () => {
    expect(overlap(" dec", " dec")).toBe(1);
    expect(overlap(" decentral", " dec")).toBe(0);
    expect(overlap(" dec", " decentral")).toBe(0);
    expect(overlap("'t", "'")).toBe(0); // "shouldn' be" regression
    expect(overlap(" can", " cans")).toBe(0); // "cans undermine trusts" regression
    expect(overlap(" dog", " dec")).toBe(0);
  });
  it("EOS only matches EOS, even against a literal prefix of the sentinel string", () => {
    expect(overlap(EOS, EOS)).toBe(1);
    expect(overlap("<|", EOS)).toBe(0);
    expect(overlap(EOS, "<|")).toBe(0);
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

  it("renormalises a voice's own tokens over the candidate set", () => {
    const P = alignVoice([{ token: " dec", p: 0.5 }, { token: EOS, p: 0.25 }], cands);
    expect(P.get(" dec")).toBeCloseTo(2 / 3);
    expect(P.get(EOS)).toBeCloseTo(1 / 3);
    expect(P.get(" decentral")).toBe(0);
    expect(P.get(" decentralised")).toBe(0);
  });

  it("one voice's rare longer token cannot borrow another voice's mass", () => {
    const c = buildCandidates([[{ token: " can", p: 0.99 }], [{ token: " cans", p: 0.01 }, { token: " can", p: 0.9 }]]);
    const P = alignVoice([{ token: " can", p: 0.99 }], c);
    expect(P.get(" can")).toBeCloseTo(1);
    expect(P.get(" cans")).toBe(0);
  });

  it("returns zeros, not NaN, when nothing lines up", () => {
    const P = alignVoice([{ token: "zzz", p: 1 }], [" a", " b"]);
    expect([...P.values()]).toEqual([0, 0]);
  });
});
