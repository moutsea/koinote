import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { pushModal } from "../modalStack";

/** Start clipboard.write in the click/submit handler, before any asynchronous work.
 * Keep prepared credentials for a direct retry if the browser denies that write. */
export function useAgentSyncCopy(onCopied: () => void) {
  const [instructions, setInstructions] = useState<string | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function copy(prepare: () => Promise<string>) {
    if (pending.current) return;
    pending.current = true;
    const text = Promise.resolve().then(prepare).then((value) => {
      if (!mounted.current) throw new DOMException("Copy cancelled", "AbortError");
      return value;
    });
    try {
      try {
        if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
          const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
          // Some browsers reject before consuming the deferred data.
          void blob.catch(() => {});
          await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
        } else {
          const prepared = await text;
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(prepared);
        }
      } catch {
        // Preparation failures still propagate; a clipboard failure must not mint
        // another grant when the user retries the already prepared instruction.
        const prepared = await text;
        if (mounted.current) setInstructions(prepared);
        return;
      }
      if (mounted.current) onCopied();
    } finally {
      pending.current = false;
    }
  }

  return {
    copy,
    clear: () => setInstructions(null),
    dialog: instructions !== null ? <AgentSyncCopyDialog instructions={instructions}
      onClose={() => setInstructions(null)} onCopied={() => { setInstructions(null); onCopied(); }} /> : null,
  };
}

function AgentSyncCopyDialog({ instructions, onClose, onCopied }: {
  instructions: string; onClose: () => void; onCopied: () => void;
}) {
  const { t } = useI18n();
  const labels = t.space.configSnapshots;
  const primary = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const writing = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const release = pushModal();
    primary.current?.focus();
    return () => { release(); previous?.focus(); };
  }, []);
  async function retry() {
    if (writing.current) return;
    writing.current = true;
    setPending(true);
    setFailed(false);
    try {
      // No awaits before this call: it uses the fresh button gesture.
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(instructions);
      onCopied();
    } catch { setFailed(true); }
    finally { writing.current = false; setPending(false); }
  }
  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!writing.current) onClose(); }
    if (event.key === "Tab") {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), textarea"));
      if (!buttons.length) { event.preventDefault(); return; }
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      if (index < 0 || (event.shiftKey ? index === 0 : index === buttons.length - 1)) {
        event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
      }
    }
  }}>
    <section role="dialog" aria-modal="true" aria-labelledby="agent-copy-title" className="w-full max-w-md rounded-2xl border bg-[var(--background)] p-5 shadow-xl" style={{ borderColor: "var(--ink-line)" }}>
      <h2 id="agent-copy-title" className="font-semibold">{labels.syncWithAgent}</h2>
      <p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{labels.agentCopyReady}</p>
      {failed && <p role="alert" className="mt-3 text-sm" style={{ color: "var(--cinnabar)" }}>{labels.agentCopyFailed}</p>}
      <label className="mt-3 block text-sm" htmlFor="agent-copy-manual">{labels.agentCopyManual}</label>
      <textarea id="agent-copy-manual" readOnly value={instructions} onFocus={(event) => event.currentTarget.select()}
        className="mt-2 h-40 w-full resize-y rounded-lg border bg-transparent p-3 font-mono text-xs"
        style={{ borderColor: "var(--ink-line)" }} spellCheck={false} />
      <div className="mt-5 flex justify-end gap-3">
        <button type="button" disabled={pending} onClick={onClose} className="rounded-full border px-4 py-2 text-sm" style={{ borderColor: "var(--ink-line)" }}>{t.space.syncCancel}</button>
        <button ref={primary} type="button" disabled={pending} onClick={() => void retry()} className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>{labels.syncWithAgent}</button>
      </div>
    </section>
  </div>;
}
