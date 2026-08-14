import { ExternalLink, GitCommitHorizontal, History } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import changelogEnglish from "../../../CHANGELOG.md?raw";
import changelogFrench from "../../../CHANGELOG.fr.md?raw";
import changelogJapanese from "../../../CHANGELOG.ja.md?raw";
import changelogChinese from "../../../CHANGELOG.zh.md?raw";
import { parseChangelog } from "../changelogCore";
import { InkClouds, InkSeal, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n, type Locale } from "../i18n";

const CHANGELOGS: Record<Locale, string> = {
  en: changelogEnglish,
  zh: changelogChinese,
  fr: changelogFrench,
  ja: changelogJapanese,
};
const SOURCE_FILES: Record<Locale, string> = {
  en: "CHANGELOG.md",
  zh: "CHANGELOG.zh.md",
  fr: "CHANGELOG.fr.md",
  ja: "CHANGELOG.ja.md",
};
const SOURCE_BASE_URL = "https://github.com/moutsea/koinote/blob/main/";
const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function ChangelogPage() {
  const { t, locale } = useI18n();
  const releases = parseChangelog(CHANGELOGS[locale]);
  const sourceURL = `${SOURCE_BASE_URL}${SOURCE_FILES[locale]}`;

  useEffect(() => {
    const original = document.title;
    document.title = `${t.changelog.title} — Koinote`;
    return () => {
      document.title = original;
    };
  }, [t.changelog.title]);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds withCinnabar />
      <PageContainer className="relative flex-1 py-14 sm:py-20">
        <header className="mx-auto max-w-3xl text-center">
          <div
            className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border"
            style={{
              borderColor: "var(--ink-line)",
              background: "var(--ink-paper-soft)",
              color: "var(--cinnabar)",
            }}
          >
            <History className="h-5 w-5" />
          </div>
          <p
            className="mt-5 text-xs font-semibold uppercase tracking-[0.2em]"
            style={{ color: "var(--ink-mid)" }}
          >
            {t.changelog.eyebrow}
          </p>
          <h1
            className="kn-heading-cn mt-3 text-3xl font-bold tracking-tight sm:text-5xl"
            style={{ color: "var(--ink-black)" }}
          >
            {t.changelog.title}
          </h1>
          <p
            className="mx-auto mt-5 max-w-2xl text-base leading-7"
            style={{ color: "var(--ink-mid)" }}
          >
            {t.changelog.subtitle}
          </p>
          <a
            href={sourceURL}
            target="_blank"
            rel="noopener noreferrer"
            className="kn-ink-link mt-5 inline-flex items-center gap-1.5 text-sm transition-colors"
            style={{ color: "var(--ink-mid)" }}
          >
            {t.changelog.sourceLink}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </header>

        <div className="relative mx-auto mt-14 max-w-4xl sm:mt-16">
          <div
            aria-hidden
            className="absolute bottom-0 left-[17px] top-2 w-px sm:left-[23px]"
            style={{ background: "var(--ink-line)" }}
          />

          <div className="space-y-9 sm:space-y-12">
            {releases.map((release, releaseIndex) => {
              const isUnreleased = release.version === "Unreleased";
              return (
                <article
                  key={release.version}
                  className="relative grid grid-cols-[36px_minmax(0,1fr)] gap-3 sm:grid-cols-[48px_minmax(0,1fr)] sm:gap-5"
                >
                  <div
                    className="relative z-10 mt-5 flex h-9 w-9 items-center justify-center rounded-full border sm:h-12 sm:w-12"
                    style={{
                      borderColor: isUnreleased
                        ? "var(--cinnabar)"
                        : "var(--ink-line)",
                      background: "var(--ink-paper)",
                      color: isUnreleased
                        ? "var(--cinnabar)"
                        : "var(--ink-mid)",
                    }}
                  >
                    <GitCommitHorizontal className="h-4 w-4 sm:h-5 sm:w-5" />
                  </div>

                  <PaperCard
                    className={`relative px-5 py-6 sm:px-8 sm:py-8 ${
                      releaseIndex === 0 ? "shadow-sm" : ""
                    }`}
                  >
                    {isUnreleased && (
                      <InkSeal
                        label="新"
                        className="absolute right-5 top-5 hidden h-10 px-1 text-xs sm:inline-flex"
                      />
                    )}
                    <header className="pr-12">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h2
                          className="kn-heading-cn text-2xl font-bold"
                          style={{ color: "var(--ink-black)" }}
                        >
                          {isUnreleased
                            ? t.changelog.unreleased
                            : `v${release.version}`}
                        </h2>
                        {release.date && (
                          <time
                            dateTime={release.date}
                            className="text-xs"
                            style={{ color: "var(--ink-faint)" }}
                          >
                            {formatDate(release.date, locale)}
                          </time>
                        )}
                      </div>
                    </header>

                    <div className="mt-6 space-y-7">
                      {release.sections.map((section) => (
                        <section key={section.name}>
                          <h3
                            className="text-xs font-semibold uppercase tracking-[0.16em]"
                            style={{ color: "var(--ink-mid)" }}
                          >
                            {categoryLabel(
                              section.name,
                              t.changelog.categories,
                            )}
                          </h3>
                          <ul className="mt-3 space-y-3">
                            {section.entries.map((entry) => (
                              <li
                                key={entry}
                                className="flex gap-3 text-sm leading-7"
                                style={{ color: "var(--ink-strong)" }}
                              >
                                <span
                                  aria-hidden
                                  className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full"
                                  style={{ background: "var(--cinnabar)" }}
                                />
                                <p>
                                  <InlineEntry value={entry} />
                                </p>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  </PaperCard>
                </article>
              );
            })}
          </div>
        </div>

        <p
          className="mx-auto mt-10 max-w-3xl text-center text-xs leading-6"
          style={{ color: "var(--ink-faint)" }}
        >
          {t.changelog.sourceNote}
        </p>
      </PageContainer>
    </div>
  );
}

function formatDate(value: string, locale: Locale): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(
    DATE_LOCALE[locale],
    {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    },
  );
}

function categoryLabel(
  name: string,
  categories: Record<string, string>,
): string {
  return categories[name] ?? name;
}

function InlineEntry({ value }: { value: string }) {
  const parts = value.split(/(`[^`\n]+`)/g);
  return parts.map((part, index): ReactNode =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code
        key={`${part}-${index}`}
        className="rounded px-1.5 py-0.5 text-[0.9em]"
        style={{
          background: "var(--ink-wash-strong)",
          color: "var(--ink-black)",
        }}
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}
