#!/usr/bin/env node
/**
 * Live smoke test for the OpenRouter voices. No dependencies, no TypeScript.
 *
 *   OPENROUTER_API_KEY=sk-or-... node scripts/live-smoke.mjs
 *   OPENROUTER_API_KEY=... CHORUS_MODELS=a/b,c/d node scripts/live-smoke.mjs
 *
 * For each model (CHORUS_MODELS, else DEFAULT_CHOIR read from
 * src/engine/voices/catalog.ts) it sends the same request shape the adapter
 * sends: chat completions, assistant prefill, max_tokens 1, logprobs,
 * top_logprobs 20, provider.require_parameters. It prints HTTP status,
 * whether logprobs came back, the top 5 candidates, latency and cost, and
 *   PASS  = HTTP 200, >= 5 top_logprobs, and the prefill was CONTINUED
 *           (top candidate is " Paris": a model that opened a new turn would
 *           start with "The ..." instead).
 * A second request ("... is Paris.") shows how this provider reports the
 * end-of-turn token (informational: the adapter maps it to EOS).
 * Costs a few hundredths of a cent per model. Exit code 1 if any FAIL.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL_ = "https://openrouter.ai/api/v1/chat/completions";
const KEY = process.env.OPENROUTER_API_KEY;
const TIMEOUT_MS = 30_000;
const PROMPT = "What is the capital of France? Answer in one sentence.";
const PREFILL = "The capital of France is";

if (!KEY) {
  console.error("OPENROUTER_API_KEY is not set. Usage: OPENROUTER_API_KEY=... node scripts/live-smoke.mjs");
  process.exit(2);
}

function models() {
  const env = (process.env.CHORUS_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length) return [...new Set(env)];
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "engine", "voices", "catalog.ts"), "utf8");
  const block = src.slice(src.indexOf("export const DEFAULT_CHOIR"), src.indexOf("export const KNOWN_MODELS"));
  const ids = [...block.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (!ids.length) throw new Error("could not read DEFAULT_CHOIR ids from catalog.ts");
  return ids;
}

async function nextToken(model, prefill) {
  const messages = [{ role: "user", content: PROMPT }];
  if (prefill) messages.push({ role: "assistant", content: prefill });
  const body = {
    model,
    messages,
    max_tokens: 1,
    logprobs: true,
    top_logprobs: 20,
    stream: false,
    provider: { require_parameters: true, allow_fallbacks: true },
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { status: 0, json: null, text: String(err?.message ?? err), ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

const show = (s) => JSON.stringify(s);
const pct = (lp) => (100 * Math.exp(lp)).toFixed(2).padStart(6) + "%";

let failures = 0;
for (const model of models()) {
  console.log(`\n=== ${model}`);
  const r = await nextToken(model, PREFILL);
  const err = r.json?.error ?? r.json?.choices?.[0]?.error;
  const choice = r.json?.choices?.[0];
  const entry = choice?.logprobs?.content?.[0];
  const top = entry?.top_logprobs ?? [];
  console.log(`HTTP ${r.status}   provider: ${r.json?.provider ?? "?"}   latency: ${r.ms} ms`);
  if (err || r.status !== 200) console.log(`error: ${err?.message ?? r.text.slice(0, 300)}`);
  console.log(`finish_reason: ${choice?.finish_reason ?? "-"}   content: ${show(choice?.message?.content ?? null)}`);
  console.log(`logprobs: ${entry ? "yes" : "NO"}   top_logprobs: ${top.length}   bytes field: ${entry ? (Array.isArray(entry.bytes) ? "yes" : "null") : "-"}`);
  for (const c of top.slice(0, 5)) console.log(`   ${pct(c.logprob)}  ${show(c.token)}`);
  const u = r.json?.usage;
  if (u) console.log(`usage: in ${u.prompt_tokens} / out ${u.completion_tokens}   cost: $${u.cost ?? "?"}`);

  const continued = top.length > 0 && /^\s+Paris/.test(top[0].token);
  const ok = r.status === 200 && !err && top.length >= 5 && continued;
  const why = [];
  if (r.status !== 200 || err) why.push("request failed");
  if (r.status === 200 && !entry) why.push("no logprobs returned");
  if (entry && top.length < 5) why.push(`only ${top.length} top_logprobs`);
  if (top.length && !continued) why.push(`prefill not continued? top-1 is ${show(top[0].token)}, expected " Paris"`);
  console.log(ok ? "PASS" : `FAIL: ${why.join("; ")}`);
  if (!ok) failures++;

  if (r.status === 200 && entry) {
    const e = await nextToken(model, `${PREFILL} Paris.`);
    const c2 = e.json?.choices?.[0];
    const t2 = c2?.logprobs?.content?.[0]?.top_logprobs ?? [];
    console.log(`end-of-turn probe (prefill "... is Paris."): HTTP ${e.status}, finish_reason ${c2?.finish_reason ?? "-"}, content ${show(c2?.message?.content ?? null)}, entries ${c2?.logprobs?.content?.length ?? 0}`);
    for (const c of t2.slice(0, 3)) console.log(`   ${pct(c.logprob)}  ${show(c.token)}  bytes=${show(c.bytes)}`);
    if (e.json?.usage?.cost != null) console.log(`   cost: $${e.json.usage.cost}`);
  }
}
console.log(`\n${failures ? `${failures} model(s) FAILED` : "all models PASSED"}`);
process.exit(failures ? 1 : 0);
