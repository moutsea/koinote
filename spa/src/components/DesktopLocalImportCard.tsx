import { useQueryClient } from "@tanstack/react-query";
import { Download, KeyRound, LoaderCircle } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

import {
  desktopImportLocalMode,
  desktopLocalImportSummary,
  type DesktopLocalImportSummary,
} from "../desktop/offlineStore";
import { interpolate, useI18n } from "../i18n";
import { PaperCard } from "./Ink";

export function DesktopLocalImportCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState<DesktopLocalImportSummary | null>(null);
  const [password, setPassword] = useState("");
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => {
    void desktopLocalImportSummary().then(setSummary).catch(() => undefined);
  }, []);

  if (!summary || (summary.documents === 0 && summary.folders === 0)) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setImporting(true);
    setNotice(null);
    try {
      const result = await desktopImportLocalMode(password);
      setNotice({
        error: false,
        text: interpolate(t.desktopLocalMode.importSuccess, result),
      });
      setPassword("");
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["documents"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["storage-usage"] }),
      ]);
    } catch (error) {
      setNotice({
        error: true,
        text: error instanceof Error && error.message === "local_mode_password_invalid"
          ? t.desktopLocalMode.invalidPassword
          : t.desktopLocalMode.genericError,
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <PaperCard className="p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--ink-wash-strong)", color: "var(--ink-strong)" }}>
          <Download className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="kn-heading-cn font-semibold">{t.desktopLocalMode.importTitle}</h2>
          <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {t.desktopLocalMode.importDescription}
          </p>
        </div>
      </div>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 w-full rounded-lg border px-3.5 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
          style={{ borderColor: "var(--ink-line)" }}
        >
          {t.desktopLocalMode.importButton}
        </button>
      ) : (
        <form className="mt-4 space-y-3" onSubmit={(event) => void submit(event)}>
          <label className="block text-xs font-medium">
            {t.desktopLocalMode.importPassword}
            <span className="relative mt-1.5 block">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--ink-faint)" }} />
              <input
                type="password"
                value={password}
                required
                autoFocus
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-lg border bg-transparent py-2.5 pl-10 pr-3 outline-none"
                style={{ borderColor: "var(--ink-line)" }}
              />
            </span>
          </label>
          <p className="text-xs leading-5" style={{ color: "var(--ink-faint)" }}>
            {t.desktopLocalMode.importWarning}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={importing}
              className="flex-1 rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--ink-line)" }}
            >
              {t.desktopAuth.cancel}
            </button>
            <button
              type="submit"
              disabled={importing}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              style={{ background: "var(--cinnabar)" }}
            >
              {importing && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {importing ? t.desktopLocalMode.importing : t.desktopLocalMode.importButton}
            </button>
          </div>
        </form>
      )}
      {notice && (
        <p className="mt-3 text-xs leading-5" role={notice.error ? "alert" : "status"} style={{ color: notice.error ? "var(--cinnabar)" : "var(--ink-mid)" }}>
          {notice.text}
        </p>
      )}
    </PaperCard>
  );
}
