import type { DocumentSaver, DocumentSnapshot } from "./useDocumentSaver";

/** 改名与正文编辑共用保存队列，不能用文件树摘要拼一个 PUT 覆盖正文。 */
export async function renameDocumentTitle(
  docId: string,
  title: string,
  saver: Pick<DocumentSaver, "peek" | "seed" | "queue" | "flush" | "isDirty" | "isSaving" | "rollbackTitle">,
  load: (docId: string) => Promise<DocumentSnapshot>,
  refreshCleanSnapshot: () => boolean = () => true,
): Promise<boolean> {
  if ((!saver.peek(docId) || refreshCleanSnapshot()) && !saver.isDirty(docId) && !saver.isSaving(docId)) {
    const snapshot = await load(docId);
    // 请求期间可能发生编辑或保存；不以较早的响应覆盖本地新内容/新 revision。
    const current = saver.peek(docId);
    // 已挂载的编辑器由 LiveEditor 同步远端正文，不能只换快照而留下旧编辑器内容。
    if ((!current || refreshCleanSnapshot()) && !saver.isDirty(docId) && !saver.isSaving(docId) &&
      (!current || current.revision <= snapshot.revision)) saver.seed(docId, snapshot);
  }
  const current = saver.peek(docId);
  if (!current) return false;
  const before = { ...current };
  const wasDirty = saver.isDirty(docId);
  saver.queue(docId, { title });
  let saved = false;
  try {
    saved = await saver.flush(docId);
    return saved;
  } finally {
    // 输入框保留草稿供重试，保存队列撤回失败的标题，Esc 退出后不会再提交它。
    if (!saved) saver.rollbackTitle(docId, title, before, wasDirty);
  }
}
