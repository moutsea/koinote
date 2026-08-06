import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { FileText, Lock } from "lucide-react";
import {
  ApiError,
  getSharedDocument,
  verifySharePassword,
  type SharedDocument,
} from "../api";
import { createEditorExtensions } from "../components/editor/extensions";
import {
  THEME_SCOPE,
  shareContentClass,
  themeToCSS,
} from "../components/editor/themeCss";
import { interpolate, useI18n, type Locale } from "../i18n";
import { PageContainer } from "../components/PageContainer";
import { InkSeal } from "../components/Ink";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function SharePage() {
  const { t } = useI18n();
  const params = useParams({ strict: false }) as { token?: string };
  const token = params.token;

  // 口令验证成功后的正文放在本地，优先于查询结果
  const [unlocked, setUnlocked] = useState<SharedDocument | null>(null);

  const query = useQuery({
    queryKey: ["share", token ?? ""],
    queryFn: () => getSharedDocument(token!),
    enabled: Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const shared = unlocked ?? query.data?.document;
  const needsPassword = !unlocked && query.data?.requiresPassword === true;

  if (query.isLoading) {
    return <Centered>{t.editor.loading}</Centered>;
  }

  if (query.isError || (!shared && !needsPassword)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center">
        <FileText className="h-10 w-10" style={{ color: "var(--ink-faint)" }} />
        <p className="text-sm" style={{ color: "var(--ink-mid)" }}>
          {t.editor.sharedNotFound}
        </p>
        <Link
          to="/"
          className="text-sm font-medium hover:underline"
          style={{ color: "var(--cinnabar)" }}
        >
          {t.editor.sharedOpenApp}
        </Link>
      </div>
    );
  }

  if (needsPassword && token) {
    return (
      <PasswordGate
        token={token}
        onUnlock={(doc) => setUnlocked(doc)}
      />
    );
  }

  if (!shared) {
    return <Centered>{t.editor.loading}</Centered>;
  }

  return <SharedView shared={shared} />;
}

function PasswordGate({
  token,
  onUnlock,
}: {
  token: string;
  onUnlock: (doc: SharedDocument) => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await verifySharePassword(token, password);
      onUnlock(result.document);
    } catch (err) {
      if (err instanceof ApiError) {
        setError((err.code && t.errors[err.code]) || err.message);
      } else {
        setError(t.auth.requestFailed);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <form onSubmit={submit} className="w-full max-w-sm text-center">
        <div
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl"
          style={{ background: "var(--cinnabar-soft)", color: "var(--cinnabar)" }}
        >
          <Lock className="h-5 w-5" />
        </div>
        <p className="mt-4 text-sm" style={{ color: "var(--ink-mid)" }}>
          {t.editor.sharedPasswordPrompt}
        </p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
          aria-label={t.editor.sharePasswordPlaceholder}
          className="mt-4 w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-[var(--cinnabar)] focus:ring-2 focus:ring-[var(--cinnabar-soft)]"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-paper-soft)",
            color: "var(--ink-black)",
          }}
        />

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || password === ""}
          className="mt-4 w-full rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
          style={{ background: "var(--cinnabar)" }}
        >
          {busy ? t.auth.processing : t.editor.sharedPasswordSubmit}
        </button>
      </form>
    </div>
  );
}

function SharedView({ shared }: { shared: SharedDocument }) {
  const { t, locale } = useI18n();

  const extensions = useMemo(
    () => createEditorExtensions(""),
    [],
  );

  // 只读：editable 关掉，但仍用同一套扩展，
  // 这样代码高亮、公式、图片的呈现与编辑器完全一致。
  const editor = useEditor({
    extensions,
    editable: false,
    immediatelyRender: false,
    content: shared.content,
    editorProps: {
      attributes: { class: shareContentClass(shared.theme ?? "") },
    },
  });

  // 分享页要和作者编辑区一致：主题跟着文档一起下发
  const themeId = shared.theme ?? "";
  const themeCSS = themeToCSS(themeId);

  const updatedAt = shared.updatedAt
    ? new Date(shared.updatedAt).toLocaleDateString(DATE_LOCALE[locale])
    : "";

  return (
    <PageContainer className="flex-1 py-10">
      <header
        className="mb-8 border-b pb-5"
        style={{ borderColor: "var(--ink-line)" }}
      >
        <h1
          className="kn-heading-cn text-2xl font-bold tracking-tight"
          style={{ color: "var(--ink-black)" }}
        >
          {shared.title.trim() || t.editor.untitled}
        </h1>
        <p
          className="mt-2 flex items-center gap-2 text-xs"
          style={{ color: "var(--ink-faint)" }}
        >
          {shared.ownerName && (
            <span>{interpolate(t.editor.sharedBy, { name: shared.ownerName })}</span>
          )}
          {shared.ownerName && updatedAt && <span aria-hidden>·</span>}
          {updatedAt && <span>{updatedAt}</span>}
        </p>
      </header>

      {themeCSS && <style>{themeCSS}</style>}
      <div className={themeId ? THEME_SCOPE : undefined}>
        <EditorContent editor={editor} />
      </div>

      {/* 分享页自己收尾，不挂全站页脚（见 AppShell 的 FOOTERLESS_PREFIXES）：
          这是给外人读一篇文档的落地页，末尾塞一堆站内导航是喧宾夺主 */}
      <footer
        className="mt-12 flex flex-col items-center gap-3 border-t pt-5 text-center"
        style={{ borderColor: "var(--ink-line)" }}
      >
        <InkSeal className="h-8 px-0.5 text-[10px]" />
        <Link
          to="/"
          className="kn-ink-link text-xs font-medium transition"
          style={{ color: "var(--ink-faint)" }}
        >
          {t.editor.sharedOpenApp}
        </Link>
      </footer>
    </PageContainer>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-1 items-center justify-center py-24 text-sm"
      style={{ color: "var(--ink-faint)" }}
    >
      {children}
    </div>
  );
}
