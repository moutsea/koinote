import { Link } from "@tanstack/react-router";
import { Github, Mail, Twitter, ExternalLink, History } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { InkSeal } from "./Ink";
import { Logo } from "./Logo";
import { EDGE_PADDING } from "../layout";

/** 兄弟站点。与 KeepAsk 的页脚同源，改一处这里也要跟着改 */
const SIBLING_SITES = [
  { href: "https://www.keepask.com", label: "KeepAsk" },
  { href: "https://www.codeilab.com/", label: "Code i Lab" },
  { href: "https://www.cs61bbeyond.com/", label: "CS61B Beyond" },
  { href: "https://www.claudeide.net", label: "Claude IDE" },
  { href: "https://codebyai.net", label: "CodeByAi" },
  { href: "https://kimiseek.app", label: "kimi/glm/deepseek" },
];

const CONTACT_EMAIL = "cfjwlchangji@gmail.com";

/**
 * 卷末页脚。
 *
 * 底色固定深墨、不随主题翻转：中式卷轴的末尾压一道重色收势，浅色主题下也该如此。
 * 代价是深底上的文字要反着来，所以挂 kn-app-footer —— 那个 class 在 globals.css 里
 * 就地把墨色令牌反相了，这里的子元素照常写 var(--ink-mid) 即可。
 */
export function AppFooter() {
  const { t } = useI18n();
  const year = new Date().getFullYear();

  return (
    <footer
      className="kn-app-footer relative overflow-hidden border-t"
      style={{
        borderColor: "var(--ink-line)",
        background: "var(--ink-footer)",
      }}
    >
      {/* 墨云 + 卷末朱砂。pointer-events-none 在 -z-10 之外还要写，
          否则这几团模糊的圆会吃掉页脚链接的点击 */}
      <div className="kn-paper-grain pointer-events-none absolute inset-0 -z-10">
        <div
          className="kn-ink-drift absolute left-1/4 top-0 h-80 w-80 rounded-full blur-3xl"
          style={{ background: "var(--ink-wash)" }}
        />
        <div
          className="absolute bottom-0 right-1/4 h-72 w-72 rounded-full blur-3xl"
          style={{ background: "var(--cinnabar-soft)" }}
        />
      </div>

      <div
        className={`mx-auto w-full max-w-6xl py-12 sm:py-16 ${EDGE_PADDING}`}
      >
        <div className="grid grid-cols-1 gap-10 md:grid-cols-12 md:gap-12">
          {/* 品牌 */}
          <div className="space-y-5 md:col-span-5">
            <div className="flex items-center gap-2.5">
              {/* 页脚恒定是深色面板（.kn-app-footer 把墨色 token 整套反过来），
                  所以这里固定用反白那张，不跟随主题 */}
              <Logo className="h-8 w-8" variant="reversed" />
              <span
                className="kn-heading-cn text-2xl font-bold"
                style={{ color: "var(--ink-black)" }}
              >
                Koinote
              </span>
              <span
                className="kn-brand-cn text-lg"
                style={{ color: "var(--ink-mid)" }}
              >
                {t.footer.brandCn}
              </span>
              <InkSeal className="ml-1 h-9 px-1 text-xs" />
            </div>
            <p
              className="max-w-md text-sm leading-relaxed"
              style={{ color: "var(--ink-mid)" }}
            >
              {t.footer.tagline}
            </p>
            <div className="flex items-center gap-3 pt-1">
              <SocialLink href="https://github.com/moutsea" label="GitHub">
                <Github className="h-5 w-5" />
              </SocialLink>
              <SocialLink href="https://x.com/LiangMout95522" label="Twitter">
                <Twitter className="h-5 w-5" />
              </SocialLink>
              <SocialLink
                href={`mailto:${CONTACT_EMAIL}`}
                label={t.footer.contact}
              >
                <Mail className="h-5 w-5" />
              </SocialLink>
            </div>
            <Link
              to="/changelog"
              className="kn-ink-link inline-flex min-h-8 items-center gap-2 text-sm transition-colors"
              style={{ color: "var(--ink-mid)" }}
            >
              <History className="h-4 w-4" />
              {t.footer.changelog}
            </Link>
          </div>

          {/* 链接三栏 */}
          <div className="md:col-span-7">
            <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
              <FooterColumn title={t.footer.product}>
                <FooterRoute to="/">{t.footer.home}</FooterRoute>
                <FooterRoute to="/editor">{t.footer.editor}</FooterRoute>
                <FooterRoute to="/pricing">{t.footer.pricing}</FooterRoute>
                <FooterRoute to="/docs/mcp">{t.footer.mcpGuide}</FooterRoute>
                <FooterRoute to="/docs/version-history">
                  {t.footer.versionHistoryGuide}
                </FooterRoute>
                <FooterRoute to="/dashboard">{t.footer.dashboard}</FooterRoute>
              </FooterColumn>

              <FooterColumn title={t.footer.legal}>
                <FooterRoute to="/privacy">{t.footer.privacy}</FooterRoute>
                <FooterRoute to="/terms">{t.footer.terms}</FooterRoute>
                <FooterRoute to="/cookies">{t.footer.cookies}</FooterRoute>
              </FooterColumn>

              <FooterColumn
                title={t.footer.built}
                icon={
                  <ExternalLink
                    className="h-3.5 w-3.5"
                    style={{ color: "var(--cinnabar)" }}
                  />
                }
              >
                {SIBLING_SITES.map((site) => (
                  <FooterExternal key={site.href} href={site.href}>
                    {site.label}
                  </FooterExternal>
                ))}
              </FooterColumn>
            </div>
          </div>
        </div>

        <div
          className="mt-10 flex flex-col items-center justify-between gap-4 border-t pt-6 sm:mt-14 sm:pt-8 md:flex-row"
          style={{ borderColor: "var(--ink-line)" }}
        >
          <p className="text-sm" style={{ color: "var(--ink-faint)" }}>
            © {year} {t.footer.copyright}. {t.footer.allRightsReserved}.
          </p>
          <a
            href="https://fomalhautlabs.com"
            target="_blank"
            rel="noopener noreferrer"
            className="kn-ink-link text-sm transition-colors"
            style={{ color: "var(--ink-faint)" }}
          >
            {t.footer.companyName}
          </a>
        </div>
      </div>
    </footer>
  );
}

function SocialLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      // mailto 不该新开标签页：浏览器会留下一个空白页
      target={href.startsWith("mailto:") ? undefined : "_blank"}
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="inline-flex h-10 w-10 items-center justify-center rounded-lg border transition-all duration-300 hover:-translate-y-0.5"
      style={{
        borderColor: "var(--ink-line)",
        background: "var(--ink-wash)",
        color: "var(--ink-mid)",
      }}
    >
      {children}
    </a>
  );
}

function FooterColumn({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <h2
        className="mb-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider"
        style={{ color: "var(--ink-black)" }}
      >
        {icon}
        {title}
      </h2>
      <ul className="space-y-2.5">{children}</ul>
    </div>
  );
}

function FooterRoute({ to, children }: { to: string; children: ReactNode }) {
  return (
    <li>
      <Link
        to={to}
        className="kn-ink-link inline-flex min-h-8 items-center text-sm transition-colors duration-200"
        style={{ color: "var(--ink-mid)" }}
      >
        {children}
      </Link>
    </li>
  );
}

function FooterExternal({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="kn-ink-link inline-flex min-h-8 items-center text-sm transition-colors duration-200"
        style={{ color: "var(--ink-mid)" }}
      >
        {children}
      </a>
    </li>
  );
}
