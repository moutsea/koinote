import type { DocumentSaver } from "./useDocumentSaver";

/** 没有快照只代表未加载，绝不能据此删除文档。 */
export function isUntouchedNewDocument(
  docId: string,
  createdHere: ReadonlySet<string>,
  saver: Pick<DocumentSaver, "peek" | "isDirty" | "isSaving">,
): boolean {
  const snapshot = saver.peek(docId);
  return createdHere.has(docId) && snapshot !== null &&
    !saver.isDirty(docId) && !saver.isSaving(docId) &&
    !snapshot.title.trim() && !snapshot.content.trim();
}

/** 等待所有保存完成后再检查 dirty，避免较早保存完的文档又被用户编辑。 */
export async function saveTabsForClosing(
  docIds: string[],
  saver: Pick<DocumentSaver, "flush" | "isDirty" | "isSaving">,
): Promise<string[]> {
  const results = await Promise.allSettled(docIds.map((id) => saver.flush(id)));
  return docIds.filter((id, index) => {
    const result = results[index];
    return result.status === "fulfilled" && result.value &&
      !saver.isDirty(id) && !saver.isSaving(id);
  });
}
