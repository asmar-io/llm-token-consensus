import type { ChoirInfo, PerformEvent, PerformRequest } from "@/lib/protocol";
import { MOCK_CHOIR, mockPerform } from "./mock";

/** Reads `data: <json>\n\n` frames from a fetch body, tolerating frames split across chunks. */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<PerformEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frame = /\r?\n\r?\n/;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = frame.exec(buf))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseFrame(raw);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    const tail = parseFrame(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw: string): PerformEvent | null {
  const data = raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data.trim()) return null;
  try {
    return JSON.parse(data) as PerformEvent;
  } catch {
    return null;
  }
}

export async function fetchChoir(timeoutMs = 4000): Promise<ChoirInfo> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/choir", { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`GET /api/choir answered ${res.status}`);
    const info = (await res.json()) as ChoirInfo;
    if (!info || !Array.isArray(info.voices) || !info.defaults) throw new Error("GET /api/choir returned an unexpected shape");
    return info;
  } finally {
    clearTimeout(t);
  }
}

export { MOCK_CHOIR };

export async function* perform(req: PerformRequest, signal: AbortSignal, useMock: boolean): AsyncGenerator<PerformEvent> {
  if (useMock) {
    yield* mockPerform(req, signal);
    return;
  }
  const res = await fetch("/api/perform", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(`The choir could not start (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  yield* readSSE(res.body);
}
