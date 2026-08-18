import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, KeyRound, Pencil, Plus, Trash2, X } from "lucide-react";
import type { User } from "../api";
import {
  AGENT_SETTINGS_QUERY_KEY,
  ApiError,
  createLLMChannel,
  deleteLLMChannel,
  listLLMChannels,
  LLM_CHANNELS_QUERY_KEY,
  updateLLMChannel,
  type LLMChannel,
  type LLMChannelInput,
} from "../api";
import { confirmAction } from "../confirmAction";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";

type ChannelDraft = LLMChannelInput & { channelId?: string };

const EMPTY_DRAFT: ChannelDraft = {
  name: "",
  protocol: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  apiKey: "",
  isDefault: false,
};

export function LLMChannelsCard({ user }: { user: User }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const member = user.membershipTier === "lifetime";
  const [draft, setDraft] = useState<ChannelDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channels = useQuery({
    queryKey: LLM_CHANNELS_QUERY_KEY,
    queryFn: listLLMChannels,
    enabled: member && !user.isLocalMode,
    retry: false,
  });
  const save = useMutation({
    mutationFn: async (value: ChannelDraft) => {
      const input: LLMChannelInput = {
        name: value.name,
        protocol: value.protocol,
        baseUrl: value.baseUrl,
        model: value.model,
        isDefault: value.isDefault,
        ...(value.apiKey?.trim() ? { apiKey: value.apiKey.trim() } : {}),
      };
      return value.channelId
        ? updateLLMChannel(value.channelId, input)
        : createLLMChannel(input);
    },
    async onSuccess() {
      setDraft(null);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: LLM_CHANNELS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: AGENT_SETTINGS_QUERY_KEY });
    },
    onError(value) {
      setError(channelErrorText(value, t.llmChannels.saveFailed, t.errors));
    },
  });
  const remove = useMutation({
    mutationFn: deleteLLMChannel,
    async onSuccess() {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: LLM_CHANNELS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: AGENT_SETTINGS_QUERY_KEY });
    },
    onError(value) {
      setError(channelErrorText(value, t.llmChannels.deleteFailed, t.errors));
    },
  });
  const channelList = channels.data?.channels ?? [];
  const title = useMemo(
    () => draft?.channelId ? t.llmChannels.editTitle : t.llmChannels.addTitle,
    [draft?.channelId, t],
  );

  function editChannel(channel: LLMChannel) {
    setError(null);
    setDraft({
      channelId: channel.channelId,
      name: channel.name,
      protocol: channel.protocol,
      baseUrl: channel.baseUrl,
      model: channel.model,
      apiKey: "",
      isDefault: channel.isDefault,
    });
  }

  async function removeChannel(channel: LLMChannel) {
    if (!(await confirmAction(t.llmChannels.deleteConfirm))) return;
    remove.mutate(channel.channelId);
  }

  return (
    <PaperCard className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <Bot className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--ink-faint)" }} />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold" style={{ color: "var(--ink-black)" }}>
            {t.llmChannels.title}
          </h2>
          <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {member ? t.llmChannels.description : t.llmChannels.membersOnly}
          </p>
        </div>
        {member && !draft && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setDraft({ ...EMPTY_DRAFT, isDefault: channelList.length === 0 });
            }}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition hover:bg-[var(--ink-wash)]"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
          >
            <Plus className="h-4 w-4" />
            {t.llmChannels.add}
          </button>
        )}
      </div>

      {member && channels.isLoading && (
        <p className="mt-4 text-sm" style={{ color: "var(--ink-faint)" }}>{t.llmChannels.loading}</p>
      )}
      {member && channels.isError && (
        <p className="mt-4 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>
          {t.llmChannels.loadFailed}
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{error}</p>
      )}

      {member && channelList.length > 0 && (
        <div className="mt-5 divide-y border-y" style={{ borderColor: "var(--ink-line)" }}>
          {channelList.map((channel) => (
            <div key={channel.channelId} className="flex items-center gap-3 py-3.5">
              <KeyRound className="h-4 w-4 shrink-0" style={{ color: "var(--ink-faint)" }} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium" style={{ color: "var(--ink-strong)" }}>
                    {channel.name}
                  </span>
                  {channel.isDefault && (
                    <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
                      {t.llmChannels.defaultBadge}
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate text-xs" style={{ color: "var(--ink-faint)" }}>
                  {channel.protocol === "anthropic" ? "Anthropic" : "OpenAI-compatible"} · {channel.model} · {channel.apiKeyHint}
                </p>
              </div>
              <button
                type="button"
                onClick={() => editChannel(channel)}
                title={t.llmChannels.edit}
                aria-label={t.llmChannels.edit}
                className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-[var(--ink-wash)]"
                style={{ color: "var(--ink-mid)" }}
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void removeChannel(channel)}
                disabled={remove.isPending}
                title={t.llmChannels.delete}
                aria-label={t.llmChannels.delete}
                className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-[var(--ink-wash)] disabled:opacity-50"
                style={{ color: "var(--ink-mid)" }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {member && !channels.isLoading && channelList.length === 0 && !draft && (
        <p className="mt-4 text-sm" style={{ color: "var(--ink-faint)" }}>{t.llmChannels.empty}</p>
      )}

      {draft && (
        <form
          className="mt-5 border-t pt-5"
          style={{ borderColor: "var(--ink-line)" }}
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate(draft);
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{title}</h3>
            <button
              type="button"
              onClick={() => setDraft(null)}
              title={t.llmChannels.cancel}
              aria-label={t.llmChannels.cancel}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--ink-wash)]"
              style={{ color: "var(--ink-mid)" }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ChannelField label={t.llmChannels.name}>
              <input
                required
                maxLength={80}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-mid)]"
                style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
              />
            </ChannelField>
            <ChannelField label={t.llmChannels.protocol}>
              <div className="grid grid-cols-2 rounded-md border p-1" style={{ borderColor: "var(--ink-line)" }}>
                {(["openai", "anthropic"] as const).map((protocol) => (
                  <button
                    key={protocol}
                    type="button"
                    onClick={() => setDraft({
                      ...draft,
                      protocol,
                      baseUrl: protocol === "anthropic"
                        ? "https://api.anthropic.com"
                        : "https://api.openai.com/v1",
                    })}
                    className="rounded px-2 py-1.5 text-xs font-medium"
                    style={{
                      background: draft.protocol === protocol ? "var(--ink-wash-strong)" : "transparent",
                      color: "var(--ink-strong)",
                    }}
                  >
                    {protocol === "anthropic" ? "Anthropic" : "OpenAI"}
                  </button>
                ))}
              </div>
            </ChannelField>
            <ChannelField label={t.llmChannels.baseUrl}>
              <input
                required
                type="url"
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-mid)]"
                style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
              />
            </ChannelField>
            <ChannelField label={t.llmChannels.model}>
              <input
                required
                maxLength={160}
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-mid)]"
                style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
              />
            </ChannelField>
            <ChannelField label={draft.channelId ? t.llmChannels.apiKeyOptional : t.llmChannels.apiKey}>
              <input
                required={!draft.channelId}
                type="password"
                autoComplete="new-password"
                value={draft.apiKey ?? ""}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-mid)]"
                style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
              />
            </ChannelField>
            <label className="flex items-center gap-2 self-end pb-2 text-sm" style={{ color: "var(--ink-mid)" }}>
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })}
              />
              {t.llmChannels.makeDefault}
            </label>
          </div>
          <button
            type="submit"
            disabled={save.isPending}
            className="mt-5 inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
          >
            <Check className="h-4 w-4" />
            {save.isPending ? t.llmChannels.saving : t.llmChannels.save}
          </button>
        </form>
      )}
    </PaperCard>
  );
}

function ChannelField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium" style={{ color: "var(--ink-mid)" }}>
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function channelErrorText(error: unknown, fallback: string, errors: Record<string, string>): string {
  if (error instanceof ApiError) return (error.code && errors[error.code]) || fallback;
  return fallback;
}
