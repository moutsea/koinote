import { ApiError, apiJson } from "./api";
import { isDesktopRuntime } from "./desktop/runtime";
import type { Messages } from "./i18n/types";

export type FeishuAccount = { openId: string; name: string };
export type FeishuSyncResult = { url: string; created: boolean; revision: number };

export function getFeishuAccount() {
  return apiJson<{ account: FeishuAccount | null; configured: boolean }>("/api/feishu/account");
}

export function startFeishuOAuth(client?: "desktop" | "desktop-local") {
  const query = client ? `?client=${client}` : "";
  return apiJson<{ url: string }>(`/api/feishu/oauth/start${query}`);
}

export function disconnectFeishu() {
  return apiJson<{ success: boolean }>("/api/feishu/account", { method: "DELETE" });
}

export async function syncFeishuDocument(docId: string) {
  if (isDesktopRuntime()) {
    const { desktopPrepareDocumentForRemoteMutation } = await import("./desktop/offlineStore");
    if (!(await desktopPrepareDocumentForRemoteMutation(docId))) {
      throw new ApiError(409, "Document sync required", "feishu_save_required");
    }
  }
  return apiJson<FeishuSyncResult>(`/api/documents/${encodeURIComponent(docId)}/feishu-sync`, { method: "POST" });
}

export function feishuErrorText(error: unknown, copy: Messages["feishu"]): string {
  const messages: Record<string, string> = {
    membership_required: copy.membersOnly,
    feishu_not_configured: copy.unavailable,
    feishu_account_not_bound: copy.notBound,
    feishu_token_invalid: copy.tokenInvalid,
    feishu_busy: copy.busy,
    feishu_server_busy: copy.serverBusy,
    feishu_content_limit: copy.contentLimit,
    feishu_image_failed: copy.imageFailed,
    feishu_permission_denied: copy.permissionDenied,
    feishu_save_required: copy.saveFailed,
  };
  return (error instanceof ApiError && error.code && messages[error.code]) || copy.failed;
}
