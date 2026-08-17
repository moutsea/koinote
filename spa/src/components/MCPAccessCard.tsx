import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, Check, Copy, Eye, EyeOff, KeyRound, LoaderCircle, Pencil, PlugZap, Trash2, X } from "lucide-react";
import {
  createMCPToken,
  listMCPTokens,
  revealMCPToken,
  revokeMCPToken,
  updateMCPTokenExpiry,
  type User,
} from "../api";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";
import { confirmAction } from "../confirmAction";
import { desktopAPIOrigin, isDesktopRuntime } from "../desktop/runtime";

const MCP_TOKENS_KEY = ["mcp-tokens"] as const;
type ExpiryChoice = 30 | 90 | 180 | 365 | "never";

export function MCPAccessCard({ user }: { user: User }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const active = user.membershipTier === "lifetime";
  const [name, setName] = useState("Codex");
  const [scope, setScope] = useState<"read" | "write">("write");
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>(90);
  const [editingExpiry, setEditingExpiry] = useState<{ tokenId: string; choice: ExpiryChoice } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [revealErrors, setRevealErrors] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const tokens = useQuery({
    queryKey: MCP_TOKENS_KEY,
    queryFn: listMCPTokens,
    enabled: active,
    retry: false,
  });
  const create = useMutation({
    mutationFn: createMCPToken,
    onSuccess(result) {
      setSecret(result.secret);
      void queryClient.invalidateQueries({ queryKey: MCP_TOKENS_KEY });
    },
  });
  const revoke = useMutation({
    mutationFn: revokeMCPToken,
    onSuccess(_result, tokenId) {
      setRevealedSecrets((current) => withoutKey(current, tokenId));
      setRevealErrors((current) => withoutKey(current, tokenId));
      void queryClient.invalidateQueries({ queryKey: MCP_TOKENS_KEY });
    },
  });
  const reveal = useMutation({
    mutationFn: revealMCPToken,
    onMutate(tokenId) {
      setRevealErrors((current) => withoutKey(current, tokenId));
    },
    onSuccess(result, tokenId) {
      setRevealedSecrets((current) => ({ ...current, [tokenId]: result.secret }));
    },
    onError(_error, tokenId) {
      setRevealErrors((current) => ({ ...current, [tokenId]: true }));
    },
  });
  const updateExpiry = useMutation({
    mutationFn: ({ tokenId, choice }: { tokenId: string; choice: ExpiryChoice }) =>
      updateMCPTokenExpiry(tokenId, expiryParams(choice)),
    onSuccess() {
      setEditingExpiry(null);
      void queryClient.invalidateQueries({ queryKey: MCP_TOKENS_KEY });
    },
  });

  const endpoint = isDesktopRuntime()
    ? `${desktopAPIOrigin()}/mcp`
    : `${window.location.origin}/mcp`;

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  }

  return (
    <PaperCard>
      <div className="p-6 sm:p-7">
        <div className="flex items-start gap-3">
          <span
            className="rounded-lg p-2.5"
            style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
          >
            <PlugZap className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="kn-heading-cn text-lg font-bold" style={{ color: "var(--ink-black)" }}>
              {t.mcp.title}
            </h2>
            <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
              {active ? t.mcp.description : t.mcp.membersOnly}
            </p>
          </div>
          {active && (
            <Link
              to="/mcp/activity"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition hover:bg-[var(--ink-wash)]"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
            >
              <Activity className="h-3.5 w-3.5" />
              {t.mcp.activity}
            </Link>
          )}
        </div>

        {!active ? (
          <Link
            to="/pricing"
            className="mt-5 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85"
            style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
          >
            {t.mcp.upgrade}
          </Link>
        ) : (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_140px_auto]">
              <label className="text-xs" style={{ color: "var(--ink-mid)" }}>
                <span className="mb-1.5 block">{t.mcp.tokenName}</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1"
                  style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                />
              </label>
              <label className="text-xs" style={{ color: "var(--ink-mid)" }}>
                <span className="mb-1.5 block">{t.mcp.scope}</span>
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as "read" | "write")}
                  className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
                  style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                >
                  <option value="read">{t.mcp.readOnly}</option>
                  <option value="write">{t.mcp.readWrite}</option>
                </select>
              </label>
              <label className="text-xs" style={{ color: "var(--ink-mid)" }}>
                <span className="mb-1.5 block">{t.mcp.expiry}</span>
                <select
                  value={expiryChoice}
                  onChange={(event) => setExpiryChoice(parseExpiryChoice(event.target.value))}
                  className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
                  style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                >
                  {[30, 90, 180, 365].map((days) => (
                    <option key={days} value={days}>
                      {t.mcp.days.replace("{n}", String(days))}
                    </option>
                  ))}
                  <option value="never">{t.mcp.neverExpires}</option>
                </select>
              </label>
              <button
                type="button"
                disabled={create.isPending || !name.trim()}
                onClick={() => create.mutate({ name: name.trim(), scope, ...expiryParams(expiryChoice) })}
                className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold transition hover:opacity-85 disabled:opacity-60"
                style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
              >
                {create.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {t.mcp.create}
              </button>
            </div>

            {create.isError && <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>{t.mcp.createFailed}</p>}

            {secret && (
              <div
                className="mt-5 rounded-xl border p-4"
                style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
              >
                <p className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>
                  {t.mcp.secretStored}
                </p>
                <SecretRow value={secret} copied={copied === "secret"} onCopy={() => void copy(secret, "secret")} />
                <TokenConfigurations secret={secret} endpoint={endpoint} copyKeyPrefix="created" copied={copied} onCopy={copy} />
              </div>
            )}

            <div className="mt-6 border-t pt-5" style={{ borderColor: "var(--ink-line)" }}>
              <h3 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>
                {t.mcp.activeTokens}
              </h3>
              {tokens.isLoading ? (
                <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>{t.mcp.loading}</p>
              ) : tokens.isError ? (
                <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>{t.mcp.loadFailed}</p>
              ) : tokens.data?.tokens.length ? (
                <div className="mt-3 divide-y" style={{ borderColor: "var(--ink-line)" }}>
                  {tokens.data.tokens.map((token) => (
                    <div key={token.tokenId} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium" style={{ color: "var(--ink-strong)" }}>{token.name}</p>
                        <p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>
                          {token.hint} · {token.scope === "write" ? t.mcp.readWrite : t.mcp.readOnly}
                          {token.expiresAt
                            ? ` · ${t.mcp.expires} ${new Date(token.expiresAt).toLocaleDateString(locale)}`
                            : ` · ${t.mcp.neverExpires}`}
                          {token.lastUsedAt ? ` · ${t.mcp.lastUsed} ${new Date(token.lastUsedAt).toLocaleString(locale)}` : ""}
                        </p>
                      </div>
                      {editingExpiry?.tokenId === token.tokenId ? (
                        <div className="flex items-center gap-1.5">
                          <select
                            aria-label={t.mcp.expiry}
                            value={editingExpiry.choice}
                            onChange={(event) => setEditingExpiry({
                              tokenId: token.tokenId,
                              choice: parseExpiryChoice(event.target.value),
                            })}
                            disabled={updateExpiry.isPending}
                            className="rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none disabled:opacity-60"
                            style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                          >
                            {[30, 90, 180, 365].map((days) => (
                              <option key={days} value={days}>{t.mcp.days.replace("{n}", String(days))}</option>
                            ))}
                            <option value="never">{t.mcp.neverExpires}</option>
                          </select>
                          <button
                            type="button"
                            disabled={updateExpiry.isPending}
                            onClick={() => updateExpiry.mutate(editingExpiry)}
                            aria-label={t.mcp.saveExpiry}
                            title={t.mcp.saveExpiry}
                            className="rounded-lg p-1.5 transition hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
                          >
                            {updateExpiry.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            type="button"
                            disabled={updateExpiry.isPending}
                            onClick={() => setEditingExpiry(null)}
                            aria-label={t.mcp.cancelExpiry}
                            title={t.mcp.cancelExpiry}
                            className="rounded-lg p-1.5 transition hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setEditingExpiry({
                            tokenId: token.tokenId,
                            choice: expiryChoiceForToken(token.expiresAt),
                          })}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
                          style={{ color: "var(--ink-mid)" }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          {t.mcp.editExpiry}
                        </button>
                      )}
                      {revealedSecrets[token.tokenId] ? (
                        <button
                          type="button"
                          onClick={() => setRevealedSecrets((current) => withoutKey(current, token.tokenId))}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          <EyeOff className="h-3.5 w-3.5" />
                          {t.mcp.hide}
                        </button>
                      ) : token.revealable ? (
                        <button
                          type="button"
                          disabled={reveal.isPending && reveal.variables === token.tokenId}
                          onClick={() => reveal.mutate(token.tokenId)}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
                        >
                          {reveal.isPending && reveal.variables === token.tokenId ? (
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                          {t.mcp.reveal}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={revoke.isPending}
                        onClick={async () => {
                          if (await confirmAction(t.mcp.revokeConfirm)) revoke.mutate(token.tokenId);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
                        style={{ color: "var(--ink-mid)" }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t.mcp.revoke}
                      </button>
                      {!token.revealable && (
                        <p className="basis-full text-xs" style={{ color: "var(--ink-faint)" }}>{t.mcp.legacyNotRevealable}</p>
                      )}
                      {revealErrors[token.tokenId] && (
                        <p className="basis-full text-xs" style={{ color: "var(--ink-mid)" }}>{t.mcp.revealFailed}</p>
                      )}
                      {updateExpiry.isError && updateExpiry.variables?.tokenId === token.tokenId && (
                        <p className="basis-full text-xs" style={{ color: "var(--ink-mid)" }}>{t.mcp.expiryUpdateFailed}</p>
                      )}
                      {revealedSecrets[token.tokenId] && (
                        <div className="basis-full rounded-xl border p-4" style={{ borderColor: "var(--ink-line)" }}>
                          <SecretRow
                            value={revealedSecrets[token.tokenId]}
                            copied={copied === `token-${token.tokenId}`}
                            onCopy={() => void copy(revealedSecrets[token.tokenId], `token-${token.tokenId}`)}
                          />
                          <TokenConfigurations
                            secret={revealedSecrets[token.tokenId]}
                            endpoint={endpoint}
                            copyKeyPrefix={`token-${token.tokenId}`}
                            copied={copied}
                            onCopy={copy}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>{t.mcp.empty}</p>
              )}
            </div>
          </>
        )}
      </div>
    </PaperCard>
  );
}

function withoutKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

function parseExpiryChoice(value: string): ExpiryChoice {
  if (value === "never") return "never";
  const days = Number(value);
  return days === 30 || days === 180 || days === 365 ? days : 90;
}

function expiryParams(choice: ExpiryChoice): { expiresInDays?: number; neverExpires?: boolean } {
  return choice === "never" ? { neverExpires: true } : { expiresInDays: choice };
}

function expiryChoiceForToken(expiresAt?: string | null): ExpiryChoice {
  if (!expiresAt) return "never";
  const remainingDays = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000));
  if (remainingDays <= 30) return 30;
  if (remainingDays <= 90) return 90;
  if (remainingDays <= 180) return 180;
  return 365;
}

function SecretRow({ value, copied, onCopy }: { value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/10">{value}</code>
      <CopyButton copied={copied} onClick={onCopy} />
    </div>
  );
}

function TokenConfigurations({
  secret,
  endpoint,
  copyKeyPrefix,
  copied,
  onCopy,
}: {
  secret: string;
  endpoint: string;
  copyKeyPrefix: string;
  copied: string | null;
  onCopy: (value: string, key: string) => Promise<void>;
}) {
  const codex = `export KOINOTE_MCP_TOKEN='${secret}'\n\n[mcp_servers.koinote]\nurl = "${endpoint}"\nbearer_token_env_var = "KOINOTE_MCP_TOKEN"`;
  const claude = `claude mcp add --transport http koinote ${endpoint} --header "Authorization: Bearer ${secret}"`;
  const openCode = `export KOINOTE_MCP_TOKEN='${secret}'\n\n{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "koinote": {
      "type": "remote",
      "url": "${endpoint}",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:KOINOTE_MCP_TOKEN}"
      }
    }
  }
}`;
  const openClaw = `export KOINOTE_MCP_TOKEN='${secret}'\n\nopenclaw mcp add koinote \\
  --url ${endpoint} \\
  --transport streamable-http \\
  --header "Authorization=Bearer \${KOINOTE_MCP_TOKEN}"\n\nopenclaw mcp doctor koinote --probe`;
  const generic = `Transport: Streamable HTTP\nURL: ${endpoint}\nHeader: Authorization: Bearer ${secret}`;
  return (
    <>
      <ConfigBlock title="Codex" value={codex} copied={copied === `${copyKeyPrefix}-codex`} onCopy={() => void onCopy(codex, `${copyKeyPrefix}-codex`)} />
      <ConfigBlock title="Claude Code" value={claude} copied={copied === `${copyKeyPrefix}-claude`} onCopy={() => void onCopy(claude, `${copyKeyPrefix}-claude`)} />
      <ConfigBlock title="OpenCode" value={openCode} copied={copied === `${copyKeyPrefix}-opencode`} onCopy={() => void onCopy(openCode, `${copyKeyPrefix}-opencode`)} />
      <ConfigBlock title="OpenClaw" value={openClaw} copied={copied === `${copyKeyPrefix}-openclaw`} onCopy={() => void onCopy(openClaw, `${copyKeyPrefix}-openclaw`)} />
      <ConfigBlock title="Other MCP clients" value={generic} copied={copied === `${copyKeyPrefix}-generic`} onCopy={() => void onCopy(generic, `${copyKeyPrefix}-generic`)} />
    </>
  );
}

function ConfigBlock({ title, value, copied, onCopy }: { title: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: "var(--ink-strong)" }}>{title}</span>
        <CopyButton copied={copied} onClick={onCopy} compact />
      </div>
      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/5 p-3 text-xs leading-5 dark:bg-white/10">{value}</pre>
    </div>
  );
}

function CopyButton({ copied, onClick, compact = false }: { copied: boolean; onClick: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-black/10 transition hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10 ${compact ? "px-2 py-1 text-xs" : "h-9 px-3 text-xs"}`}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "OK" : "Copy"}
    </button>
  );
}
