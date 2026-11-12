"use client";

import { Moon, SlidersHorizontal, Sun, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { disableAudio, enableAudio } from "@/lib/client/audio";
import { useChorus } from "@/lib/client/store";

export function Header({ showMixerButton }: { showMixerButton: boolean }) {
  const choir = useChorus((s) => s.choir);
  const mock = useChorus((s) => s.mock);
  const sound = useChorus((s) => s.sound);
  const theme = useChorus((s) => s.theme);
  const boot = useChorus((s) => s.boot);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
        <a href="." className="flex items-center gap-2.5 rounded-md" aria-label="Chorus, home">
          <Logo />
          <span className="font-serif text-[22px] leading-none tracking-tight text-ink">Chorus</span>
        </a>
        <span className="hidden text-xs text-ink-3 md:inline">consensus inference across models</span>

        <div className="ml-auto flex items-center gap-0.5 sm:gap-1.5">
          {boot === "loading" ? (
            <span className="text-xs text-ink-3">Tuning…</span>
          ) : (
            choir && <ModeBadge mode={choir.mode} note={choir.note} mock={mock} />
          )}
          <HeaderBtn
            label={sound ? "Turn sound off" : "Turn sound on: a soft note per token"}
            pressed={sound}
            onClick={() => {
              if (sound) {
                disableAudio();
                useChorus.setState({ sound: false });
              } else {
                useChorus.setState({ sound: enableAudio() });
              }
            }}
          >
            {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
          </HeaderBtn>
          <HeaderBtn
            label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => {
              const t = theme === "dark" ? "light" : "dark";
              document.documentElement.setAttribute("data-theme", t);
              try {
                localStorage.setItem("chorus-theme", t);
              } catch {
                /* private mode */
              }
              useChorus.setState({ theme: t });
            }}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </HeaderBtn>
          {showMixerButton && (
            <HeaderBtn label="Open the mixer" onClick={() => useChorus.setState({ mixerSheet: true })}>
              <SlidersHorizontal size={17} />
            </HeaderBtn>
          )}
        </div>
      </div>
    </header>
  );
}

function HeaderBtn({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`grid size-9 place-items-center sm:size-10 rounded-md transition-colors hover:bg-raised hover:text-ink ${pressed ? "text-accent" : "text-ink-2"}`}
    >
      {children}
    </button>
  );
}

function ModeBadge({ mode, note, mock }: { mode: "demo" | "live"; note?: string; mock: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const live = mode === "live";
  return (
    <div ref={ref} className="relative flex items-center gap-1.5">
      {mock && <span className="rounded border border-dashed border-ink-3 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-2" title="Mock data: the scripted in-browser choir is performing">
          mock<span className="hidden sm:inline"> data</span>
        </span>}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium ${live ? "border-ok/50 text-ok" : "border-accent/50 text-accent"}`}
      >
        <span className={`size-1.5 rounded-full ${live ? "bg-ok" : "bg-accent"}`} aria-hidden="true" />
        {live ? "Live" : "Demo"}
        <span className="hidden sm:inline">choir</span>
      </button>
      {open && (
        <div role="dialog" aria-label="About this choir" className="absolute right-0 top-10 z-40 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-line-strong bg-raised p-3 text-sm text-ink-2 shadow-[0_12px_32px_rgb(0_0_0/0.3)]">
          <p className="font-medium text-ink">{live ? "Live: real models via OpenRouter" : "Demo: simulated voices"}</p>
          <p className="mt-1 leading-snug">
            {note ?? (live ? "Each token is decided by real model calls. Calls cost money and take longer." : "The voices are simulated, so it runs instantly and costs nothing.")}
          </p>
        </div>
      )}
    </div>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">
      <g fill="none" strokeWidth="4" strokeLinecap="round">
        <path d="M10 16 C28 16 32 32 50 32" stroke="var(--v0)" />
        <path d="M10 32 L50 32" stroke="var(--v1)" />
        <path d="M10 48 C28 48 32 32 50 32" stroke="var(--v2)" />
      </g>
      <circle cx="51" cy="32" r="7" fill="var(--accent)" />
    </svg>
  );
}
