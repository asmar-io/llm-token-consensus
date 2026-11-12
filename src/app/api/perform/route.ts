import { perform, validateRequest } from "@/engine/perform";
import { currentMode, resolveVoices } from "@/engine/registry";
import { replay } from "@/engine/demo";
import type { PerformEvent } from "@/lib/protocol";

// Cache Components is enabled in next.config.ts, so the `dynamic` and `runtime`
// segment configs are not allowed (Node.js is the default runtime). POST route
// handlers are never prerendered or cached.

const bad = (error: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error, ...extra }, { status: 400, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("Body must be valid JSON.");
  }
  const v = validateRequest(body);
  if (!v.ok) return bad(v.error);
  const request = v.request;

  // Demo: replay a recorded live performance. Live: resolve the chosen voices.
  const mode = currentMode();
  const resolved = mode === "live" ? resolveVoices(request.voices.map((x) => x.id)) : null;
  if (resolved && !resolved.ok) return bad(resolved.error, { unknownVoices: resolved.unknown });
  if (resolved && resolved.voices.length < 2) return bad("Pick at least two voices: a choir of one has nothing to blend.");

  // Client disconnect: Next aborts req.signal, and the stream's cancel() runs.
  // Either one aborts every in-flight voice call and ends the generator.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (req.signal.aborted) ac.abort();
  else req.signal.addEventListener("abort", onAbort, { once: true });

  const gen = resolved?.ok ? perform(request, resolved.voices, ac.signal, { mode: "live" }) : replay(request, ac.signal);
  const encoder = new TextEncoder();
  const frame = (e: PerformEvent) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`);
  let finished = false;
  const finish = () => {
    finished = true;
    req.signal.removeEventListener("abort", onAbort);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const { value, done } = await gen.next();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(frame(value));
      } catch (e) {
        finish();
        try {
          controller.enqueue(
            frame({ type: "error", fatal: true, message: `Engine error: ${e instanceof Error ? e.message : String(e)}` }),
          );
          controller.close();
        } catch {
          // stream already cancelled
        }
      }
    },
    async cancel() {
      ac.abort();
      finish();
      try {
        await gen.return(undefined);
      } catch {
        // generator already finished
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
