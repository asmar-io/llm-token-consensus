import { showToken } from "@/lib/client/format";

/** A token shown on its own, with visible-whitespace glyphs dimmed so the word stays the focus. */
export function TokenText({ t }: { t: string | undefined | null }) {
  const s = showToken(t);
  const parts = s.split(/([␣⏎⇥]+)/);
  if (parts.length === 1) return <>{s}</>;
  return (
    <>
      {parts.map((p, k) =>
        /^[␣⏎⇥]+$/.test(p) ? (
          <span key={k} className="font-sans text-[0.72em] font-normal text-ink-3" aria-label={p.includes("⏎") ? "newline" : p.includes("⇥") ? "tab" : "space"}>
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}
