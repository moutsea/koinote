import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, BellRing, Languages, Send } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ApiError,
  getAdminAnnouncements,
  publishAdminAnnouncement,
  withdrawAdminAnnouncement,
} from "../api";
import { confirmAction } from "../confirmAction";
import {
  LOCALES,
  LOCALE_LABELS,
  useI18n,
  type Locale,
} from "../i18n";
import { PaperCard } from "./Ink";

const ADMIN_ANNOUNCEMENTS_KEY = ["admin-announcements"] as const;
const FIELD_CLASS =
  "w-full rounded-xl border px-3.5 py-2.5 text-sm outline-none transition focus:ring-2 focus:ring-black/5 dark:focus:ring-white/10";
const FIELD_STYLE = {
  borderColor: "var(--ink-line)",
  background: "var(--ink-paper)",
};

export function AnnouncementAdminPanel() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [sourceLocale, setSourceLocale] = useState<Locale>(locale);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [highlights, setHighlights] = useState("");
  const [success, setSuccess] = useState(false);
  const announcements = useQuery({
    queryKey: ADMIN_ANNOUNCEMENTS_KEY,
    queryFn: getAdminAnnouncements,
    retry: false,
  });
  const lines = useMemo(
    () =>
      highlights
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [highlights],
  );
  const publish = useMutation({
    mutationFn: () =>
      publishAdminAnnouncement({
        sourceLocale,
        translation: {
          title: title.trim(),
          summary: summary.trim(),
          highlights: lines,
        },
      }),
    onSuccess: () => {
      setTitle("");
      setSummary("");
      setHighlights("");
      setSuccess(true);
      void queryClient.invalidateQueries({ queryKey: ADMIN_ANNOUNCEMENTS_KEY });
    },
    onMutate: () => setSuccess(false),
  });
  const withdraw = useMutation({
    mutationFn: withdrawAdminAnnouncement,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_ANNOUNCEMENTS_KEY });
    },
  });
  const hasOversizedHighlight = lines.some(
    (line) => [...line].length > 500,
  );
  const canPublish =
    title.trim().length > 0 &&
    summary.trim().length > 0 &&
    lines.length >= 1 &&
    lines.length <= 8 &&
    !hasOversizedHighlight &&
    announcements.isSuccess &&
    announcements.data.translationEnabled;

  const errorText = publish.error
    ? publish.error instanceof ApiError &&
      publish.error.code === "announcement_translation_not_configured"
      ? t.admin.announcementTranslationUnavailable
      : publish.error instanceof ApiError &&
          publish.error.code === "announcement_translation_failed"
        ? t.admin.announcementTranslationFailed
        : publish.error instanceof ApiError &&
            publish.error.code === "invalid_announcement"
          ? t.admin.announcementContentInvalid
        : t.admin.announcementPublishFailed
    : "";

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
            style={{
              borderColor: "var(--ink-line)",
              background: "var(--ink-wash)",
              color: "var(--cinnabar)",
            }}
          >
            <BellRing className="h-5 w-5" />
          </span>
          <div>
            <h2
              className="kn-heading-cn text-lg font-semibold"
              style={{ color: "var(--ink-black)" }}
            >
              {t.admin.announcementsTitle}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
              {t.admin.announcementsSubtitle}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-hidden="true">
          {LOCALES.map((item) => (
            <span
              key={item}
              className="rounded-full border px-2.5 py-1 text-[11px] font-medium"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-faint)" }}
            >
              {LOCALE_LABELS[item]}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
        <PaperCard className="overflow-hidden">
          <div
            className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-6"
            style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
          >
            <div>
              <h3 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>
                {t.admin.announcementKindManual}
              </h3>
              <p className="mt-0.5 text-xs" style={{ color: "var(--ink-faint)" }}>
                {t.admin.announcementTranslationNote}
              </p>
            </div>
            <Languages className="h-5 w-5 shrink-0" style={{ color: "var(--ink-faint)" }} />
          </div>

          <div className="space-y-5 px-5 py-5 sm:px-6 sm:py-6">
            <div className="grid gap-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
              <label className="text-sm" style={{ color: "var(--ink-strong)" }}>
                <span className="mb-2 block text-xs font-medium">
                  {t.admin.announcementSourceLanguage}
                </span>
                <select
                  value={sourceLocale}
                  onChange={(event) => {
                    setSuccess(false);
                    setSourceLocale(event.target.value as Locale);
                  }}
                  className={FIELD_CLASS}
                  style={FIELD_STYLE}
                >
                  {LOCALES.map((item) => (
                    <option key={item} value={item}>
                      {LOCALE_LABELS[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm" style={{ color: "var(--ink-strong)" }}>
                <span className="mb-2 flex items-center justify-between gap-3 text-xs font-medium">
                  {t.admin.announcementTitleLabel}
                  <span className="font-normal tabular-nums" style={{ color: "var(--ink-faint)" }}>
                    {[...title].length} / 160
                  </span>
                </span>
                <input
                  value={title}
                  maxLength={160}
                  onChange={(event) => {
                    setSuccess(false);
                    setTitle(event.target.value);
                  }}
                  className={FIELD_CLASS}
                  style={FIELD_STYLE}
                />
              </label>
            </div>

            <label className="block text-sm" style={{ color: "var(--ink-strong)" }}>
              <span className="mb-2 flex items-center justify-between gap-3 text-xs font-medium">
                {t.admin.announcementSummaryLabel}
                <span className="font-normal tabular-nums" style={{ color: "var(--ink-faint)" }}>
                  {[...summary].length} / 600
                </span>
              </span>
              <textarea
                value={summary}
                maxLength={600}
                rows={4}
                onChange={(event) => {
                  setSuccess(false);
                  setSummary(event.target.value);
                }}
                className={`${FIELD_CLASS} resize-y leading-6`}
                style={FIELD_STYLE}
              />
            </label>

            <label className="block text-sm" style={{ color: "var(--ink-strong)" }}>
              <span className="mb-2 flex items-center justify-between gap-3 text-xs font-medium">
                {t.admin.announcementHighlightsLabel}
                <span
                  className="font-normal tabular-nums"
                  style={{ color: lines.length > 8 ? "var(--cinnabar)" : "var(--ink-faint)" }}
                >
                  {lines.length} / 8
                </span>
              </span>
              <textarea
                value={highlights}
                rows={7}
                onChange={(event) => {
                  setSuccess(false);
                  setHighlights(event.target.value);
                }}
                placeholder={t.admin.announcementHighlightsPlaceholder}
                aria-invalid={hasOversizedHighlight || lines.length > 8}
                className={`${FIELD_CLASS} resize-y leading-6`}
                style={FIELD_STYLE}
              />
            </label>
            {hasOversizedHighlight && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {t.admin.announcementHighlightTooLong}
              </p>
            )}
          </div>

          <div
            className="flex flex-col gap-4 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
            style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
          >
            <div className="min-h-5 text-xs" aria-live="polite">
              {announcements.data?.translationEnabled === false && (
                <p className="text-amber-700 dark:text-amber-400">
                  {t.admin.announcementTranslationUnavailable}
                </p>
              )}
              {announcements.isError && (
                <p className="text-red-600 dark:text-red-400">
                  {t.admin.announcementLoadFailed}
                </p>
              )}
              {errorText && <p className="text-red-600 dark:text-red-400">{errorText}</p>}
              {success && (
                <p className="text-green-700 dark:text-green-400">
                  {t.admin.announcementPublishSuccess}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={!canPublish || publish.isPending}
              onClick={() => publish.mutate()}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              style={{ background: "var(--cinnabar)" }}
            >
              <Send className="h-4 w-4" />
              {publish.isPending
                ? t.admin.announcementPublishing
                : t.admin.announcementPublish}
            </button>
          </div>
        </PaperCard>

        <PaperCard className="overflow-hidden">
          <div
            className="flex items-center justify-between gap-3 border-b px-5 py-4"
            style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
          >
            <div className="flex items-center gap-2">
              <BellRing className="h-4 w-4" style={{ color: "var(--ink-faint)" }} />
              <h3 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>
                {t.admin.announcementHistory}
              </h3>
            </div>
            <span
              className="rounded-full px-2 py-0.5 text-xs tabular-nums"
              style={{ background: "var(--ink-wash-strong)", color: "var(--ink-mid)" }}
            >
              {announcements.data?.announcements.length ?? 0}
            </span>
          </div>

          {withdraw.isError && (
            <p className="border-b px-5 py-3 text-xs text-red-600 dark:text-red-400" style={{ borderColor: "var(--ink-line)" }}>
              {t.admin.announcementWithdrawFailed}
            </p>
          )}
          {announcements.isLoading ? (
            <div className="flex min-h-48 items-center justify-center px-5 py-10 text-sm" style={{ color: "var(--ink-faint)" }}>
              {t.admin.loading}
            </div>
          ) : announcements.isError ? (
            <div className="flex min-h-48 items-center justify-center px-5 py-10 text-sm text-red-600 dark:text-red-400">
              {t.admin.announcementLoadFailed}
            </div>
          ) : announcements.data?.announcements.length ? (
            <div className="max-h-[44rem] overflow-y-auto">
              {announcements.data.announcements.map((item) => {
                const translation = item.translations[locale] ?? item.translations.en;
                return (
                  <article
                    key={item.id}
                    className="border-b px-5 py-4 last:border-b-0"
                    style={{
                      borderColor: "var(--ink-line)",
                      opacity: item.withdrawnAt ? 0.58 : 1,
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span
                        className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
                        style={{
                          background: item.withdrawnAt ? "var(--ink-wash-strong)" : "var(--cinnabar-soft)",
                          color: item.withdrawnAt ? "var(--ink-faint)" : "var(--cinnabar)",
                        }}
                      >
                        {item.kind === "release"
                          ? `${t.admin.announcementKindRelease} ${item.version ?? ""}`
                          : t.admin.announcementKindManual}
                      </span>
                      <time className="shrink-0 text-[11px]" style={{ color: "var(--ink-faint)" }}>
                        {new Date(item.publishedAt).toLocaleString(locale)}
                      </time>
                    </div>
                    <p className="mt-3 text-sm font-semibold leading-6" style={{ color: "var(--ink-strong)" }}>
                      {translation?.title}
                    </p>
                    <p className="mt-1 line-clamp-3 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>
                      {translation?.summary}
                    </p>
                    <div className="mt-3 flex justify-end">
                      {item.withdrawnAt ? (
                        <span className="text-[11px]" style={{ color: "var(--ink-faint)" }}>
                          {t.admin.announcementWithdrawn}
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={withdraw.isPending}
                          onClick={async () => {
                            if (!(await confirmAction(t.admin.announcementWithdrawConfirm))) return;
                            withdraw.mutate(item.id);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition hover:bg-[var(--ink-wash-strong)] disabled:opacity-50"
                          style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
                        >
                          <BellOff className="h-3.5 w-3.5" />
                          {t.admin.announcementWithdraw}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-5 py-10 text-center">
              <BellOff className="h-6 w-6" style={{ color: "var(--ink-faint)" }} />
              <p className="text-sm" style={{ color: "var(--ink-faint)" }}>
                {t.admin.announcementHistoryEmpty}
              </p>
            </div>
          )}
        </PaperCard>
      </div>
    </section>
  );
}
