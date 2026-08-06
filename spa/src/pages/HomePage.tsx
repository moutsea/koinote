import { Link } from "@tanstack/react-router";
import {
  Eye,
  ImageIcon,
  Sparkles,
  Download,
  FileText,
  Zap,
} from "lucide-react";
import { useCurrentUser } from "../auth";
import { useI18n } from "../i18n";
import { PageContainer } from "../components/PageContainer";
import { InkSeal, InkClouds, ScrollRod, PaperCard } from "../components/Ink";

// 图标与文案一一对应，文案按语言从 t.home.features 取。
const FEATURE_ICONS = [Eye, FileText, ImageIcon, Sparkles, Download, Zap];

export function HomePage() {
  const user = useCurrentUser();
  const { t, locale } = useI18n();

  return (
    <div className="flex flex-1 flex-col" style={{ background: "var(--ink-paper)" }}>
      {/* Hero：墨云铺底，标题竖排印章压角 */}
      <section className="relative overflow-hidden">
        <InkClouds withCinnabar />

        {/* 宽度取自 layout.ts 的路由表。标题与副标题各自有 max-w 兜住行长 ——
            通栏指版面占满，不是让文字行拉到 2000px 那么长 */}
        <PageContainer className="py-20 text-center sm:py-28">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium"
            style={{
              borderColor: "var(--cinnabar)",
              background: "var(--cinnabar-soft)",
              color: "var(--cinnabar)",
            }}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t.home.badge}
          </span>

          {/* max-w-4xl 兜住行长：版面通栏了，但一行标题横跨 2000px 没法读 */}
          <h1
            className="kn-heading-cn kn-ink-bloom mx-auto mt-6 max-w-4xl text-4xl font-bold tracking-tight sm:text-5xl"
            style={{ color: "var(--ink-black)" }}
          >
            {t.home.title}
          </h1>

          {/* 中文品牌名与印章：只在中文界面出现。
              其他语言下「锦鲤笔记」四个字对读者没有信息量，只是装饰 */}
          {locale === "zh" && (
            <div className="mt-5 flex items-center justify-center gap-3">
              <ScrollRod className="w-16" />
              <span
                className="kn-brand-cn text-xl"
                style={{ color: "var(--ink-mid)" }}
              >
                锦鲤笔记
              </span>
              <InkSeal className="h-8 px-0.5 text-xs" />
              <ScrollRod className="w-16" />
            </div>
          )}

          <p
            className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed"
            style={{ color: "var(--ink-mid)" }}
          >
            {t.home.subtitle}
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/editor"
              className="rounded-full px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
              style={{ background: "var(--cinnabar)" }}
            >
              {t.home.ctaStart}
            </Link>
            {!user && (
              <Link
                to="/register"
                className="rounded-full border px-6 py-3 text-sm font-semibold transition hover:bg-[var(--ink-wash-strong)]"
                style={{
                  borderColor: "var(--ink-line)",
                  color: "var(--ink-strong)",
                }}
              >
                {t.home.ctaRegister}
              </Link>
            )}
          </div>
        </PageContainer>
      </section>

      {/* Features */}
      {/* 列数保持 3 而不是宽屏上再加一列：features 正好 6 条，
          3 列是干净的两行，4 列会变成 4+2 的残行 */}
      <section>
        <PageContainer className="pb-24">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {t.home.features.map((feature, i) => {
              const Icon = FEATURE_ICONS[i] ?? FileText;
              return (
                <PaperCard key={feature.title} hover className="p-6">
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-lg"
                    style={{
                      background: "var(--cinnabar-soft)",
                      color: "var(--cinnabar)",
                    }}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3
                    className="kn-heading-cn mt-4 font-semibold"
                    style={{ color: "var(--ink-black)" }}
                  >
                    {feature.title}
                  </h3>
                  <p
                    className="mt-2 text-sm leading-relaxed"
                    style={{ color: "var(--ink-mid)" }}
                  >
                    {feature.desc}
                  </p>
                </PaperCard>
              );
            })}
          </div>
        </PageContainer>
      </section>
    </div>
  );
}
