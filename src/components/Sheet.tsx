"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";

/** Phone bottom sheet. Non-modal for the inspector (the text stays usable above it). */
export function Sheet({ open, onClose, label, children, modal = false }: { open: boolean; onClose: () => void; label: string; children: React.ReactNode; modal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && modal) ref.current?.focus();
  }, [open, modal]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {modal && (
            <motion.div
              key="scrim"
              className="fixed inset-0 z-40 bg-black/50"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={onClose}
              aria-hidden="true"
            />
          )}
          <motion.div
            key="sheet"
            ref={ref}
            role="dialog"
            aria-modal={modal || undefined}
            aria-label={label}
            tabIndex={-1}
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[62dvh] flex-col rounded-t-2xl border-t border-line-strong bg-raised shadow-[0_-12px_40px_rgb(0_0_0/0.35)] focus:outline-none"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%", transition: { duration: 0.18, ease: "easeIn" } }}
            transition={{ type: "spring", damping: 34, stiffness: 360 }}
          >
            <SheetHandle onClose={onClose} />
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function SheetHandle({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} aria-label="Close" className="flex h-6 w-full shrink-0 items-center justify-center">
      <span className="h-1 w-10 rounded-full bg-line-strong" aria-hidden="true" />
    </button>
  );
}
