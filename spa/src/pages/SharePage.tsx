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
import { interpolate, useI18n, type Locale } from "../i18n";

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
        <FileText className="h-10 w-10 text-neutral-300 dark:text-neutral-600" />
        <p className="text-sm text-neutral-500">{t.editor.sharedNotFound}</p>
        <Link to="/" className="text-sm font-medium text-sky-600 hover:underline">
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
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-100 text-sky-600 dark:bg-sky-950/50 dark:text-sky-300">
          <Lock className="h-5 w-5" />
        </div>
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">
          {t.editor.sharedPasswordPrompt}
        </p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
          aria-label={t.editor.sharePasswordPlaceholder}
          className="mt-4 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none transition focus:border-sky-500 dark:border-white/15 dark:bg-white/5"
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
          className="mt-4 w-full rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:opacity-60"
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
      attributes: {
        class: "prose prose-neutral dark:prose-invert max-w-none focus:outline-none",
      },
    },
  });

  const updatedAt = shared.updatedAt
    ? new Date(shared.updatedAt).toLocaleDateString(DATE_LOCALE[locale])
    : "";

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8 border-b border-black/5 pb-5 dark:border-white/10">
        <h1 className="text-2xl font-bold tracking-tight">
          {shared.title.trim() || t.editor.untitled}
        </h1>
        <p className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
          {shared.ownerName && (
            <span>{interpolate(t.editor.sharedBy, { name: shared.ownerName })}</span>
          )}
          {shared.ownerName && updatedAt && <span aria-hidden>·</span>}
          {updatedAt && <span>{updatedAt}</span>}
        </p>
      </header>

      <EditorContent editor={editor} />

      <footer className="mt-12 border-t border-black/5 pt-5 text-center dark:border-white/10">
        <Link
          to="/"
          className="text-xs font-medium text-neutral-400 transition hover:text-sky-600"
        >
          {t.editor.sharedOpenApp}
        </Link>
      </footer>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center py-24 text-sm text-neutral-400">
      {children}
    </div>
  );
}
