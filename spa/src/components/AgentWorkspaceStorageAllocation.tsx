import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, updateAgentWorkspaceStorage, type AgentWorkspaceStorage } from "../api";
import { interpolate, useI18n } from "../i18n";
import { formatBytes } from "../storage";
import { STORAGE_USAGE_KEY } from "./StorageCard";

const MIB = 1024 * 1024;

export function AgentWorkspaceStorageAllocation({ storage }: { storage: AgentWorkspaceStorage }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(String(storage.allocatedBytes / MIB));
  useEffect(() => setAmount(String(storage.allocatedBytes / MIB)), [storage.allocatedBytes]);
  const allocation = useMutation({
    mutationFn: updateAgentWorkspaceStorage,
    onSuccess: async (result) => {
      await queryClient.cancelQueries({ queryKey: ["agent-workspace-storage"] });
      queryClient.setQueryData(["agent-workspace-storage"], result);
      await queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY });
    },
    onError: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-workspace-storage"] }),
        queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY }),
      ]);
    },
  });
  const includedBytes = storage.quotaBytes - storage.allocatedBytes;
  const minimum = Math.ceil(Math.max(0, storage.usedBytes - includedBytes) / MIB);
  const maximum = Math.floor((storage.allocatedBytes + storage.availableBytes) / MIB);
  const amountMiB = Number(amount);
  const bytes = amountMiB * MIB;
  const valid = amount.trim() !== "" && Number.isSafeInteger(amountMiB) && amountMiB >= minimum && amountMiB <= maximum;
  const errorCode = allocation.error instanceof ApiError ? allocation.error.code : undefined;
  const errorMessage = errorCode === "storage_allocation_insufficient" ? t.agentWorkspace.storageAllocationInsufficient
    : errorCode === "storage_allocation_in_use" ? t.agentWorkspace.storageAllocationInUse
    : t.agentWorkspace.storageAllocationFailed;

  return <form className="mt-5 space-y-4 border-t pt-5" style={{ borderColor: "var(--ink-line)" }} onSubmit={(event) => {
    event.preventDefault();
    if (valid && bytes !== storage.allocatedBytes && !allocation.isPending) allocation.mutate(bytes);
  }}>
    <p className="text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.storageAllocationDescription}</p>
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div><dt style={{ color: "var(--ink-faint)" }}>{t.agentWorkspace.storageIncluded}</dt><dd className="mt-1 font-semibold">{formatBytes(includedBytes, locale)}</dd></div>
      <div><dt style={{ color: "var(--ink-faint)" }}>{t.agentWorkspace.storagePersonalAvailable}</dt><dd className="mt-1 font-semibold">{formatBytes(storage.availableBytes, locale)} / {formatBytes(storage.personalQuotaBytes, locale)}</dd></div>
    </dl>
    <label className="block text-sm font-medium" htmlFor="agent-storage-allocation">{t.agentWorkspace.storageAllocationAmount}</label>
    <input id="agent-storage-allocation" type="number" required min={minimum} max={maximum} step={1} value={amount} disabled={allocation.isPending}
      aria-describedby="agent-storage-allocation-hint" onChange={(event) => { setAmount(event.target.value); allocation.reset(); }}
      className="block w-full max-w-xs rounded-lg border bg-transparent px-3 py-2 text-sm disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }} />
    <p id="agent-storage-allocation-hint" className="text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{interpolate(t.agentWorkspace.storageAllocationRange, { min: String(minimum), max: String(maximum) })}</p>
    {valid && <p className="text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{interpolate(t.agentWorkspace.storageAllocationPreview, {
      quota: formatBytes(includedBytes + bytes, locale),
      remaining: formatBytes(Math.max(0, storage.personalQuotaBytes - storage.personalUsedBytes + storage.allocatedBytes - bytes), locale),
    })}</p>}
    {allocation.isError && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{errorMessage}</p>}
    {allocation.isSuccess && <p role="status" className="text-sm" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.storageAllocationSaved}</p>}
    <button type="submit" disabled={!valid || bytes === storage.allocatedBytes || allocation.isPending} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>
      {allocation.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}
      {allocation.isPending ? t.agentWorkspace.storageAllocationSaving : t.agentWorkspace.storageAllocationSave}
    </button>
  </form>;
}
