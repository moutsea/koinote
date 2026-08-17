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
    <section className="mt-8">
      <div className="flex items-center gap-2" style={{ color: "var(--ink-strong)" }}>
        <BellRing className="h-5 w-5" />
        <h2 className="kn-heading-cn text-base font-semibold">
          {t.admin.announcementsTitle}
        </h2>
      </div>
      <p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>
        {t.admin.announcementsSubtitle}
      </p>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
        <PaperCard className="p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm" style={{ color: "var(--ink-strong)" }}>
              <span className="mb-1.5 block text-xs font-medium">
                {t.admin.announcementSourceLanguage}
              </span>
              <select
                value={sourceLocale}
                onChange={(event) => setSourceLocale(event.target.value as Locale)}
                className="w-full rounded-lg border bg-transparent px-3 py-2 outline-none"
                style={{ borderColor: "var(--ink-line)" }}
              >
                {LOCALES.map((item) => (
                  <option key={item} value={item}>
                    {LOCALE_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm" style={{ color: "var(--ink-strong)" }}>
              <span className="mb-1.5 block text-xs font-medium">
                {t.admin.announcementTitleLabel}
              </span>
              <input
                value={title}
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
                className="w-full rounded-lg border bg-transparent px-3 py-2 outline-none"
                style={{ borderColor: "var(--ink-line)" }}
              />
            </label>
          </div>
          <label className="mt-4 block text-sm" style={{ color: "var(--ink-strong)" }}>
            <span className="mb-1.5 block text-xs font-medium">
              {t.admin.announcementSummaryLabel}
            </span>
            <textarea
              value={summary}
              maxLength={600}
              rows={3}
              onChange={(event) => setSummary(event.target.value)}
              className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 outline-none"
              style={{ borderColor: "var(--ink-line)" }}
            />
          </label>
          <label className="mt-4 block text-sm" style={{ color: "var(--ink-strong)" }}>
            <span className="mb-1.5 block text-xs font-medium">
              {t.admin.announcementHighlightsLabel}
            </span>
            <textarea
              value={highlights}
              rows={5}
              onChange={(event) => setHighlights(event.target.value)}
              placeholder={t.admin.announcementHighlightsPlaceholder}
              aria-invalid={hasOversizedHighlight}
              className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 outline-none"
              style={{ borderColor: "var(--ink-line)" }}
            />
          </label>
          {hasOversizedHighlight && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {t.admin.announcementHighlightTooLong}
            </p>
          )}
          <div className="mt-3 flex items-start gap-2 text-xs" style={{ color: "var(--ink-faint)" }}>
            <Languages className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t.admin.announcementTranslationNote}</span>
          </div>
          {announcements.data?.translationEnabled === false && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
              {t.admin.announcementTranslationUnavailable}
            </p>
          )}
          {announcements.isError && (
            <p className="mt-3 text-xs text-red-600 dark:text-red-400">
              {t.admin.announcementLoadFailed}
            </p>
          )}
          {errorText && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{errorText}</p>}
          {success && <p className="mt-3 text-xs text-green-700 dark:text-green-400">{t.admin.announcementPublishSuccess}</p>}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={!canPublish || publish.isPending}
              onClick={() => publish.mutate()}
              className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
              style={{ background: "var(--cinnabar)" }}
            >
              <Send className="h-4 w-4" />
              {publish.isPending
                ? t.admin.announcementPublishing
                : t.admin.announcementPublish}
            </button>
          </div>
        </PaperCard>

        <PaperCard className="p-5">
          <h3 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>
            {t.admin.announcementHistory}
          </h3>
          {withdraw.isError && (
            <p className="mt-3 text-xs text-red-600 dark:text-red-400">
              {t.admin.announcementWithdrawFailed}
            </p>
          )}
          {announcements.isLoading ? (
            <p className="mt-4 text-xs" style={{ color: "var(--ink-faint)" }}>{t.admin.loading}</p>
          ) : announcements.isError ? (
            <p className="mt-4 text-xs text-red-600 dark:text-red-400">{t.admin.announcementLoadFailed}</p>
          ) : announcements.data?.announcements.length ? (
            <div className="mt-4 max-h-[30rem] space-y-3 overflow-y-auto pr-1">
              {announcements.data.announcements.map((item) => {
                const translation = item.translations[locale] ?? item.translations.en;
                return (
                  <article
                    key={item.id}
                    className="rounded-lg border p-3"
                    style={{
                      borderColor: "var(--ink-line)",
                      opacity: item.withdrawnAt ? 0.65 : 1,
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--cinnabar)" }}>
                        {item.kind === "release"
                          ? `${t.admin.announcementKindRelease} ${item.version ?? ""}`
                          : t.admin.announcementKindManual}
                      </span>
                      <time className="text-[11px]" style={{ color: "var(--ink-faint)" }}>
                        {new Date(item.publishedAt).toLocaleString(locale)}
                      </time>
                    </div>
                    <p className="mt-2 text-sm font-medium" style={{ color: "var(--ink-strong)" }}>
                      {translation?.title}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>
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
            <p className="mt-4 text-xs" style={{ color: "var(--ink-faint)" }}>{t.admin.announcementHistoryEmpty}</p>
          )}
        </PaperCard>
      </div>
    </section>
  );
}
