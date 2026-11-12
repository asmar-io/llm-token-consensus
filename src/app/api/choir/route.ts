import { connection } from "next/server";
import { getChoirInfo } from "@/engine/registry";

// Cache Components is enabled in next.config.ts, so the `dynamic` and `runtime`
// segment configs are not allowed here (Node.js is the default runtime).
// `connection()` opts this GET handler out of prerendering: the answer depends
// on the server's environment (OPENROUTER_API_KEY) and on a fresh seed.
export async function GET() {
  await connection();
  return Response.json(getChoirInfo(), { headers: { "Cache-Control": "no-store" } });
}
