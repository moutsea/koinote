/**
 * 存储用量的显示与判级。
 *
 * 配额的真值在后端（image_quota.go 的 ImageQuotaBytes）。这里不写死上限 ——
 * 两处各存一份必然会漂，而漂的表现是"控制台说还有空间，上传却被拒"。
 */

/** 用量等级。决定进度条与文字的颜色 */
export type UsageLevel = "normal" | "near" | "full";

/** 到达这个占比就开始警示。0.8 是常见的阈值，没有更深的道理 */
export const NEAR_LIMIT_RATIO = 0.8;

/**
 * 已用占配额的比例，钳在 [0, 1]。
 *
 * 钳上界是因为它要拿去当进度条宽度：超额时（后端允许略微超出，见 recordImageObject
 * 的说明）原始比值会大于 1，直接用会让进度条溢出容器。
 *
 * quota <= 0 时返回 1 而不是 0：那种情况下"能用的空间是零"，进度条应该是满的。
 * 返回 0 会显示成"还很空"，与事实相反。
 */
export function usageRatio(usedBytes: number, quotaBytes: number): number {
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return 1;
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) return 0;
  return Math.min(1, usedBytes / quotaBytes);
}

/** 当前处于哪一级 */
export function usageLevel(usedBytes: number, quotaBytes: number): UsageLevel {
  const ratio = usageRatio(usedBytes, quotaBytes);
  if (ratio >= 1) return "full";
  if (ratio >= NEAR_LIMIT_RATIO) return "near";
  return "normal";
}

/** 还剩多少字节，不会为负 */
export function remainingBytes(usedBytes: number, quotaBytes: number): number {
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return 0;
  const used = Number.isFinite(usedBytes) && usedBytes > 0 ? usedBytes : 0;
  return Math.max(0, quotaBytes - used);
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * 字节转可读字符串。
 *
 * 用 1024 进制但标 KB/MB 而不是 KiB/MiB：后者更准确，但用户在文件管理器里看到的是
 * 前者，跟着系统的说法走比跟着标准走更不容易让人困惑。
 *
 * 小数位随量级变：B 不要小数（"1.0 B" 很傻），KB 及以上给一位，
 * 但整数值不补 ".0"（"5 MB" 比 "5.0 MB" 干净）。
 */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return `0 ${UNITS[0]}`;
  }

  let value = bytes;
  let unit = 0;
  // >= 1024 才进档：1023 B 还是 B，1024 B 是 1 KB
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = unit === 0 ? 0 : 1;
  // 整数值不补小数位。1024 → "1 KB"，1536 → "1.5 KB"
  const rounded = Number(value.toFixed(digits));
  const formatted = rounded.toLocaleString(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });

  return `${formatted} ${UNITS[unit]}`;
}
