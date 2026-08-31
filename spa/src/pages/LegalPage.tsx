import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useI18n, type Locale } from "../i18n";
import type { LegalDoc } from "../i18n/types";
import { PageContainer } from "../components/PageContainer";
import { InkSeal, InkClouds, ScrollRod, PaperCard } from "../components/Ink";

/** 三份文档的类型。路由与 i18n 的 key 共用这一个联合 */
export type LegalKind = "privacy" | "terms" | "cookies";

/**
 * 生效与更新日期。
 *
 * 写成常量而不是放进 i18n：日期是同一个事实，四个语言各存一份必然会漂。
 * 格式化交给 Intl，各语言的写法（2026年8月5日 / August 5, 2026）自动对上。
 *
 * 改动条款内容时要一并更新 UPDATED，否则页面上的「更新于」就是假的。
 */
const EFFECTIVE = "2026-08-05";
const UPDATED = "2026-08-30";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

function formatDate(iso: string, locale: Locale): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(DATE_LOCALE[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** 印章字：三份文档各盖一个不同的字，比全站一个「書」有意思些 */
const SEAL_LABEL: Record<LegalKind, string> = {
  privacy: "私",
  terms: "約",
  cookies: "記",
};

export function LegalPage({ kind }: { kind: LegalKind }) {
  const { t, locale } = useI18n();
  const doc: LegalDoc = t.legal[kind];
  const others = (["privacy", "terms", "cookies"] as const).filter(
    (k) => k !== kind,
  );

  return (
    <div
      className="relative flex flex-1 flex-col overflow-hidden"
      style={{ background: "var(--ink-paper)" }}
    >
      <InkClouds />

      <PageContainer className="py-12 sm:py-16">
        <ScrollRod className="w-[92%] max-w-3xl" />

        <article className="kn-scroll-unfurl mx-auto mt-6 max-w-3xl">
          <PaperCard className="px-6 py-10 sm:px-12 sm:py-14">
            <header className="relative">
              {/* 印章绝对定位在右上角。sm 以下藏掉：小屏上它会压到标题 */}
              <div className="absolute right-0 top-0 hidden sm:block">
                <InkSeal label={SEAL_LABEL[kind]} className="h-12 px-1 text-base" />
              </div>

              <h1
                className="kn-heading-cn pr-16 text-3xl font-bold tracking-tight sm:text-4xl"
                style={{ color: "var(--ink-black)" }}
              >
                {doc.title}
              </h1>

              {/* 朱砂短线：标题与正文之间的分隔，比一条通宽的灰线更像题款 */}
              <div
                className="mt-4 h-0.5 w-16 rounded-full"
                style={{ background: "var(--cinnabar)" }}
              />

              <p
                className="mt-5 text-base leading-relaxed"
                style={{ color: "var(--ink-mid)" }}
              >
                {doc.summary}
              </p>

              <dl
                className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-xs"
                style={{ color: "var(--ink-faint)" }}
              >
                <div className="flex gap-1.5">
                  <dt>{t.legal.effectiveLabel}</dt>
                  <dd>
                    <time dateTime={EFFECTIVE}>{formatDate(EFFECTIVE, locale)}</time>
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{t.legal.updatedLabel}</dt>
                  <dd>
                    <time dateTime={UPDATED}>{formatDate(UPDATED, locale)}</time>
                  </dd>
                </div>
              </dl>
            </header>

            <div
              className="mt-10 space-y-9 border-t pt-10"
              style={{ borderColor: "var(--ink-line)" }}
            >
              {doc.sections.map((section, i) => (
                <section key={section.title}>
                  <h2
                    className="kn-heading-cn flex items-baseline gap-2.5 text-lg font-semibold"
                    style={{ color: "var(--ink-black)" }}
                  >
                    {/* 条款序号用朱砂，中式文书的段首标记 */}
                    <span
                      className="text-sm font-normal tabular-nums"
                      style={{ color: "var(--cinnabar)" }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {section.title}
                  </h2>

                  <div className="mt-3 space-y-3">
                    {section.body.map((paragraph) => (
                      <p
                        key={paragraph}
                        className="text-sm leading-7"
                        style={{ color: "var(--ink-strong)" }}
                      >
                        {paragraph}
                      </p>
                    ))}
                  </div>

                  {section.items && (
                    <ul className="mt-3 space-y-2">
                      {section.items.map((item) => (
                        <li
                          key={item}
                          className="flex gap-2.5 text-sm leading-7"
                          style={{ color: "var(--ink-strong)" }}
                        >
                          {/* 朱砂点作项目符号。aria-hidden：读屏不必念这个圆点，
                              ul/li 本身已经表达了列表语义 */}
                          <span
                            aria-hidden
                            className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ background: "var(--cinnabar)" }}
                          />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          </PaperCard>

          {/* 相关条款：三份文档互相导航，避免读者回首页再找 */}
          <nav className="mt-10" aria-label={t.legal.relatedTitle}>
            <h2
              className="kn-heading-cn text-sm font-semibold"
              style={{ color: "var(--ink-mid)" }}
            >
              {t.legal.relatedTitle}
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {others.map((k) => (
                <Link key={k} to={`/${k}`} className="block">
                  <PaperCard hover className="px-5 py-4">
                    <span
                      className="text-sm font-medium"
                      style={{ color: "var(--ink-black)" }}
                    >
                      {t.legal[k].title}
                    </span>
                  </PaperCard>
                </Link>
              ))}
            </div>
          </nav>

          <div className="mt-8 text-center">
            <Link
              to="/"
              className="kn-ink-link inline-flex items-center gap-1.5 text-sm transition-colors"
              style={{ color: "var(--ink-mid)" }}
            >
              <ArrowLeft className="h-4 w-4" />
              {t.legal.backHome}
            </Link>
          </div>
        </article>
      </PageContainer>
    </div>
  );
}

// 路由各自的入口。lazyRouteComponent 需要具名导出，不能给它一个带参数的组件
export function PrivacyPage() {
  return <LegalPage kind="privacy" />;
}
export function TermsPage() {
  return <LegalPage kind="terms" />;
}
export function CookiesPage() {
  return <LegalPage kind="cookies" />;
}
