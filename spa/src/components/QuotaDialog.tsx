import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import {
  IMAGE_QUOTA_EVENT,
  type ImageQuotaDetail,
} from "../api";
import { useI18n, interpolate } from "../i18n";
import { formatBytes } from "../storage";
import { pushModal } from "../modalStack";
import { STORAGE_USAGE_KEY } from "./StorageCard";

/**
 * 图床超额弹窗。挂在 AppShell 上，监听全局事件。
 *
 * 为什么用弹窗而不是编辑器角落的行内提示：超额和"网络抖了一下"不是一类问题 ——
 * 它不会自己好，用户必须去删东西才能继续贴图。行内提示会被当成暂时性故障而忽略，
 * 然后接着贴图、接着失败。
 *
 * 只在超额那一次弹。之后每次上传失败仍然弹（因为每次都还是超额），这是对的 ——
 * 用户如果没去清理，就该一直被挡住。
 */
export function QuotaDialog() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [detail, setDetail] = useState<ImageQuotaDetail | null>(null);

  useEffect(() => {
    const onQuota = (event: Event) => {
      const custom = event as CustomEvent<ImageQuotaDetail>;
      setDetail(custom.detail);
      // 顺手让控制台的用量卡片失效：用户可能开着两个标签页，
      // 或者关掉弹窗直接去控制台看
      void queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY });
    };
    window.addEventListener(IMAGE_QUOTA_EVENT, onQuota);
    return () => window.removeEventListener(IMAGE_QUOTA_EVENT, onQuota);
  }, [queryClient]);

  useEffect(() => {
    if (!detail) return;
    const releaseModal = pushModal();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      releaseModal();
    };
  }, [detail]);

  if (!detail) return null;

  const used = formatBytes(detail.usedBytes, locale);
  const quota = formatBytes(detail.quotaBytes, locale);

  return (
    // z-[70] 高于账户菜单（z-50）与右键菜单（z-60）：超额是必须先处理的事
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      // 半透明遮罩，点它关闭
      style={{ background: "rgba(0, 0, 0, 0.45)" }}
      onClick={() => setDetail(null)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="kn-quota-title"
        aria-describedby="kn-quota-body"
        // 阻止冒泡，否则点弹窗内部也会关掉
        onClick={(e) => e.stopPropagation()}
        className="kn-ink-bloom w-full max-w-md rounded-xl border p-6 shadow-2xl"
        style={{
          borderColor: "var(--ink-line)",
          background: "var(--ink-paper-soft)",
        }}
      >
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
            style={{
              background: "var(--cinnabar-soft)",
              color: "var(--cinnabar)",
            }}
          >
            <HardDrive className="h-5 w-5" />
          </span>
          <h2
            id="kn-quota-title"
            className="kn-heading-cn text-lg font-semibold"
            style={{ color: "var(--ink-black)" }}
          >
            {t.storage.quotaDialogTitle}
          </h2>
        </div>

        <p
          id="kn-quota-body"
          className="mt-4 text-sm leading-relaxed"
          style={{ color: "var(--ink-strong)" }}
        >
          {interpolate(t.storage.quotaDialogBody, { used, quota })}
        </p>
        <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--ink-mid)" }}>
          {t.storage.quotaDialogHint}
        </p>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={() => setDetail(null)}
            className="rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
          >
            {t.storage.quotaDialogDismiss}
          </button>
          <Link
            to="/settings"
            search={{ section: "membership" }}
            onClick={() => setDetail(null)}
            className="rounded-full px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
            style={{ background: "var(--cinnabar)" }}
          >
            {t.storage.quotaDialogManage}
          </Link>
        </div>
      </div>
    </div>
  );
}
