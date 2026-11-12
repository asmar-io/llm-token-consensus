/**
 * Optional sonification: a soft note per token, pitched by the lead voice,
 * with a detuned partner on contested steps so disagreement sounds rough.
 * The AudioContext is only created from a user gesture (the sound toggle).
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;

// A pentatonic set keeps any sequence of leads consonant on its own.
const PITCHES = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];

export function enableAudio(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

export function disableAudio() {
  void ctx?.suspend();
}

let lastAt = 0;

export function playNote(voiceIndex: number, heat: number) {
  if (!ctx || !master || ctx.state !== "running") return;
  const now = ctx.currentTime;
  if (now - lastAt < 0.03) return; // never pile up notes
  lastAt = now;
  const f = PITCHES[(voiceIndex < 0 ? 0 : voiceIndex) % PITCHES.length];
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(0.09, now + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  env.connect(master);

  const a = ctx.createOscillator();
  a.type = "sine";
  a.frequency.value = f;
  a.connect(env);
  a.start(now);
  a.stop(now + 0.34);

  if (heat > 0.15) {
    const b = ctx.createOscillator();
    b.type = "triangle";
    b.frequency.value = f;
    b.detune.value = 12 + heat * 38; // cents: more split, more beating
    const g = ctx.createGain();
    g.gain.value = 0.5 * heat;
    b.connect(g).connect(env);
    b.start(now);
    b.stop(now + 0.34);
  }
}
