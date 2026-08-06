import { useQuery } from "@tanstack/react-query";
import { HardDrive, AlertTriangle } from "lucide-react";
import { getStorageUsage } from "../api";
import { useI18n, interpolate } from "../i18n";
import { PaperCard } from "./Ink";
import {
  formatBytes,
  remainingBytes,
  usageLevel,
  usageRatio,
  type UsageLevel,
} from "../storage";

/** 用量查询的 key，供别处失效用（超额弹窗要刷新它） */
export const STORAGE_USAGE_KEY = ["storage-usage"] as const;

export function useStorageUsage(enabled = true) {
  return useQuery({
    queryKey: STORAGE_USAGE_KEY,
    queryFn: getStorageUsage,
    enabled,
    // 用量只在上传/删文档后变，不必频繁轮询。进入控制台时取一次就够
    staleTime: 30_000,
  });
}

/** 各等级的颜色。normal 用中墨而不是绿色 —— 正常状态不需要被强调 */
const LEVEL_COLOR: Record<UsageLevel, string> = {
  normal: "var(--ink-mid)",
  near: "var(--cinnabar)",
  full: "var(--cinnabar)",
};

/**
 * 图床用量卡片。
 *
 * 放在控制台的账户信息卡下面 —— 它比邮箱、注册时间更需要被看到，尤其是快满的时候。
 */
export function StorageCard() {
  const { t, locale } = useI18n();
  const usage = useStorageUsage();

  if (usage.isLoading) {
    return (
      <PaperCard className="p-5">
        <CardHeader title={t.storage.title} />
        <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>
          {t.storage.loading}
        </p>
      </PaperCard>
    );
  }

  if (usage.isError || !usage.data) {
    return (
      <PaperCard className="p-5">
        <CardHeader title={t.storage.title} />
        <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>
          {t.storage.loadFailed}
        </p>
      </PaperCard>
    );
  }

  const { usedBytes, quotaBytes } = usage.data;
  const level = usageLevel(usedBytes, quotaBytes);
  const ratio = usageRatio(usedBytes, quotaBytes);
  const color = LEVEL_COLOR[level];

  return (
    <PaperCard className="p-5">
      <CardHeader title={t.storage.title} />

      <div className="mt-3 flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium" style={{ color: "var(--ink-black)" }}>
          {interpolate(t.storage.usedOf, {
            used: formatBytes(usedBytes, locale),
            quota: formatBytes(quotaBytes, locale),
          })}
        </p>
        <p className="shrink-0 text-xs" style={{ color: "var(--ink-faint)" }}>
          {interpolate(t.storage.remaining, {
            remaining: formatBytes(remainingBytes(usedBytes, quotaBytes), locale),
          })}
        </p>
      </div>

      {/* 进度条。role=progressbar 让读屏能播报百分比 —— 纯视觉的条对它是不存在的 */}
      <div
        role="progressbar"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t.storage.title}
        className="mt-2.5 h-2 w-full overflow-hidden rounded-full"
        style={{ background: "var(--ink-wash-strong)" }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          // 至少 2%：用量极小时零宽的条看着像"没在统计"
          style={{ width: `${Math.max(2, ratio * 100)}%`, background: color }}
        />
      </div>

      {/* 只在需要提醒时出文字。正常状态下多一行字是噪音 */}
      {level !== "normal" && (
        <p
          className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed"
          style={{ color }}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{level === "full" ? t.storage.fullHint : t.storage.nearLimitHint}</span>
        </p>
      )}
    </PaperCard>
  );
}

function CardHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2" style={{ color: "var(--ink-faint)" }}>
      <HardDrive className="h-5 w-5" />
      <span className="text-xs font-medium uppercase tracking-wide">{title}</span>
    </div>
  );
}
