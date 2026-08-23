import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Bug,
  CheckCircle2,
  LoaderCircle,
  MessageSquareText,
  X,
} from "lucide-react";
import { ApiError, submitFeedback, type FeedbackCategory } from "../api";
import { useI18n } from "../i18n";
import { pushModal } from "../modalStack";
import { confirmAction } from "../confirmAction";

const FEEDBACK_MESSAGE_MAX = 4000;

export function FeedbackDialog({
  pagePath,
  onClose,
}: {
  pagePath: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [initialPagePath] = useState(pagePath);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  const requestCloseRef = useRef<() => void>(() => undefined);

  async function requestClose() {
    if (submitting) return;
    if (
      !submitted &&
      message.trim() &&
      !(await confirmAction(t.feedback.discardConfirm))
    ) {
      return;
    }
    onClose();
  }

  useEffect(() => {
    requestCloseRef.current = () => void requestClose();
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const releaseModal = pushModal();
    messageRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      releaseModal();
      previouslyFocused?.focus();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = message.trim();
    if (!normalized || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitFeedback({
        category,
        message: normalized,
        pagePath: initialPagePath,
      });
      setSubmitted(true);
      setMessage("");
      window.setTimeout(() => closeRef.current?.focus(), 0);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code && t.errors[cause.code]) {
        setError(t.errors[cause.code]);
      } else {
        setError(t.feedback.submitFailed);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void requestClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
        aria-describedby="feedback-dialog-description"
        className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border shadow-2xl"
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
            <MessageSquareText className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="feedback-dialog-title" className="text-lg font-semibold">
              {t.feedback.title}
            </h2>
            <p
              id="feedback-dialog-description"
              className="mt-1 text-sm leading-6"
              style={{ color: "var(--ink-mid)" }}
            >
              {t.feedback.description}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={() => void requestClose()}
            aria-label={t.feedback.close}
            title={t.feedback.close}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition hover:bg-[var(--ink-wash-strong)]"
            style={{ color: "var(--ink-mid)" }}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {submitted ? (
          <div role="status" className="px-6 py-10 text-center">
            <CheckCircle2
              className="mx-auto h-10 w-10"
              style={{ color: "var(--cinnabar)" }}
            />
            <h3 className="mt-4 text-base font-semibold">
              {t.feedback.successTitle}
            </h3>
            <p
              className="mx-auto mt-2 max-w-sm text-sm leading-6"
              style={{ color: "var(--ink-mid)" }}
            >
              {t.feedback.successDescription}
            </p>
            <button
              type="button"
              onClick={() => void requestClose()}
              className="mt-6 rounded-full px-5 py-2 text-sm font-semibold text-white transition hover:opacity-90"
              style={{ background: "var(--cinnabar)" }}
            >
              {t.feedback.done}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5 px-5 py-5 sm:px-6">
            <div>
              <p className="text-sm font-medium">{t.feedback.categoryLabel}</p>
              <div
                role="radiogroup"
                aria-label={t.feedback.categoryLabel}
                className="mt-2 grid grid-cols-2 gap-2"
              >
                {(
                  [
                    ["bug", Bug, t.feedback.categoryBug],
                    [
                      "experience",
                      MessageSquareText,
                      t.feedback.categoryExperience,
                    ],
                  ] as const
                ).map(([value, Icon, label]) => {
                  const selected = category === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setCategory(value)}
                      className="flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash)]"
                      style={{
                        borderColor: selected
                          ? "var(--cinnabar)"
                          : "var(--ink-line)",
                        background: selected
                          ? "var(--cinnabar-soft)"
                          : "transparent",
                        color: selected
                          ? "var(--cinnabar)"
                          : "var(--ink-strong)",
                      }}
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="block">
              <span className="text-sm font-medium">
                {t.feedback.messageLabel}
              </span>
              <textarea
                ref={messageRef}
                value={message}
                maxLength={FEEDBACK_MESSAGE_MAX}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t.feedback.messagePlaceholder}
                rows={7}
                className="mt-2 w-full resize-y rounded-xl border px-3.5 py-3 text-sm leading-6 outline-none transition focus:border-[var(--cinnabar)]"
                style={{
                  borderColor: "var(--ink-line)",
                  background: "var(--ink-paper-soft)",
                  color: "var(--ink-black)",
                }}
              />
              <span
                className="mt-1 flex justify-between gap-4 text-xs"
                style={{ color: "var(--ink-faint)" }}
              >
                <span>{t.feedback.privacyHint}</span>
                <span className="shrink-0 tabular-nums">
                  {message.length}/{FEEDBACK_MESSAGE_MAX}
                </span>
              </span>
            </label>

            {error && (
              <p
                role="alert"
                className="rounded-lg px-3 py-2 text-sm"
                style={{
                  background: "var(--cinnabar-soft)",
                  color: "var(--cinnabar)",
                }}
              >
                {error}
              </p>
            )}

            <div
              className="flex justify-end gap-2 border-t pt-4"
              style={{ borderColor: "var(--ink-line)" }}
            >
              <button
                type="button"
                onClick={() => void requestClose()}
                className="rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
                style={{
                  borderColor: "var(--ink-line)",
                  color: "var(--ink-strong)",
                }}
              >
                {t.feedback.cancel}
              </button>
              <button
                type="submit"
                disabled={submitting || !message.trim()}
                className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "var(--cinnabar)" }}
              >
                {submitting && (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                )}
                {submitting ? t.feedback.submitting : t.feedback.submit}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
