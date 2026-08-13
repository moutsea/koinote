import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, LoaderCircle } from "lucide-react";
import {
  getDocumentHistorySettings,
  updateDocumentHistorySettings,
  type DocumentHistorySettings,
  type User,
} from "../api";
import { useI18n, interpolate } from "../i18n";
import { PaperCard } from "./Ink";

export const DOCUMENT_HISTORY_SETTINGS_KEY = ["document-history-settings"] as const;

export function DocumentHistorySettingsCard({ user }: { user: User }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const active = user.membershipTier === "lifetime";
  const settings = useQuery({
    queryKey: DOCUMENT_HISTORY_SETTINGS_KEY,
    queryFn: getDocumentHistorySettings,
    enabled: active,
    retry: false,
  });
  const [draft, setDraft] = useState<Pick<
    DocumentHistorySettings,
    "enabled" | "perDocumentMax" | "mcpEnabled"
  > | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const current = settings.data.settings;
    setDraft({
      enabled: current.enabled,
      perDocumentMax: current.perDocumentMax,
      mcpEnabled: current.mcpEnabled,
    });
  }, [settings.data]);

  const save = useMutation({
    mutationFn: updateDocumentHistorySettings,
    onSuccess(result) {
      queryClient.setQueryData(DOCUMENT_HISTORY_SETTINGS_KEY, result);
      setDraft({
        enabled: result.settings.enabled,
        perDocumentMax: result.settings.perDocumentMax,
        mcpEnabled: result.settings.mcpEnabled,
      });
    },
  });

  const current = settings.data?.settings;
  const dirty = Boolean(
    draft && current &&
      (draft.enabled !== current.enabled ||
        draft.perDocumentMax !== current.perDocumentMax ||
        draft.mcpEnabled !== current.mcpEnabled),
  );

  return (
    <PaperCard className="p-6 sm:p-7">
      <div className="flex items-start gap-3">
        <span
          className="rounded-lg p-2.5"
          style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
        >
          <History className="h-5 w-5" />
        </span>
        <div>
          <h2 className="kn-heading-cn text-lg font-bold" style={{ color: "var(--ink-black)" }}>
            {t.documentHistorySettings.title}
          </h2>
          <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {active ? t.documentHistorySettings.description : t.documentHistorySettings.membersOnly}
          </p>
        </div>
      </div>

      {!active ? null : settings.isLoading || !draft || !current ? (
        <p className="mt-5 text-sm" style={{ color: "var(--ink-faint)" }}>
          {settings.isError ? t.documentHistorySettings.loadFailed : t.documentHistorySettings.loading}
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <SettingRow
            title={t.documentHistorySettings.enabled}
            description={t.documentHistorySettings.enabledHint}
          >
            <Toggle
              label={t.documentHistorySettings.enabled}
              checked={draft.enabled}
              disabled={!active || save.isPending}
              onChange={(enabled) => setDraft({ ...draft, enabled })}
            />
          </SettingRow>

          <SettingRow
            title={t.documentHistorySettings.perDocumentMax}
            description={interpolate(t.documentHistorySettings.limitHint, {
              accountMax: String(current.accountMax),
            })}
          >
            <input
              type="number"
              min={1}
              max={100}
              aria-label={t.documentHistorySettings.perDocumentMax}
              value={draft.perDocumentMax}
              disabled={!active || save.isPending}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 100) {
                  setDraft({ ...draft, perDocumentMax: value });
                }
              }}
              className="w-24 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none disabled:opacity-50"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
            />
          </SettingRow>

          <SettingRow
            title={t.documentHistorySettings.mcpEnabled}
            description={t.documentHistorySettings.mcpEnabledHint}
          >
            <Toggle
              label={t.documentHistorySettings.mcpEnabled}
              checked={draft.mcpEnabled}
              disabled={!active || !draft.enabled || save.isPending}
              onChange={(mcpEnabled) => setDraft({ ...draft, mcpEnabled })}
            />
          </SettingRow>

          <div className="flex items-center justify-end gap-3 border-t pt-4" style={{ borderColor: "var(--ink-line)" }}>
            {save.isError && (
              <span className="text-xs" style={{ color: "var(--ink-mid)" }}>
                {t.documentHistorySettings.saveFailed}
              </span>
            )}
            {save.isSuccess && !dirty && (
              <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
                {t.documentHistorySettings.saved}
              </span>
            )}
            <button
              type="button"
              disabled={!active || !dirty || save.isPending}
              onClick={() => save.mutate(draft)}
              className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
              style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
            >
              {save.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {t.documentHistorySettings.save}
            </button>
          </div>
        </div>
      )}
    </PaperCard>
  );
}

function SettingRow({ title, description, children }: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-5">
      <div>
        <p className="text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{title}</p>
        <p className="mt-1 text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-6 w-11 rounded-full border transition disabled:opacity-40"
      style={{
        borderColor: "var(--ink-line)",
        background: checked ? "var(--ink-strong)" : "var(--ink-wash-strong)",
      }}
    >
      <span
        className={`absolute top-0.5 h-4.5 w-4.5 rounded-full transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`}
        style={{ background: "var(--ink-paper)" }}
      />
    </button>
  );
}
