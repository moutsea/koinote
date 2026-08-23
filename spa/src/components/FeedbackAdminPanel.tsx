import {
  Bug,
  Globe2,
  Laptop,
  LoaderCircle,
  MessageSquareText,
  UserRound,
  WifiOff,
} from "lucide-react";
import type { AdminFeedback } from "../api";
import { useI18n, type Locale } from "../i18n";
import { PaperCard } from "./Ink";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function FeedbackAdminPanel({
  items,
  isLoading,
  isError,
  isLoadingMore,
  hasMore,
  onLoadMore,
  locale,
}: {
  items: readonly AdminFeedback[] | undefined;
  isLoading: boolean;
  isError: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  locale: Locale;
}) {
  const { t } = useI18n();

  if (isLoading) {
    return (
      <PaperCard className="p-8 text-center">
        <p className="text-sm" style={{ color: "var(--ink-mid)" }}>
          {t.admin.feedbackLoading}
        </p>
      </PaperCard>
    );
  }

  if (isError || !items) {
    return (
      <PaperCard className="p-8 text-center">
        <WifiOff
          className="mx-auto h-8 w-8"
          style={{ color: "var(--ink-faint)" }}
        />
        <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>
          {t.admin.feedbackLoadFailed}
        </p>
      </PaperCard>
    );
  }

  return (
    <section>
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: "var(--ink-wash-strong)",
            color: "var(--cinnabar)",
          }}
        >
          <MessageSquareText className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold">{t.admin.feedbackTitle}</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.admin.feedbackSubtitle}
          </p>
        </div>
      </div>

      {items.length === 0 ? (
        <PaperCard className="mt-5 p-8 text-center">
          <MessageSquareText
            className="mx-auto h-8 w-8"
            style={{ color: "var(--ink-faint)" }}
          />
          <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.admin.feedbackEmpty}
          </p>
        </PaperCard>
      ) : (
        <div className="mt-5 space-y-3">
          {items.map((item) => {
            const isBug = item.category === "bug";
            const userName = item.userName ?? t.admin.deletedAccount;
            return (
              <PaperCard key={item.id} className="overflow-hidden p-0">
                <div className="p-5 sm:p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
                      style={{
                        background: isBug
                          ? "var(--cinnabar-soft)"
                          : "var(--ink-wash-strong)",
                        color: isBug ? "var(--cinnabar)" : "var(--ink-strong)",
                      }}
                    >
                      {isBug ? (
                        <Bug className="h-3.5 w-3.5" />
                      ) : (
                        <MessageSquareText className="h-3.5 w-3.5" />
                      )}
                      {isBug ? t.admin.feedbackBug : t.admin.feedbackExperience}
                    </span>
                    <time
                      dateTime={item.createdAt}
                      className="text-xs"
                      style={{ color: "var(--ink-faint)" }}
                    >
                      {new Date(item.createdAt).toLocaleString(
                        DATE_LOCALE[locale],
                      )}
                    </time>
                  </div>

                  <p
                    className="mt-4 whitespace-pre-wrap break-words text-sm leading-7"
                    style={{ color: "var(--ink-strong)" }}
                  >
                    {item.message}
                  </p>

                  <dl
                    className="mt-5 grid gap-3 border-t pt-4 text-xs sm:grid-cols-2"
                    style={{ borderColor: "var(--ink-line)" }}
                  >
                    <div>
                      <dt
                        className="flex items-center gap-1.5"
                        style={{ color: "var(--ink-faint)" }}
                      >
                        <UserRound className="h-3.5 w-3.5" />
                        {t.admin.feedbackFrom}
                      </dt>
                      <dd
                        className="mt-1 break-words"
                        style={{ color: "var(--ink-strong)" }}
                      >
                        {userName}
                        {item.userEmail && (
                          <span
                            className="ml-1"
                            style={{ color: "var(--ink-faint)" }}
                          >
                            · {item.userEmail}
                          </span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt
                        className="flex items-center gap-1.5"
                        style={{ color: "var(--ink-faint)" }}
                      >
                        <Globe2 className="h-3.5 w-3.5" />
                        {t.admin.feedbackPage}
                      </dt>
                      <dd
                        className="mt-1 break-all font-mono"
                        style={{ color: "var(--ink-strong)" }}
                      >
                        {item.pagePath || t.admin.notAvailable}
                      </dd>
                    </div>
                    <div>
                      <dt
                        className="flex items-center gap-1.5"
                        style={{ color: "var(--ink-faint)" }}
                      >
                        {item.client === "desktop" ? (
                          <Laptop className="h-3.5 w-3.5" />
                        ) : (
                          <Globe2 className="h-3.5 w-3.5" />
                        )}
                        {t.admin.client}
                      </dt>
                      <dd
                        className="mt-1"
                        style={{ color: "var(--ink-strong)" }}
                      >
                        {item.client === "desktop"
                          ? t.admin.desktopClient
                          : t.admin.webClient}
                      </dd>
                    </div>
                  </dl>

                  {item.userAgent && (
                    <details className="mt-4 text-xs">
                      <summary
                        className="cursor-pointer select-none"
                        style={{ color: "var(--ink-faint)" }}
                      >
                        {t.admin.feedbackUserAgent}
                      </summary>
                      <p
                        className="mt-2 break-all rounded-lg px-3 py-2 font-mono leading-5"
                        style={{
                          background: "var(--ink-wash)",
                          color: "var(--ink-mid)",
                        }}
                      >
                        {item.userAgent}
                      </p>
                    </details>
                  )}
                </div>
              </PaperCard>
            );
          })}
          {hasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                disabled={isLoadingMore}
                onClick={onLoadMore}
                className="inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  borderColor: "var(--ink-line)",
                  color: "var(--ink-strong)",
                }}
              >
                {isLoadingMore && (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                )}
                {isLoadingMore
                  ? t.admin.feedbackLoadingMore
                  : t.admin.feedbackLoadMore}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
