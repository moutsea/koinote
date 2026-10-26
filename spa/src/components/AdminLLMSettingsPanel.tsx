import { useEffect, useState } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Image, LoaderCircle, RefreshCw } from "lucide-react";
import {
  ADMIN_LLM_SETTINGS_QUERY_KEY, AGENT_CREDITS_QUERY_KEY, ApiError,
  getAdminLLMSettings, updateAdminLLMSetting,
  type AdminLLMSetting, type AdminLLMSettingInput,
} from "../api";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";
import { mergeAdminLLMSettings, type AdminLLMSettingsData } from "./adminLLMSettingsCore";

const SAVE_MUTATION_KEY = ["admin-llm-settings-save"] as const;

export function AdminLLMSettingsPanel() {
  const { t } = useI18n();
  const saving = useIsMutating({ mutationKey: SAVE_MUTATION_KEY }) > 0;
  const query = useQuery({
    queryKey: ADMIN_LLM_SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => getAdminLLMSettings(signal),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    structuralSharing: (previous, incoming) => mergeAdminLLMSettings(
      previous as AdminLLMSettingsData | undefined, incoming as AdminLLMSettingsData,
    ),
  });
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-3xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.adminLLM.description}</p>
        <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching || saving} className="inline-flex shrink-0 items-center gap-2 rounded-full border px-4 py-2 text-sm disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />{t.admin.refresh}
        </button>
      </div>
      {query.isLoading && <p role="status">{t.admin.loading}</p>}
      {query.isError && <p role="alert" style={{ color: "var(--cinnabar)" }}>{t.adminLLM.loadFailed}</p>}
      <div className="grid items-start gap-5 xl:grid-cols-2">
        {query.data?.settings.map((setting) => <ChannelForm key={setting.kind} setting={setting} />)}
      </div>
    </div>
  );
}

function ChannelForm({ setting }: { setting: AdminLLMSetting }) {
  const { t } = useI18n();
  const labels = t.adminLLM;
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(setting.enabled);
  const [protocol, setProtocol] = useState(setting.protocol);
  const [baseUrl, setBaseUrl] = useState(setting.baseUrl);
  const [model, setModel] = useState(setting.model);
  const [apiKey, setApiKey] = useState("");
  const [thinking, setThinking] = useState(setting.thinking);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setEnabled(setting.enabled); setProtocol(setting.protocol); setBaseUrl(setting.baseUrl);
    setModel(setting.model); setThinking(setting.thinking); setApiKey(""); setError("");
  }, [setting]);
  const image = setting.kind === "image";
  const save = useMutation({
    mutationKey: SAVE_MUTATION_KEY,
    mutationFn: (input: AdminLLMSettingInput) => updateAdminLLMSetting(setting.kind, input),
    async onMutate() {
      await queryClient.cancelQueries({ queryKey: ADMIN_LLM_SETTINGS_QUERY_KEY });
    },
    async onSuccess(result) {
      // Also cover a read started by another observer while the mutation ran.
      await queryClient.cancelQueries({ queryKey: ADMIN_LLM_SETTINGS_QUERY_KEY });
      queryClient.setQueryData<AdminLLMSettingsData>(ADMIN_LLM_SETTINGS_QUERY_KEY, (previous) =>
        mergeAdminLLMSettings(previous, {
          settings: previous?.settings.map((value) => value.kind === setting.kind ? result.setting : value) ?? [result.setting],
        }),
      );
      setApiKey("");
      setSavedVersion(result.setting.version);
      void queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
    },
    onError(value) {
      setError(value instanceof ApiError && value.code === "llm_settings_conflict" ? labels.conflict
        : value instanceof ApiError && value.code === "invalid_llm_settings" ? labels.invalid
        : value instanceof ApiError && value.code === "llm_credential_unavailable" ? labels.keyRecovery : labels.saveFailed);
    },
  });
  const inputClass = "mt-2 w-full rounded-lg border bg-transparent px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[var(--ink-line)] disabled:opacity-60";
  const inputStyle = { borderColor: "var(--ink-line)", color: "var(--ink-strong)" };
  return (
    <PaperCard className="p-5 sm:p-6">
      <form onChange={() => setSavedVersion(null)} onSubmit={(event) => {
        event.preventDefault();
        setSavedVersion(null); setError("");
        // Snapshot before onMutate awaits cancellation or a query updates props.
        save.mutate({
          enabled, protocol, baseUrl: baseUrl.trim(), model: model.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          thinking: !image && protocol === "openai" && thinking, version: setting.version,
        });
      }}>
        <div className="flex items-start gap-3">
          {image ? <Image className="mt-1 h-5 w-5 shrink-0" /> : <Bot className="mt-1 h-5 w-5 shrink-0" />}
          <div>
            <h2 className="font-semibold" style={{ color: "var(--ink-strong)" }}>{image ? labels.image : labels.text}</h2>
            <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{image ? labels.imageHint : labels.textHint}</p>
          </div>
        </div>
        <p className="mt-4 rounded-lg bg-[var(--ink-wash)] px-3 py-2 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>
          {setting.source === "environment" ? labels.environment : labels.managed}
        </p>
        <fieldset disabled={save.isPending} className="mt-5 space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{labels.enabled}</label>
          <label className="block text-sm">{labels.protocol}
            <select value={protocol} onChange={(event) => setProtocol(event.target.value as AdminLLMSetting["protocol"])} className={inputClass} style={inputStyle}>
              <option value="openai">{image ? "OpenAI-compatible Images" : "OpenAI-compatible Chat Completions"}</option>
              {!image && <option value="anthropic">Anthropic Messages</option>}
            </select>
          </label>
          <label className="block text-sm">Base URL
            <input type="url" required={enabled} value={baseUrl} maxLength={2048} onChange={(event) => setBaseUrl(event.target.value)} placeholder={protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} className={inputClass} style={inputStyle} />
          </label>
          <label className="block text-sm">{labels.model}
            <input required={enabled} value={model} maxLength={160} onChange={(event) => setModel(event.target.value)} className={inputClass} style={inputStyle} />
          </label>
          <label className="block text-sm">API Key
            <input type="password" autoComplete="new-password" required={enabled && !setting.hasApiKey} value={apiKey} maxLength={8192} onChange={(event) => setApiKey(event.target.value)} placeholder={setting.hasApiKey ? setting.apiKeyHint : ""} className={inputClass} style={inputStyle} />
            <span className="mt-1.5 block text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{setting.hasApiKey ? labels.keepKey : labels.keyHint}</span>
          </label>
          {!image && protocol === "openai" && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={thinking} onChange={(event) => setThinking(event.target.checked)} /><span>{labels.thinking}<span className="mt-1 block text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{labels.thinkingHint}</span></span></label>}
          {error && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{error}</p>}
          {savedVersion === setting.version && <p role="status" className="flex items-center gap-2 text-sm"><Check className="h-4 w-4" />{labels.saved}</p>}
          <button type="submit" className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>
            {save.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}{save.isPending ? labels.saving : labels.save}
          </button>
        </fieldset>
      </form>
    </PaperCard>
  );
}
