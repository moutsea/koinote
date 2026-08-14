import { Link } from "@tanstack/react-router";
import {
  Bot,
  Clock3,
  Eye,
  ImageIcon,
  KeyRound,
  Sparkles,
  Download,
  FileText,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useCurrentUser } from "../auth";
import { useI18n } from "../i18n";
import { PageContainer } from "../components/PageContainer";
import { InkSeal, InkClouds, ScrollRod, PaperCard } from "../components/Ink";
import { DESKTOP_DOWNLOAD_URL } from "../desktopDownload";

// 图标与文案一一对应，文案按语言从 t.home.features 取。
const FEATURE_ICONS = [Eye, FileText, ImageIcon, Sparkles, Download, Zap];
const MCP_STEP_ICONS = [KeyRound, ShieldCheck, Clock3];

export function HomePage() {
  const user = useCurrentUser();
  const { t, locale } = useI18n();

  return (
    <div className="flex flex-1 flex-col" style={{ background: "var(--ink-paper)" }}>
      {/* Hero：墨云铺底，标题竖排印章压角 */}
      <section className="relative overflow-hidden">
        <InkClouds withCinnabar />

        {/* 宽度取自 layout.ts 的路由表（首页是 6xl）。标题与副标题另有各自的 max-w：
            6xl 是版面的外框，那两个管的是文字行长，两层都要 */}
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

          {/* max-w-4xl 比容器的 6xl 更窄，所以仍然在起作用：
              标题居中且行长收在 4xl，两侧留白是刻意的 */}
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
            <a
              href={DESKTOP_DOWNLOAD_URL}
              className="inline-flex items-center gap-2 rounded-full border px-6 py-3 text-sm font-semibold transition hover:bg-[var(--ink-wash-strong)]"
              style={{
                borderColor: "var(--ink-line)",
                color: "var(--ink-strong)",
              }}
            >
              <Download className="h-4 w-4" />
              {t.home.ctaDownload}
            </a>
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

      <section className="border-y" style={{ borderColor: "var(--ink-line)" }}>
        <PageContainer className="py-20 sm:py-24">
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,.95fr)]">
            <div>
              <p
                className="text-xs font-semibold uppercase tracking-[0.2em]"
                style={{ color: "var(--cinnabar)" }}
              >
                {t.home.mcp.eyebrow}
              </p>
              <h2
                className="kn-heading-cn mt-3 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl"
                style={{ color: "var(--ink-black)" }}
              >
                {t.home.mcp.title}
              </h2>
              <p className="mt-4 max-w-2xl text-base leading-7" style={{ color: "var(--ink-mid)" }}>
                {t.home.mcp.description}
              </p>

              <div className="mt-7 space-y-4">
                {t.home.mcp.steps.map((step, index) => {
                  const Icon = MCP_STEP_ICONS[index] ?? ShieldCheck;
                  return (
                    <div key={step.title} className="flex items-start gap-3">
                      <span
                        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                        style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div>
                        <h3 className="text-sm font-semibold" style={{ color: "var(--ink-black)" }}>
                          {step.title}
                        </h3>
                        <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                          {step.desc}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  to="/docs/mcp"
                  className="inline-flex rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85"
                  style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
                >
                  {t.footer.mcpGuide}
                </Link>
                <Link
                  to="/pricing"
                  className="inline-flex rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]"
                  style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                >
                  {t.home.mcp.cta}
                </Link>
              </div>
            </div>

            <PaperCard className="overflow-hidden">
              <div className="border-b p-5" style={{ borderColor: "var(--ink-line)" }}>
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-11 w-11 items-center justify-center rounded-xl"
                    style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
                  >
                    <Bot className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="font-semibold" style={{ color: "var(--ink-black)" }}>Koinote MCP</p>
                    <p className="mt-0.5 text-xs" style={{ color: "var(--ink-faint)" }}>
                      {t.home.mcp.agents}
                    </p>
                  </div>
                </div>
              </div>
              <div className="space-y-3 p-5 sm:p-6">
                {["Codex", "Claude Code", "OpenCode", "OpenClaw", "WorkBuddy"].map((agent) => (
                  <div
                    key={agent}
                    className="flex items-center justify-between rounded-lg border px-4 py-3"
                    style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
                  >
                    <span className="text-sm font-medium" style={{ color: "var(--ink-strong)" }}>
                      {agent}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--ink-mid)" }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--ink-mid)" }} />
                      MCP
                    </span>
                  </div>
                ))}
              </div>
            </PaperCard>
          </div>
        </PageContainer>
      </section>
    </div>
  );
}
