import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  ApiError,
  createCustomMediaPlatform,
  deleteCustomMediaPlatform,
  getMediaPlatformSettings,
  MEDIA_PLATFORM_SETTINGS_QUERY_KEY,
  updateCustomMediaPlatform,
  type CustomMediaPlatform,
  type CustomMediaPlatformInput,
} from "../api";
import { confirmAction } from "../confirmAction";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";

type CustomDraft = CustomMediaPlatformInput & { platformId?: string; authTokenHint?: string };

const EMPTY_DRAFT: CustomDraft = {
  name: "",
  endpointUrl: "",
  authToken: "",
  enabled: true,
};

export function MediaPlatformSettingsCard({ localMode }: { localMode: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CustomDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settingsQuery = useQuery({
    queryKey: MEDIA_PLATFORM_SETTINGS_QUERY_KEY,
    queryFn: getMediaPlatformSettings,
    enabled: !localMode,
    retry: false,
  });
  const customPlatforms = settingsQuery.data?.customPlatforms ?? [];
  const customMutation = useMutation({
    mutationFn: async (value: CustomDraft) => {
      const input: CustomMediaPlatformInput = {
        name: value.name,
        endpointUrl: value.endpointUrl,
        enabled: value.enabled,
        ...(value.authToken?.trim() ? { authToken: value.authToken.trim() } : {}),
        ...(value.clearAuthToken ? { clearAuthToken: true } : {}),
      };
      return value.platformId
        ? updateCustomMediaPlatform(value.platformId, input)
        : createCustomMediaPlatform(input);
    },
    onSuccess: async () => {
      setDraft(null);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: MEDIA_PLATFORM_SETTINGS_QUERY_KEY });
    },
    onError: (caught) => setError(mediaSettingsError(caught, t.settingsPage.customMediaSaveFailed, t.errors)),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteCustomMediaPlatform,
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: MEDIA_PLATFORM_SETTINGS_QUERY_KEY });
    },
    onError: (caught) => setError(mediaSettingsError(caught, t.settingsPage.customMediaDeleteFailed, t.errors)),
  });

  function editPlatform(platform: CustomMediaPlatform) {
    setError(null);
    setDraft({
      platformId: platform.platformId,
      name: platform.name,
      endpointUrl: platform.endpointUrl,
      authToken: "",
      clearAuthToken: false,
      authTokenHint: platform.authTokenHint,
      enabled: platform.enabled,
    });
  }

  async function removePlatform(platform: CustomMediaPlatform) {
    if (!(await confirmAction(t.settingsPage.customMediaDeleteConfirm))) return;
    deleteMutation.mutate(platform.platformId);
  }

  if (localMode) {
    return (
      <PaperCard className="p-5 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
        {t.desktopLocalMode.networkDisabled}
      </PaperCard>
    );
  }

  return (
    <div className="space-y-4">
      <PaperCard className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold" style={{ color: "var(--ink-black)" }}>{t.settingsPage.customMediaTitle}</h3>
            <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.settingsPage.customMediaDescription}</p>
          </div>
          {!draft && (
            <button
              type="button"
              onClick={() => { setError(null); setDraft({ ...EMPTY_DRAFT }); }}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition hover:bg-[var(--ink-wash)]"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
            >
              <Plus className="h-4 w-4" />
              {t.settingsPage.customMediaAdd}
            </button>
          )}
        </div>

        {settingsQuery.isLoading && <p className="mt-4 text-sm" style={{ color: "var(--ink-faint)" }}>{t.settingsPage.mediaSettingsLoading}</p>}
        {settingsQuery.isError && <p className="mt-4 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{t.settingsPage.mediaSettingsLoadFailed}</p>}

        <details className="mt-4 rounded-lg border px-3.5 py-3" style={{ borderColor: "var(--ink-line)" }}>
          <summary className="cursor-pointer text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{t.settingsPage.customMediaFormatTitle}</summary>
          <p className="mt-3 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{t.settingsPage.customMediaFormatDescription}</p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-black/[0.04] p-3 text-[11px] leading-5 dark:bg-white/[0.06]"><code>{CUSTOM_REQUEST_EXAMPLE}</code></pre>
        </details>

        {customPlatforms.length > 0 ? (
          <div className="mt-5 divide-y border-y" style={{ borderColor: "var(--ink-line)" }}>
            {customPlatforms.map((platform) => (
              <div key={platform.platformId} className="flex items-center gap-3 py-3.5">
                <Globe2 className="h-4 w-4 shrink-0" style={{ color: "var(--ink-faint)" }} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{platform.name}</span>
                    <span className="text-xs" style={{ color: platform.enabled ? "var(--cinnabar)" : "var(--ink-faint)" }}>{platform.enabled ? t.settingsPage.mediaEnabled : t.settingsPage.mediaDisabled}</span>
                  </div>
                  <p className="mt-1 truncate text-xs" style={{ color: "var(--ink-faint)" }}>{platform.endpointUrl}</p>
                </div>
                <button type="button" onClick={() => editPlatform(platform)} title={t.settingsPage.customMediaEdit} aria-label={t.settingsPage.customMediaEdit} className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-[var(--ink-wash)]" style={{ color: "var(--ink-mid)" }}><Pencil className="h-4 w-4" /></button>
                <button type="button" onClick={() => void removePlatform(platform)} disabled={deleteMutation.isPending} title={t.settingsPage.customMediaDelete} aria-label={t.settingsPage.customMediaDelete} className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ color: "var(--ink-mid)" }}><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        ) : !draft ? (
          <p className="mt-4 text-sm" style={{ color: "var(--ink-faint)" }}>{t.settingsPage.customMediaEmpty}</p>
        ) : null}

        {draft && (
          <form className="mt-5 border-t pt-5" style={{ borderColor: "var(--ink-line)" }} onSubmit={(event) => { event.preventDefault(); setError(null); customMutation.mutate(draft); }}>
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{draft.platformId ? t.settingsPage.customMediaEditTitle : t.settingsPage.customMediaAddTitle}</h4>
              <button type="button" onClick={() => setDraft(null)} title={t.settingsPage.customMediaCancel} aria-label={t.settingsPage.customMediaCancel} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--ink-wash)]" style={{ color: "var(--ink-mid)" }}><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-4 grid gap-4">
              <Field label={t.settingsPage.customMediaName}>
                <input required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)", color: "var(--ink-black)" }} />
              </Field>
              <Field label={t.settingsPage.customMediaEndpoint} hint={t.settingsPage.customMediaEndpointHint}>
                <input required type="url" value={draft.endpointUrl} onChange={(event) => setDraft({ ...draft, endpointUrl: event.target.value })} placeholder="https://example.com/api/koinote/articles" className="w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)", color: "var(--ink-black)" }} />
              </Field>
              <Field label={t.settingsPage.customMediaAuthToken} hint={draft.authTokenHint ? `${t.settingsPage.customMediaAuthTokenHint} (${draft.authTokenHint})` : t.settingsPage.customMediaAuthTokenHint}>
                <input type="password" autoComplete="new-password" value={draft.authToken} onChange={(event) => setDraft({ ...draft, authToken: event.target.value, clearAuthToken: false })} placeholder={draft.authTokenHint ? "••••••••" : ""} className="w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)", color: "var(--ink-black)" }} />
              </Field>
              {draft.authTokenHint && <label className="flex items-center gap-2 text-sm" style={{ color: "var(--ink-strong)" }}><input type="checkbox" checked={Boolean(draft.clearAuthToken)} onChange={(event) => setDraft({ ...draft, clearAuthToken: event.target.checked, authToken: event.target.checked ? "" : draft.authToken })} className="h-4 w-4 accent-[var(--cinnabar)]" />{t.settingsPage.customMediaClearToken}</label>}
              <label className="flex items-center gap-2 text-sm" style={{ color: "var(--ink-strong)" }}><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} className="h-4 w-4 accent-[var(--cinnabar)]" />{t.settingsPage.mediaEnabled}</label>
            </div>
            <button type="submit" disabled={customMutation.isPending} className="mt-5 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60" style={{ background: "var(--cinnabar)" }}>{customMutation.isPending ? t.settingsPage.customMediaSaving : t.settingsPage.customMediaSave}</button>
          </form>
        )}
      </PaperCard>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{label}</span>{hint && <span className="mt-1 block text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{hint}</span>}<span className="mt-2 block">{children}</span></label>;
}

function mediaSettingsError(error: unknown, fallback: string, errors: Record<string, string>) {
  const code = error instanceof ApiError ? error.code : undefined;
  return (code && errors[code]) || fallback;
}

const CUSTOM_REQUEST_EXAMPLE = `POST /your-configured-path
Authorization: Bearer <your-token>
Content-Type: application/json

{
  "version": 1,
  "event": "article.publish",
  "source": { "app": "koinote", "documentId": "...", "revision": 7 },
  "article": {
    "title": "文章标题",
    "markdown": "# 文章标题\\n\\n正文",
    "html": "<h1>文章标题</h1><p>正文</p>",
    "coverImageSource": "https://..."
  }
}`;
