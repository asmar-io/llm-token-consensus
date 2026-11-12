#!/usr/bin/env node
/**
 * Record live performances for the demo choir.
 *
 * The demo (no API key) replays real performances captured from the live
 * choir, event for event. This script captures them:
 *
 *   1. put OPENROUTER_API_KEY in .env.local and run `npm run dev`
 *   2. node scripts/record-demo.mjs            (all prompts)
 *      node scripts/record-demo.mjs 2 5        (only prompts 2 and 5, 1-based)
 *
 * Each recording is the exact PerformEvent stream of POST /api/perform, saved
 * to src/engine/demo/recordings/<n>.json. A take is kept only if it ended on
 * its own (reason "eos"); otherwise it is retried with the next seed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BASE = process.env.CHORUS_URL ?? "http://localhost:3000";
const OUT = fileURLToPath(new URL("../src/engine/demo/recordings/", import.meta.url));
const MAX_TOKENS = 120;
const ATTEMPTS = 3;

const PROMPTS = [
  "Should AI models be allowed to refuse requests? Answer in two sentences.",
  "Is it ever right to break a promise? Answer in two sentences.",
  "Who should decide what an AI is allowed to say? Answer in two sentences.",
  "Is it okay to lie to spare someone's feelings? Answer in two sentences.",
  "What do we owe future generations? Answer in two sentences.",
  "Describe the perfect city in two sentences.",
];

async function take(prompt, voices, seed) {
  const res = await fetch(`${BASE}/api/perform`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, voices, blend: "mixture", temperature: 0.7, seed, maxTokens: MAX_TOKENS }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
}

async function record(n, prompt, voices) {
  for (let a = 0; a < ATTEMPTS; a++) {
    const seed = 1000 * n + a;
    try {
      const events = await take(prompt, voices, seed);
      const done = events.find((e) => e.type === "done");
      const steps = events.filter((e) => e.type === "step");
      const answer = steps.map((e) => e.step.token).join("");
      if (done?.reason !== "eos" || steps.length < 8) {
        console.log(`[${n}] seed ${seed}: ended with ${done?.reason ?? "no done event"} after ${steps.length} tokens, retrying`);
        continue;
      }
      const file = `${OUT}${n}.json`;
      await writeFile(file, JSON.stringify({ prompt, recordedAt: new Date().toISOString(), events }) + "\n");
      console.log(`[${n}] seed ${seed}: ${steps.length} tokens, $${done.summary.costUsd.toFixed(4)}, ${Math.round(done.summary.elapsedMs / 1000)} s\n    ${answer}`);
      return true;
    } catch (err) {
      console.log(`[${n}] seed ${seed}: ${err.message}`);
    }
  }
  console.log(`[${n}] FAILED after ${ATTEMPTS} attempts`);
  return false;
}

const choir = await (await fetch(`${BASE}/api/choir`)).json();
if (choir.mode !== "live") {
  console.error("The server is not in live mode. Set OPENROUTER_API_KEY in .env.local and restart `npm run dev`.");
  process.exit(1);
}
const ids = choir.defaultVoices ?? choir.voices.map((v) => v.id);
const voices = ids.map((id) => ({ id, weight: 1 }));
console.log(`Recording with: ${ids.join(", ")}`);
await mkdir(OUT, { recursive: true });

const only = process.argv.slice(2).map(Number).filter(Boolean);
const jobs = PROMPTS.map((p, i) => [i + 1, p]).filter(([n]) => only.length === 0 || only.includes(n));
const results = await Promise.all(jobs.map(([n, p]) => record(n, p, voices)));
process.exit(results.every(Boolean) ? 0 : 1);
