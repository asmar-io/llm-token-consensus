import { describe, expect, it } from "vitest";
import type { PerformEvent, PerformRequest } from "@/lib/protocol";
import { EOS } from "@/lib/protocol";
import { DEMO_RECORDED_ON, DEMO_SAMPLE_PROMPTS, DEMO_VOICE_INFOS, RECORDINGS, matchRecording, replay } from "@/engine/demo";

const req = (prompt: string, extra: Partial<PerformRequest> = {}): PerformRequest => ({
  prompt,
  voices: DEMO_VOICE_INFOS.map((v) => ({ id: v.id, weight: 1 })),
  blend: "mixture",
  temperature: 0.7,
  seed: 1,
  maxTokens: 120,
  ...extra,
});

async function collect(r: PerformRequest, signal = new AbortController().signal): Promise<PerformEvent[]> {
  const out: PerformEvent[] = [];
  for await (const e of replay(r, signal, { stepDelayMs: 0 })) out.push(e);
  return out;
}

describe("recordings", () => {
  it("are complete, well-formed live runs", () => {
    expect(RECORDINGS.length).toBeGreaterThanOrEqual(4);
    expect(DEMO_RECORDED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(DEMO_SAMPLE_PROMPTS).size).toBe(RECORDINGS.length);
    for (const r of RECORDINGS) {
      const start = r.events[0];
      const done = r.events[r.events.length - 1];
      expect(start.type === "start" && start.mode).toBe("live");
      expect(done.type === "done" && done.reason).toBe("eos");
      const steps = r.events.flatMap((e) => (e.type === "step" ? [e.step] : []));
      expect(steps.length).toBeGreaterThan(8);
      steps.forEach((s, i) => {
        expect(s.index).toBe(i);
        expect(s.token).not.toBe(EOS);
        expect(s.token.length).toBeGreaterThan(0);
        expect(Number.isFinite(s.p) && s.p >= 0 && s.p <= 1).toBe(true);
        expect(s.agreement >= 0 && s.agreement <= 1).toBe(true);
        expect(s.alternatives.some((a) => a.token === s.token)).toBe(true);
        const share = s.ballots.reduce((a, b) => a + b.share, 0);
        expect(share).toBeCloseTo(1, 3);
      });
      expect(JSON.stringify(r)).not.toMatch(/sk-or-|Bearer /);
    }
  });

  it("only feature real, non-simulated models", () => {
    expect(DEMO_VOICE_INFOS.length).toBeGreaterThanOrEqual(2);
    expect(DEMO_VOICE_INFOS.every((v) => !v.simulated && v.id.includes("/"))).toBe(true);
  });
});

describe("replay", () => {
  it("plays a recorded prompt back step for step and marks the stream as demo", async () => {
    const rec = RECORDINGS[0];
    const events = await collect(req(rec.prompt));
    expect(events[0].type === "start" && events[0].mode).toBe("demo");
    expect(events.filter((e) => e.type === "step")).toEqual(rec.events.filter((e) => e.type === "step"));
    expect(events[events.length - 1]).toEqual(rec.events[rec.events.length - 1]);
    expect(events.some((e) => e.type === "error" && /cannot answer a new prompt/.test(e.message))).toBe(false);
  });

  it("matches prompts loosely and says so when it is not the prompt that was asked", async () => {
    const m = matchRecording("is breaking a promise ever okay?");
    expect(m.exact).toBe(false);
    expect(m.recording.prompt).toMatch(/promise/);
    const events = await collect(req("What is the boiling point of tungsten?"));
    const notice = events[1];
    expect(notice.type === "error" && !notice.fatal && /cannot answer a new prompt/.test(notice.message)).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("refuses to fork, because that needs live calls", async () => {
    const events = await collect(req(RECORDINGS[0].prompt, { prefix: ["Yes"], forcedNext: " but" }));
    const last = events[events.length - 1];
    expect(last.type === "error" && last.fatal && /live/.test(last.message)).toBe(true);
    expect(events.some((e) => e.type === "step")).toBe(false);
  });

  it("stops on abort with a summary of what was played", async () => {
    const ac = new AbortController();
    const out: PerformEvent[] = [];
    for await (const e of replay(req(RECORDINGS[0].prompt), ac.signal, { stepDelayMs: 1 })) {
      out.push(e);
      if (out.filter((x) => x.type === "step").length === 3) ac.abort();
    }
    const last = out[out.length - 1];
    expect(last.type === "done" && last.reason).toBe("aborted");
    expect(last.type === "done" && last.summary.tokens).toBe(3);
  });
});
