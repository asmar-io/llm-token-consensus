"use client";

import { EOS, type PerformRequest } from "@/lib/protocol";
import { playNote } from "./audio";
import { heatOf, showToken } from "./format";
import { makeLookup } from "./palette";
import { perform } from "./sse";
import { buildVoiceWeights, getActiveTake, selectedVoices, singingCount, useChorus, type Take } from "./store";
import { computeSummary } from "./summary";

let current: { takeId: string; ctrl: AbortController } | null = null;
let takeSeq = 0;

function newId() {
  takeSeq += 1;
  return `take-${Date.now().toString(36)}-${takeSeq}`;
}

export function isRunning() {
  return current != null;
}

export function stop() {
  current?.ctrl.abort();
}

/** Start a fresh performance of the prompt (Take 1 of a new piece). */
export function performPrompt(promptIn?: string) {
  const s = useChorus.getState();
  const prompt = (promptIn ?? s.prompt).trim();
  if (!prompt || !s.choir) return;
  if (singingCount(s) === 0) return;
  const req: PerformRequest = {
    ...s.settings,
    prompt,
    voices: buildVoiceWeights(s),
  };
  run(req, { reset: true });
}

/** Branch a new take from `index` of take `fromId`, forcing `token` there. */
export function fork(fromId: string, index: number, token: string) {
  const s = useChorus.getState();
  const from = s.takes.find((t) => t.id === fromId);
  if (!from || !s.choir) return;
  if (!canFork(from)) return;
  if (singingCount(s) === 0) return;
  const prefixSteps = from.steps.slice(0, index);

  if (token === EOS) {
    // "End here": nothing to compute, the take simply stops at this point.
    stop();
    const t: Take = {
      ...baseTake(from.prompt, from),
      steps: prefixSteps,
      status: "finished",
      reason: "eos",
      parentId: from.id,
      forkIndex: index,
      forkToken: EOS,
      endedAt: Date.now(),
      summary: computeSummary(prefixSteps, from.voices.map((v) => v.id)),
    };
    useChorus.getState().addTake(t, false);
    useChorus.setState({ selected: index > 0 ? index - 1 : null, announce: `Take ${t.n} ends at step ${index}.` });
    return;
  }

  const req: PerformRequest = {
    ...s.settings,
    prompt: from.prompt,
    voices: buildVoiceWeights(s),
    prefix: prefixSteps.map((st) => st.token),
    forcedNext: token,
  };
  run(req, { reset: false, parent: from, forkIndex: index, forkToken: token, prefixSteps });
  useChorus.setState({ selected: index, panel: "inspector" });
}

/** A recorded demo take cannot fork: that needs live model calls. (The in-browser mock can.) */
export function canFork(t: Pick<Take, "mode" | "mock">): boolean {
  return t.mode === "live" || t.mock;
}

/** Run the same request again (after an error). */
export function retry(takeId: string) {
  const s = useChorus.getState();
  const t = s.takes.find((x) => x.id === takeId);
  if (!t?.request) return;
  const parent = t.parentId ? s.takes.find((x) => x.id === t.parentId) : undefined;
  run(t.request, {
    reset: !t.parentId,
    replaceId: t.id,
    parent,
    forkIndex: t.forkIndex,
    forkToken: t.forkToken,
    prefixSteps: t.forkIndex != null ? t.steps.slice(0, t.forkIndex) : [],
  });
}

function baseTake(prompt: string, parent?: Take): Take {
  const s = useChorus.getState();
  const n = parent ? s.takes.length + 1 : 1;
  return {
    id: newId(),
    n,
    prompt,
    request: null,
    voices: parent?.voices ?? selectedVoices(s),
    steps: [],
    status: "connecting",
    notices: [],
    startedAt: Date.now(),
    mode: s.choir?.mode ?? "demo",
    mock: s.mock,
  };
}

interface RunOpts {
  reset: boolean;
  replaceId?: string;
  parent?: Take;
  forkIndex?: number;
  forkToken?: string;
  prefixSteps?: Take["steps"];
}

async function run(req: PerformRequest, o: RunOpts) {
  stop();
  const store = useChorus.getState();
  const useMock = store.mock;

  let take: Take;
  if (o.replaceId) {
    const old = store.takes.find((t) => t.id === o.replaceId)!;
    take = { ...old, steps: o.prefixSteps ?? [], status: "connecting", error: undefined, reason: undefined, summary: undefined, notices: [], startedAt: Date.now(), endedAt: undefined };
    store.updateTake(old.id, () => take);
    useChorus.setState({ activeTakeId: old.id, replay: null });
  } else {
    take = {
      ...baseTake(req.prompt, o.parent),
      request: req,
      steps: o.prefixSteps ?? [],
      parentId: o.parent?.id,
      forkIndex: o.forkIndex,
      forkToken: o.forkToken,
    };
    store.addTake(take, o.reset);
    if (o.reset) useChorus.setState({ selected: null, hover: null });
  }

  const ctrl = new AbortController();
  current = { takeId: take.id, ctrl };
  const id = take.id;
  useChorus.setState({ announce: o.forkIndex != null ? `Take ${take.n}: forking at step ${o.forkIndex + 1}.` : "Connecting to the choir." });
  let lookup = makeLookup(take.voices);
  let gotDone = false;

  try {
    for await (const ev of perform(req, ctrl.signal, useMock)) {
      const st = useChorus.getState();
      if (ev.type === "start") {
        const voices = ev.voices?.length ? ev.voices : take.voices;
        lookup = makeLookup(voices);
        st.updateTake(id, (t) => ({ ...t, voices, status: "performing", mode: ev.mode ?? t.mode }));
        useChorus.setState({ announce: "The choir is performing." });
      } else if (ev.type === "step") {
        if (!ev.step || typeof ev.step.index !== "number") continue;
        st.pushStep(id, ev.step);
        if (st.sound) playNote(lookup.index(ev.step.lead), heatOf(ev.step.agreement));
      } else if (ev.type === "error") {
        if (ev.fatal) {
          st.updateTake(id, (t) => ({ ...t, status: "error", error: ev.message || "The performance failed.", endedAt: Date.now() }));
          useChorus.setState({ announce: `The performance failed: ${ev.message}` });
          gotDone = true;
          break;
        }
        st.updateTake(id, (t) => ({ ...t, notices: [...t.notices, { voiceId: ev.voiceId, message: ev.message }] }));
      } else if (ev.type === "done") {
        gotDone = true;
        const reason = ev.reason;
        st.updateTake(id, (t) => ({
          ...t,
          status: reason === "aborted" ? "stopped" : "finished",
          reason,
          summary: ev.summary,
          endedAt: Date.now(),
        }));
        const t = useChorus.getState().takes.find((x) => x.id === id);
        const n = t?.steps.length ?? 0;
        useChorus.setState({
          announce:
            reason === "eos"
              ? `Finished. The choir chose to end after ${n} tokens.`
              : reason === "max_tokens"
                ? `Finished at the ${n}-token limit.`
                : `Stopped after ${n} tokens.`,
        });
        break;
      }
    }
    if (!gotDone && !ctrl.signal.aborted) {
      useChorus.getState().updateTake(id, (t) => ({ ...t, status: "error", error: "The stream ended before the choir said it was done.", endedAt: Date.now() }));
    }
  } catch (err) {
    const aborted = ctrl.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
    if (!aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      useChorus.getState().updateTake(id, (t) => ({ ...t, status: "error", error: msg, endedAt: Date.now() }));
      useChorus.setState({ announce: `The performance failed: ${msg}` });
    }
  } finally {
    if (ctrl.signal.aborted) {
      useChorus.getState().updateTake(id, (t) =>
        t.status === "performing" || t.status === "connecting"
          ? { ...t, status: "stopped", reason: "aborted", endedAt: Date.now(), summary: computeSummary(t.steps, t.voices.map((v) => v.id)) }
          : t,
      );
      const t = useChorus.getState().takes.find((x) => x.id === id);
      if (t?.status === "stopped") useChorus.setState({ announce: `Stopped by you after ${t.steps.length} tokens.` });
    }
    if (current?.ctrl === ctrl) current = null;
  }
}

/** The fork target for the F key: the best alternative that was not chosen. */
export function forkTopAlternative() {
  const s = useChorus.getState();
  const take = getActiveTake(s);
  if (!take || s.selected == null) return;
  const step = take.steps[s.selected];
  if (!step) return;
  const alt = step.alternatives.find((a) => a.token !== step.token);
  if (alt) fork(take.id, step.index, alt.token);
}

export function describeFork(t: Take): string {
  if (t.forkIndex == null) return "";
  return `from step ${t.forkIndex + 1}, “${showToken(t.forkToken)}”`;
}
