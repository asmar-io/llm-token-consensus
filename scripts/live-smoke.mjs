#!/usr/bin/env node
/**
 * Live smoke test for the OpenRouter voices. No dependencies, no TypeScript.
 *
 *   OPENROUTER_API_KEY=sk-or-... node scripts/live-smoke.mjs
 *   OPENROUTER_API_KEY=... node scripts/live-smoke.mjs "moonshotai/kimi-k2.6@moonshotai!partial!noreason" ...
 *   ONLY=count,midword ...   run a subset of the checks
 *
 * With no arguments the default choir (ids + routes) is read from
 * src/engine/voices/catalog.ts. A voice argument is
 *   <model slug>@<provider tag>[|<provider tag>...][!partial][!noreason][!top5]
 *
 * The request logic duplicates src/engine/voices/openrouter.ts (keep in sync):
 * chat completions, assistant prefill (optionally `partial: true`), max_tokens 1,
 * logprobs, top_logprobs 20 (5 with !top5), temperature 0, provider pinned with
 * order + allow_fallbacks false + require_parameters, trailing whitespace held
 * back, token healing for a text ending mid-word, EOS mapping.
 *
 * Checks (each must hold for PASS):
 *   count     "Count from one to ten in words..."  so far "one two three four"           -> top " five"
 *   midword   "What is the capital of France?"     so far "The capital of France is Par" -> top "is"
 *   countEnd  so far "one two three four five six seven eight nine ten"               -> top EOS, p > 0.5
 *   parisEnd  so far "The capital of France is Paris."                                 -> top EOS, p > 0.5
 *   trailing  so far "one two three four " (trailing space)                            -> top "five"
 *   emoji     (informational, not gating) first token of "🦩" = a split character -> "🦩"
 *   arabic    "ما هي عاصمة فرنسا؟"  so far "عاصمة فرنسا هي"  -> top is " باريس" or a prefix of it
 * Exit code 1 if any voice fails.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL_ = "https://openrouter.ai/api/v1/chat/completions";
const KEY = process.env.OPENROUTER_API_KEY;
const EOS = "<|eos|>";
const TIMEOUT_MS = 20_000;

if (!KEY) {
  console.error("OPENROUTER_API_KEY is not set. Usage: OPENROUTER_API_KEY=... node scripts/live-smoke.mjs");
  process.exit(2);
}

// ---------------------------------------------------------------- voices
function parseSpec(s) {
  const [main, ...flags] = s.split("!");
  const [id, tags = ""] = main.split("@");
  return { id, providers: tags ? tags.split("|") : [], partial: flags.includes("partial"), reasoningOff: flags.includes("noreason"), topLogprobs: flags.includes("top5") ? 5 : 20 };
}
function defaultVoices() {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "engine", "voices", "catalog.ts"), "utf8");
  // Every verified model: DEFAULT_CHOIR plus the further entries of KNOWN_MODELS.
  const block = src.slice(src.indexOf("export const DEFAULT_CHOIR"), src.indexOf("export function labelFromSlug"));
  const out = [];
  for (const entry of block.split(/\n  \{/).slice(1)) {
    const id = entry.match(/\bid:\s*"([^"]+)"/)?.[1];
    const route = entry.match(/\broute:\s*\{([^}]*)\}/)?.[1] ?? "";
    const providers = [...(route.match(/providers:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (!id) continue;
    out.push({ id, providers, partial: /partial:\s*true/.test(route), reasoningOff: /reasoningOff:\s*true/.test(route), topLogprobs: Number(route.match(/topLogprobs:\s*(\d+)/)?.[1] ?? 20) });
  }
  if (!out.length) throw new Error("could not read DEFAULT_CHOIR from catalog.ts");
  return out;
}

// ---------------------------------------------------------------- helpers (mirror openrouter.ts)
const END_TOKENS = new Set(["<|eot_id|>", "<|eom_id|>", "<|end_of_text|>", "<|im_end|>", "<|endoftext|>", "</s>", "<|end|>", "<|return|>", "<end_of_turn>", "<eos>", "<|end▁of▁sentence|>", "<｜end▁of▁sentence｜>"]);
const SPECIAL = /^(<\|[^<>|\s]+\|>|<｜[^<>\s]+｜>|<(start|end)_of_[a-z_]+>)$/;
const WORD_TAIL = /\s*[\p{L}\p{M}\p{N}]+$/u;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const valid = (t) => !t.includes("�") && !LONE.test(t) && !t.startsWith("bytes:") && !/^token:\d+$/.test(t);
function candidateText(c) {
  const t = c.token ?? "";
  if (valid(t)) return t; // token string is authoritative; bytes only repair it
  if (Array.isArray(c.bytes) && c.bytes.length && c.bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    try { const s = utf8.decode(new Uint8Array(c.bytes)); return valid(s) ? s : null; } catch { return null; }
  }
  return null;
}
function classify(c) {
  const tok = c.token ?? "";
  if (END_TOKENS.has(tok) || tok === "") return { kind: "eos" };
  if (SPECIAL.test(tok)) return { kind: "drop" };
  const t = candidateText(c);
  if (t === null) return { kind: "partial" };
  return t === "" ? { kind: "eos" } : { kind: "text", text: t };
}
function finalize(list) {
  const m = new Map();
  for (const { token, p } of list) if (p > 0) m.set(token, (m.get(token) ?? 0) + p);
  return [...m].map(([token, p]) => ({ token, p })).sort((a, b) => b.p - a.p).slice(0, 20);
}
function firstUnit(s) {
  const chars = Array.from(s);
  const i = chars.findIndex((ch) => ch.codePointAt(0) > 0x7f);
  return i >= 0 ? chars.slice(0, i + 1).join("") : null;
}

async function post(voice, ctx, prefill, maxTokens, stat) {
  const messages = [{ role: "user", content: ctx.prompt }];
  if (prefill) messages.push(voice.partial ? { role: "assistant", content: prefill, partial: true } : { role: "assistant", content: prefill });
  const body = { model: voice.id, messages, max_tokens: maxTokens, logprobs: true, top_logprobs: voice.topLogprobs, temperature: 0, stream: false, provider: voice.providers.length ? { order: voice.providers, allow_fallbacks: false, require_parameters: true } : { require_parameters: true } };
  if (voice.reasoningOff) body.reasoning = { enabled: false };
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let res, j;
    try {
      res = await fetch(URL_, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      j = await res.json().catch(() => ({}));
    } catch (e) {
      if (attempt === 0) continue;
      throw new Error(`network/timeout: ${e.message}`);
    }
    stat.ms.push(performance.now() - t0); stat.requests++;
    const err = j.error ?? j.choices?.[0]?.error;
    if (!res.ok || err) {
      const code = res.ok ? Number(err.code) || 500 : res.status;
      if (attempt === 0 && (code === 408 || code === 429 || code >= 500)) { stat.retries++; await new Promise((r) => setTimeout(r, 400)); continue; }
      throw new Error(`HTTP ${code}: ${err?.message ?? "?"} ${typeof err?.metadata?.raw === "string" ? err.metadata.raw.slice(0, 160) : ""}`);
    }
    if (typeof j.usage?.cost === "number") { stat.cost += j.usage.cost; stat.costSeen++; }
    if (j.provider) stat.providers.add(j.provider);
    return j;
  }
}

async function completePartial(voice, ctx, prefill, held, stat) {
  let j;
  try { j = await post(voice, ctx, prefill, 4, stat); } catch { return null; }
  const ch = j.choices?.[0];
  if (!ch?.message?.content) return null;
  const lead = /^\s+/.exec(ch.logprobs?.content?.[0]?.token ?? "")?.[0] ?? "";
  const unit = firstUnit(ch.message.content.trimStart());
  if (unit === null) return null;
  let text = lead + unit;
  if (held) { if (!text.startsWith(held) || text === held) return null; text = text.slice(held.length); }
  const lp = ch.logprobs?.content?.[0]?.logprob;
  stat.partialFollowups++;
  return { text, p: typeof lp === "number" ? Math.exp(lp) : 1 };
}

async function single(voice, ctx, prefill, held, stat) {
  let j = await post(voice, ctx, prefill, 1, stat);
  let ch = j.choices?.[0];
  if (ch && !ch.logprobs?.content?.length && ch.message?.content) {
    stat.noLogprobRetries++; // provider dropped logprobs; the adapter retries once too
    j = await post(voice, ctx, prefill, 1, stat);
    ch = j.choices?.[0];
  }
  if (!ch) throw new Error("no choices");
  const entries = ch.logprobs?.content ?? null;
  const content = ch.message?.content ?? "";
  if (!entries || !entries.length) {
    if (ch.finish_reason === "stop" && !content) { stat.eosEmpty++; return held ? { list: [], exact: 0, consistent: 0 } : { list: [{ token: EOS, p: 1 }], exact: 0, consistent: 1 }; }
    if (ch.finish_reason === "length" && !content) {
      const d = await completePartial(voice, ctx, prefill, held, stat);
      return d ? { list: [{ token: d.text, p: d.p }], exact: 0, consistent: d.p } : { list: [], exact: 0, consistent: 0 };
    }
    throw new Error(`no logprobs (finish ${ch.finish_reason}, content ${JSON.stringify(content)})`);
  }
  stat.bytes ||= Array.isArray(entries[0].bytes);
  const alts = entries[0].top_logprobs ?? [];
  if (!alts.length) throw new Error("no top_logprobs");
  const raw = alts.some((a) => a.token === entries[0].token) ? alts : [...alts, entries[0]];
  const out = { list: [], exact: 0, consistent: 0 };
  let bestPartial = -1, bestOther = -1;
  for (const a of raw) {
    const p = Math.exp(a.logprob); const c = classify(a);
    if (c.kind === "drop") continue;
    if (c.kind === "partial") { bestPartial = Math.max(bestPartial, p); continue; }
    bestOther = Math.max(bestOther, p);
    if (c.kind === "eos") { if (!held) { out.list.push({ token: EOS, p }); out.consistent += p; } continue; }
    if (!held) { out.list.push({ token: c.text, p }); out.consistent += p; }
    else if (c.text === held) { out.exact += p; out.consistent += p; }
    else if (c.text.startsWith(held)) { out.list.push({ token: c.text.slice(held.length), p }); out.consistent += p; }
  }
  if (bestPartial > bestOther) {
    const d = await completePartial(voice, ctx, prefill, held, stat);
    if (d) { out.list.push({ token: d.text, p: bestPartial }); out.consistent += bestPartial; }
  }
  return out;
}

async function nextPiece(voice, ctx, stat) {
  const so = ctx.textSoFar;
  const tailWs = /\s+$/.exec(so)?.[0] ?? "";
  const heal = tailWs ? "" : (WORD_TAIL.exec(so)?.[0] ?? "");
  let list;
  if (tailWs) {
    list = (await single(voice, ctx, so.slice(0, -tailWs.length), tailWs, stat)).list;
    if (!list.length) list = (await single(voice, ctx, so, "", stat)).list;
  } else if (heal) {
    const [a, b] = await Promise.allSettled([single(voice, ctx, so, "", stat), single(voice, ctx, so.slice(0, -heal.length), heal, stat)]);
    const comb = (A, B) => (B.consistent > 0 ? [...B.list.map((c) => ({ token: c.token, p: c.p / B.consistent })), ...A.list.map((c) => ({ token: c.token, p: (c.p * B.exact) / B.consistent }))] : A.list);
    if (a.status === "fulfilled" && b.status === "fulfilled") list = comb(a.value, b.value);
    else if (a.status === "fulfilled") { stat.healFallbacks++; list = a.value.list; }
    else if (b.status === "fulfilled" && b.value.list.length) { stat.healFallbacks++; list = comb({ list: [] }, b.value); }
    else throw a.reason;
  } else {
    list = (await single(voice, ctx, so, "", stat)).list;
  }
  const top = finalize(list);
  if (!top.length) throw new Error("no usable candidates");
  return top;
}

// ---------------------------------------------------------------- checks
const COUNT = "Count from one to ten in words, separated by spaces.";
const PARIS = "What is the capital of France? Answer in one sentence.";
const CHECKS = [
  { name: "count", prompt: COUNT, so: "one two three four", ok: (t) => t[0]?.token === " five" },
  { name: "midword", prompt: PARIS, so: "The capital of France is Par", ok: (t) => t[0]?.token === "is" || t[0]?.token.startsWith("is") },
  { name: "countEnd", prompt: COUNT, so: "one two three four five six seven eight nine ten", ok: (t) => t[0]?.token === EOS && t[0].p > 0.5 },
  { name: "parisEnd", prompt: PARIS, so: "The capital of France is Paris.", ok: (t) => t[0]?.token === EOS && t[0].p > 0.5 },
  { name: "trailing", prompt: COUNT, so: "one two three four ", ok: (t) => t[0]?.token === "five" },
  { name: "emoji", info: true, prompt: "Reply with only this emoji and nothing else: 🦩", so: "", ok: (t) => t[0]?.token.startsWith("🦩") },
  { name: "arabic", prompt: "ما هي عاصمة فرنسا؟ أجب بجملة واحدة.", so: "عاصمة فرنسا هي", ok: (t) => Boolean(t[0] && t[0].token.length > 1 && (" باريس".startsWith(t[0].token) || t[0].token.startsWith(" باريس"))) },
];

const fmt = (t) => t.slice(0, 4).map((c) => `${JSON.stringify(c.token)} ${(100 * c.p).toFixed(1)}%`).join(" | ");
const voices = process.argv.length > 2 ? process.argv.slice(2).map(parseSpec) : defaultVoices();
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
console.log(`Chorus live smoke ${new Date().toISOString()}  (${voices.length} voices)`);
let failures = 0, total = 0;
for (const v of voices) {
  const flags = [v.partial && "partial", v.reasoningOff && "reasoning off", `top_logprobs ${v.topLogprobs}`].filter(Boolean).join(", ");
  console.log(`\n=== ${v.id}  pinned to [${v.providers.join(", ") || "any"}]  (${flags})`);
  const stat = { ms: [], cost: 0, costSeen: 0, requests: 0, retries: 0, providers: new Set(), bytes: false, eosEmpty: 0, healFallbacks: 0, partialFollowups: 0, noLogprobRetries: 0 };
  let pass = true;
  for (const c of CHECKS.filter((c) => !only || only.includes(c.name))) {
    const t0 = performance.now();
    try {
      const top = await nextPiece(v, { prompt: c.prompt, textSoFar: c.so }, stat);
      const ok = c.ok(top);
      if (!c.info) pass &&= ok;
      console.log(`  ${ok ? "ok  " : c.info ? "info" : "FAIL"} ${c.name.padEnd(9)} ${String(Math.round(performance.now() - t0)).padStart(5)} ms  ${fmt(top)}`);
    } catch (err) {
      if (!c.info) pass = false;
      console.log(`  ${c.info ? "info" : "FAIL"} ${c.name.padEnd(9)} error: ${String(err.message).slice(0, 220)}`);
    }
  }
  total += stat.cost;
  const ms = [...stat.ms].sort((a, b) => a - b);
  console.log(`  served by ${[...stat.providers].join(", ") || "?"} | ${stat.requests} requests (${stat.retries} retried) | per-request latency median ${Math.round(ms[ms.length >> 1] ?? 0)} ms, max ${Math.round(ms[ms.length - 1] ?? 0)} ms`);
  console.log(`  cost $${stat.cost.toFixed(6)} (usage.cost on ${stat.costSeen}/${stat.requests}) | bytes ${stat.bytes ? "present" : "absent"} | empty-stop EOS ${stat.eosEmpty} | healing fallbacks ${stat.healFallbacks} | partial-char follow-ups ${stat.partialFollowups} | no-logprob retries ${stat.noLogprobRetries}`);
  console.log(pass ? "  PASS" : "  FAIL");
  if (!pass) failures++;
}
console.log(`\n${failures ? `${failures} of ${voices.length} voice(s) FAILED` : `all ${voices.length} voices PASSED`}  total cost $${total.toFixed(6)}`);
process.exit(failures ? 1 : 0);
