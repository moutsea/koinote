import { Link } from "@tanstack/react-router";
import { InkClouds } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

/**
 * 路由表里没有的地址。挂在根路由的 notFoundComponent 上，渲染在 AppShell 的
 * Outlet 里，页头页脚照常显示。
 *
 * 服务端的 404 状态码和 noindex 由 Worker 负责（worker/seo.ts），这里只管给人看；
 * 标题由 AppShell 的统一同步按 globalNotFound 设置。
 * 静态导入而非懒加载：本来就是走错路的用户，不该再等一个 chunk。
 */
export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <section className="relative overflow-hidden">
      <InkClouds />
      <PageContainer className="py-24 text-center sm:py-32">
        <p
          className="kn-heading-cn text-6xl font-bold tracking-tight sm:text-7xl"
          style={{ color: "var(--ink-faint)" }}
          aria-hidden
        >
          404
        </p>
        <h1
          className="kn-heading-cn mt-6 text-3xl font-bold tracking-tight sm:text-4xl"
          style={{ color: "var(--ink-black)" }}
        >
          {t.notFound.title}
        </h1>
        <div
          className="mx-auto mt-4 h-0.5 w-16 rounded-full"
          style={{ background: "var(--cinnabar)" }}
        />
        <p
          className="mx-auto mt-5 max-w-xl text-base leading-relaxed"
          style={{ color: "var(--ink-mid)" }}
        >
          {t.notFound.description}
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/"
            className="rounded-full px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            style={{ background: "var(--cinnabar)" }}
          >
            {t.notFound.backHome}
          </Link>
          <Link
            to="/docs"
            className="rounded-full border px-6 py-3 text-sm font-semibold transition hover:bg-[var(--ink-wash-strong)]"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
          >
            {t.notFound.openDocs}
          </Link>
        </div>
      </PageContainer>
    </section>
  );
}
