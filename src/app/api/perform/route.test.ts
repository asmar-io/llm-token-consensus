import { beforeAll, describe, expect, it } from "vitest";
import type { PerformEvent } from "@/lib/protocol";
import { POST } from "./route";
import { DEMO_VOICE_INFOS, RECORDINGS } from "@/engine/demo";

beforeAll(() => {
  delete process.env.OPENROUTER_API_KEY;
});

const post = (body: unknown, signal?: AbortSignal) =>
  POST(new Request("http://localhost/api/perform", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), signal }));

const goodBody = {
  prompt: RECORDINGS[0].prompt,
  voices: DEMO_VOICE_INFOS.map((v) => ({ id: v.id, weight: 1 })),
  blend: "mixture",
  temperature: 0.7,
  seed: 5,
  maxTokens: 160,
};

function parseSse(text: string): PerformEvent[] {
  return text
    .split("\n\n")
    .filter((c) => c.startsWith("data: "))
    .map((c) => JSON.parse(c.slice(6)));
}

describe("POST /api/perform", () => {
  it("rejects bad bodies with a 400 JSON error before streaming", async () => {
    for (const body of ["{not json", { prompt: "" }, { ...goodBody, voices: [] }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toMatch(/json/);
      expect(typeof (await res.json()).error).toBe("string");
    }
  });

  it("streams SSE: start, steps, done", async () => {
    const res = await post(goodBody);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("cache-control")).toMatch(/no-cache/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const events = parseSse(await res.text());
    expect(events[0].type).toBe("start");
    expect(events[0].type === "start" && events[0].mode).toBe("demo");
    expect(events.filter((e) => e.type === "step").length).toBeGreaterThan(10);
    expect(events[events.length - 1].type).toBe("done");
  }, 30_000);

  it("request abort (client disconnect) ends the run with done(aborted)", async () => {
    const ac = new AbortController();
    const res = await post(goodBody, ac.signal);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    let aborted = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
      if (!aborted && text.includes('"type":"step"')) {
        aborted = true;
        ac.abort();
      }
    }
    const events = parseSse(text);
    const last = events[events.length - 1];
    expect(last.type === "done" && last.reason).toBe("aborted");
    expect(events.filter((e) => e.type === "step").length).toBeLessThan(5);
  }, 10_000);

  it("stream cancel resolves promptly (generator is shut down)", async () => {
    const res = await post(goodBody);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    const t0 = Date.now();
    await reader.cancel();
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 10_000);
});
