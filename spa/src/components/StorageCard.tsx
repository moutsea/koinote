import { useQuery } from "@tanstack/react-query";
import { HardDrive, AlertTriangle } from "lucide-react";
import { getStorageUsage } from "../api";
import { useI18n, interpolate } from "../i18n";
import { PaperCard } from "./Ink";
import {
  barSegments,
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
 * 云端存储用量卡片。
 *
 * 统计的是文档正文加图片两项 —— 都是用户存在云端的东西。只算图片会让一个写了
 * 几百篇长文的人看到"用量 0"。
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

  const { usedBytes, documentBytes, imageBytes, quotaBytes } = usage.data;
  const level = usageLevel(usedBytes, quotaBytes);
  const ratio = usageRatio(usedBytes, quotaBytes);
  const color = LEVEL_COLOR[level];

  // 两段宽度的算法在 storage.ts，那里有断言钉住"两段之和 <= 100"
  const segments = barSegments(documentBytes, imageBytes, quotaBytes);

  // 接近上限时两段都转朱砂：此时"哪部分占得多"已经不重要，
  // 重要的是"满了"。正常状态下才用两色区分
  const barColors =
    level === "normal"
      ? { documents: "var(--ink-faint)", images: "var(--cinnabar)" }
      : { documents: "var(--cinnabar)", images: "var(--cinnabar)" };

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
        className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full"
        style={{ background: "var(--ink-wash-strong)" }}
      >
        {/* 两段：文档 + 图片。分段而不是一整条，是为了让下面那两个色块图例
            真的有对应物 —— 只有一整条的话，图例的颜色是没有出处的装饰。
            接近上限时整条转朱砂（下面 barColors 里处理），此时分段意义不大，
            但保持结构一致比多一个分支简单 */}
        <div
          className="h-full transition-[width] duration-500"
          style={{ width: `${segments.documents}%`, background: barColors.documents }}
        />
        <div
          className="h-full transition-[width] duration-500"
          style={{ width: `${segments.images}%`, background: barColors.images }}
        />
      </div>

      {/* 分项：满了之后要知道该删什么。只报总数的话，一个存了 400 MB 图片的人
          可能会去删文档，白费功夫 */}
      <dl
        className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs"
        style={{ color: "var(--ink-mid)" }}
      >
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 rounded-sm"
            style={{ background: barColors.documents }}
          />
          <dt>{t.storage.documents}</dt>
          <dd style={{ color: "var(--ink-strong)" }}>
            {formatBytes(documentBytes, locale)}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 rounded-sm"
            style={{ background: barColors.images }}
          />
          <dt>{t.storage.images}</dt>
          <dd style={{ color: "var(--ink-strong)" }}>
            {formatBytes(imageBytes, locale)}
          </dd>
        </div>
      </dl>

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
