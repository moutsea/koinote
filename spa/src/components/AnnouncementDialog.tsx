import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellRing, History, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getUnreadAnnouncements,
  markAnnouncementRead,
  type Announcement,
} from "../api";
import { useI18n, interpolate, type Locale } from "../i18n";

function announcementQueryKey(locale: Locale) {
  return ["announcements", "unread", locale] as const;
}

export function AnnouncementDialog() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const queryKey = announcementQueryKey(locale);
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(
    () => new Set(),
  );
  const announcements = useQuery({
    queryKey,
    queryFn: () => getUnreadAnnouncements(locale),
    staleTime: 60_000,
    retry: 1,
  });
  const markRead = useMutation({
    mutationFn: markAnnouncementRead,
    onSuccess: (_result, announcementId) => {
      queryClient.setQueryData<{ announcements: Announcement[] }>(
        queryKey,
        (existing) => ({
          announcements:
            existing?.announcements.filter(
              (announcement) => announcement.id !== announcementId,
            ) ?? [],
        }),
      );
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const current =
    announcements.data?.announcements.find(
      (announcement) => !dismissedIds.has(announcement.id),
    ) ?? null;

  const dismissCurrent = () => {
    if (!current) return;
    setDismissedIds((existing) => {
      const next = new Set(existing);
      next.add(current.id);
      return next;
    });
    markRead.reset();
  };

  useEffect(() => {
    if (!current) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissCurrent();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [current?.id]);

  if (!current) return null;

  const badge =
    current.kind === "release" && current.version
      ? interpolate(t.announcements.releaseBadge, { version: current.version })
      : t.announcements.manualBadge;

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center p-4"
      style={{ background: "rgba(0, 0, 0, 0.45)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismissCurrent();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="kn-announcement-title"
        aria-describedby="kn-announcement-summary"
        className="kn-ink-bloom relative w-full max-w-lg rounded-2xl border p-6 shadow-2xl sm:p-7"
        style={{
          borderColor: "var(--ink-line)",
          background: "var(--ink-paper-soft)",
        }}
      >
        <button
          type="button"
          aria-label={t.announcements.close}
          onClick={dismissCurrent}
          className="absolute right-4 top-4 rounded-full p-1.5 transition hover:bg-[var(--ink-wash-strong)]"
          style={{ color: "var(--ink-faint)" }}
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-start gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{
              background: "var(--cinnabar-soft)",
              color: "var(--cinnabar)",
            }}
          >
            <BellRing className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p
              className="text-xs font-semibold uppercase tracking-[0.16em]"
              style={{ color: "var(--cinnabar)" }}
            >
              {badge}
            </p>
            <h2
              id="kn-announcement-title"
              className="kn-heading-cn mt-1.5 text-xl font-semibold"
              style={{ color: "var(--ink-black)" }}
            >
              {current.translation.title}
            </h2>
          </div>
        </div>

        <p
          id="kn-announcement-summary"
          className="mt-4 text-sm leading-6"
          style={{ color: "var(--ink-mid)" }}
        >
          {current.translation.summary}
        </p>
        <ul className="mt-4 space-y-2.5">
          {current.translation.highlights.map((highlight, index) => (
            <li
              key={`${current.id}-${index}`}
              className="flex gap-2.5 text-sm leading-6"
              style={{ color: "var(--ink-strong)" }}
            >
              <span
                aria-hidden
                className="mt-[0.6rem] h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: "var(--cinnabar)" }}
              />
              <span>{highlight}</span>
            </li>
          ))}
        </ul>

        {markRead.isError && (
          <p className="mt-4 text-xs text-red-600 dark:text-red-400">
            {t.announcements.markReadFailed}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2.5">
          {current.kind === "release" && (
            <Link
              to="/changelog"
              onClick={() => {
                markRead.mutate(current.id);
                dismissCurrent();
              }}
              className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
              style={{
                borderColor: "var(--ink-line)",
                color: "var(--ink-strong)",
              }}
            >
              <History className="h-4 w-4" />
              {t.announcements.viewChangelog}
            </Link>
          )}
          <button
            type="button"
            disabled={markRead.isPending}
            onClick={() => markRead.mutate(current.id)}
            className="rounded-full px-5 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            style={{ background: "var(--cinnabar)" }}
          >
            {t.announcements.acknowledge}
          </button>
        </div>
      </div>
    </div>
  );
}
