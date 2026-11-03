import { useEffect, useRef, type ReactNode } from "react";
import { isOnlyModalOpen, pushModal } from "../../modalStack";

/** Shared editor sheet. Nested change previews handle their own Escape key. */
export function AgentReviewSheet({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const release = pushModal();
    const opener = document.activeElement;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        isOnlyModalOpen() &&
        !event.isComposing
      ) {
        event.preventDefault();
        close.current();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      release();
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className="fixed inset-0 top-14 z-[55] bg-black/20 backdrop-blur-[1px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed bottom-0 right-0 top-14 z-[60] flex w-full flex-col border-l shadow-2xl sm:max-w-[36rem]"
        style={{
          borderColor: "var(--ink-line)",
          background: "var(--ink-paper)",
          color: "var(--ink-black)",
        }}
      >
        {children}
      </aside>
    </>
  );
}
