import { Keyboard, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { detectEditorShortcutPlatform } from "./editor/editorShortcuts";
import { isDesktopRuntime } from "../desktop/runtime";
import { useI18n } from "../i18n";
import { pushModal } from "../modalStack";

type Shortcut = {
  label: string;
  alternatives: string[][];
  desktopOnly?: boolean;
};

type ShortcutGroup = {
  title: string;
  hint?: string;
  shortcuts: Shortcut[];
};

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const groups = useMemo<ShortcutGroup[]>(() => {
    const desktop = isDesktopRuntime();
    const mac =
      detectEditorShortcutPlatform(navigator.platform, navigator.userAgent) ===
      "mac";
    const primary = mac ? "⌘" : "Ctrl";
    const control = mac ? "⌃" : "Ctrl";
    const shift = mac ? "⇧" : "Shift";

    const allGroups: ShortcutGroup[] = [
      {
        title: t.keyboardShortcuts.searchAndNavigation,
        shortcuts: [
          {
            label: t.keyboardShortcuts.actions.showKeyboardShortcuts,
            alternatives: [[primary, "/"]],
          },
          {
            label: t.keyboardShortcuts.actions.searchDocuments,
            alternatives: [[primary, "K"]],
          },
          {
            label: t.keyboardShortcuts.actions.quickOpen,
            alternatives: [[primary, "P"]],
            desktopOnly: true,
          },
          {
            label: t.keyboardShortcuts.actions.searchAllDocuments,
            alternatives: [[primary, shift, "F"]],
            desktopOnly: true,
          },
          {
            label: t.keyboardShortcuts.actions.findInDocument,
            alternatives: [[primary, "F"]],
          },
          {
            label: t.keyboardShortcuts.actions.previousDocument,
            alternatives: [[control, shift, "Tab"]],
            desktopOnly: true,
          },
          {
            label: t.keyboardShortcuts.actions.nextDocument,
            alternatives: [[control, "Tab"]],
            desktopOnly: true,
          },
          {
            label: t.keyboardShortcuts.actions.selectTab,
            alternatives: [[primary, "1–9"]],
            desktopOnly: true,
          },
        ],
      },
      {
        title: t.keyboardShortcuts.documents,
        shortcuts: [
          {
            label: t.keyboardShortcuts.actions.newDocument,
            alternatives: [[primary, "N"]],
            desktopOnly: true,
          },
          {
            label: t.keyboardShortcuts.actions.saveDocument,
            alternatives: [[primary, "S"]],
          },
          {
            label: t.keyboardShortcuts.actions.closeDocument,
            alternatives: [[primary, "W"]],
            desktopOnly: true,
          },
        ],
      },
      {
        title: t.keyboardShortcuts.panels,
        hint: t.keyboardShortcuts.panelHint,
        shortcuts: [
          {
            label: t.keyboardShortcuts.actions.toggleDocumentsPanel,
            alternatives: [[primary, "B"]],
            desktopOnly: true,
          },
          {
            label: t.keyboardShortcuts.actions.toggleOutlinePanel,
            alternatives: [[primary, "\\"]],
            desktopOnly: true,
          },
        ],
      },
      {
        title: t.keyboardShortcuts.editing,
        shortcuts: [
          {
            label: t.keyboardShortcuts.actions.undo,
            alternatives: [[primary, "Z"]],
          },
          {
            label: t.keyboardShortcuts.actions.redo,
            alternatives: mac
              ? [[primary, shift, "Z"]]
              : [[primary, "Y"], [primary, shift, "Z"]],
          },
          {
            label: t.keyboardShortcuts.actions.bold,
            alternatives: [[primary, "B"]],
          },
          {
            label: t.keyboardShortcuts.actions.italic,
            alternatives: [[primary, "I"]],
          },
        ],
      },
    ];

    return allGroups
      .map((group) => ({
        ...group,
        shortcuts: group.shortcuts.filter(
          (shortcut) => desktop || !shortcut.desktopOnly,
        ),
      }))
      .filter((group) => group.shortcuts.length > 0);
  }, [t]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const releaseModal = pushModal();
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      releaseModal();
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        className="max-h-[min(82vh,50rem)] w-full max-w-3xl overflow-hidden rounded-2xl border shadow-2xl"
        style={{
          borderColor: "var(--ink-line)",
          background: "var(--ink-paper)",
          color: "var(--ink-black)",
        }}
      >
        <header
          className="flex items-start gap-3 border-b px-5 py-4 sm:px-6"
          style={{ borderColor: "var(--ink-line)" }}
        >
          <span
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{
              background: "var(--ink-wash-strong)",
              color: "var(--cinnabar)",
            }}
          >
            <Keyboard className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="keyboard-shortcuts-title" className="text-lg font-semibold">
              {t.keyboardShortcuts.title}
            </h2>
            <p
              className="mt-1 text-sm leading-6"
              style={{ color: "var(--ink-mid)" }}
            >
              {t.keyboardShortcuts.description}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t.keyboardShortcuts.close}
            title={t.keyboardShortcuts.close}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition hover:bg-[var(--ink-wash-strong)]"
            style={{ color: "var(--ink-mid)" }}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[calc(min(82vh,50rem)-6rem)] overflow-y-auto px-5 py-5 sm:px-6">
          <div className="grid gap-6 md:grid-cols-2">
            {groups.map((group) => (
              <section key={group.title}>
                <h3 className="text-sm font-semibold">{group.title}</h3>
                {group.hint && (
                  <p
                    className="mt-1 text-xs leading-5"
                    style={{ color: "var(--ink-faint)" }}
                  >
                    {group.hint}
                  </p>
                )}
                <dl
                  className="mt-2 divide-y"
                  style={{ borderColor: "var(--ink-line)" }}
                >
                  {group.shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.label}
                      className="flex min-h-11 items-center justify-between gap-4 py-2"
                    >
                      <dt className="text-sm" style={{ color: "var(--ink-mid)" }}>
                        {shortcut.label}
                      </dt>
                      <dd className="flex shrink-0 items-center gap-1.5">
                        {shortcut.alternatives.map((keys, index) => (
                          <span
                            key={keys.join("+")}
                            className="flex items-center gap-1"
                          >
                            {index > 0 && (
                              <span
                                className="px-0.5 text-xs"
                                style={{ color: "var(--ink-faint)" }}
                              >
                                {t.keyboardShortcuts.or}
                              </span>
                            )}
                            {keys.map((key) => (
                              <kbd
                                key={key}
                                className="inline-flex min-w-6 items-center justify-center rounded-md border px-1.5 py-0.5 font-mono text-xs shadow-sm"
                                style={{
                                  borderColor: "var(--ink-line)",
                                  background: "var(--ink-paper-soft)",
                                  color: "var(--ink-strong)",
                                }}
                              >
                                {key}
                              </kbd>
                            ))}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
