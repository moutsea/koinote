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

// 图标与文案一一对应，文案按语言从 t.home.features 取。
const FEATURE_ICONS = [Eye, FileText, ImageIcon, Sparkles, Download, Zap];

export function HomePage() {
  const user = useCurrentUser();
  const { t } = useI18n();

  return (
    <div className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-sky-50 to-transparent dark:from-sky-950/20" />
        {/* 宽度取自 layout.ts 的路由表。标题与副标题各自有 max-w 兜住行长 ——
            通栏指版面占满，不是让文字行拉到 2000px 那么长 */}
        <PageContainer className="py-20 text-center sm:py-28">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
            <Sparkles className="h-3.5 w-3.5" />
            {t.home.badge}
          </span>
          {/* max-w-4xl 兜住行长：版面通栏了，但一行标题横跨 2000px 没法读 */}
          <h1 className="mx-auto mt-6 max-w-4xl text-4xl font-bold tracking-tight sm:text-5xl">
            {t.home.title}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-neutral-600 dark:text-neutral-300">
            {t.home.subtitle}
          </p>
          <div className="mt-9 flex items-center justify-center gap-3">
            <Link
              to="/editor"
              className="rounded-full bg-sky-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-500"
            >
              {t.home.ctaStart}
            </Link>
            {!user && (
              <Link
                to="/register"
                className="rounded-full border border-black/10 px-6 py-3 text-sm font-semibold transition hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
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
                <div
                  key={feature.title}
                  className="rounded-2xl border border-black/5 bg-white/60 p-6 transition hover:-translate-y-0.5 hover:shadow-lg dark:border-white/10 dark:bg-white/5"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-100 text-sky-600 dark:bg-sky-950/50 dark:text-sky-300">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                    {feature.desc}
                  </p>
                </div>
              );
            })}
          </div>
        </PageContainer>
      </section>
    </div>
  );
}
