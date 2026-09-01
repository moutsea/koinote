import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api";
import { conflictDraftKey } from "../../conflictDrafts";
import { replaceDesktopLocalImageURLs } from "../../desktop/offlineImagesCore";
import { useSaveDocument } from "../../documents";

/**
 * 页面级的保存层：按 docId 维护待存内容、防抖定时器与保存状态。
 *
 * 为什么不放在 MarkdownEditor 里（原来就在那儿）：
 * 多开标签之后编辑器实例会被 LRU 淘汰，而卸载时组件里的待存内容就没了 ——
 * 原实现在卸载时只 clearTimeout，防抖窗口内的编辑直接丢。补一次 flush 也治不了
 * 根：保存失败时组件已经不存在，没人重试也没人提示。
 *
 * 待存状态挂在页面上，就与编辑器实例的存亡无关了：淘汰哪个标签都不丢字，失败
 * 状态还能落到标签栏上显形。
 */

export const SAVE_DEBOUNCE_MS = 800;

export type SaveStatus =
  | "idle"
  | "saving"
  | "saved"
  | "failed"
  | "backed-up"
  | "conflict";

export type DocPatch = Partial<{
  title: string;
  content: string;
  theme: string;
}>;

/** PUT 要求 title/content/theme 一起给，所以待存内容始终是完整三元组 */
export type DocumentSnapshot = {
  title: string;
  content: string;
  theme: string;
  revision: number;
};

type StoredDocumentDraft = DocumentSnapshot & {
  conflict: boolean;
};

type Entry = {
  pending: DocumentSnapshot;
  timer: ReturnType<typeof setTimeout> | null;
  /** 只有标题变过才需要刷侧栏列表，正文变化不用 */
  titleDirty: boolean;
  /** 有改动尚未落库 */
  dirty: boolean;
  /** 当前完整保存链。显式 flush 必须等待它，而不是只标记后立即返回 */
  inFlight: Promise<boolean> | null;
  /** 冲突后用户明确选择覆盖远端时，强制为被覆盖的远端状态留一版历史 */
  forceVersion: boolean;
};

export type DocumentSaver = {
  /** 文档首次载入时铺一份基线。已有待存内容时不覆盖 —— 那可能比服务端的新 */
  seed: (docId: string, snapshot: DocumentSnapshot) => void;
  /** 记下改动并排入防抖队列 */
  queue: (docId: string, patch: DocPatch) => void;
  /** 立刻存并返回是否落库成功。换主题、删除、淘汰实例时用 */
  flush: (docId: string) => Promise<boolean>;
  /** 把页面内所有待存内容落库。桌面端登出前用作数据安全屏障。 */
  flushAll: () => Promise<boolean>;
  /** 读当前待存内容，不触发渲染。用于把未存改动合进传给编辑器的 document */
  peek: (docId: string) => DocumentSnapshot | null;
  /** 同步 SQLite 已完成的图片地址替换，不把内部映射误记成一次用户编辑。 */
  applyImageMapping: (docId: string, localURL: string, remoteURL: string) => boolean;
  status: (docId: string) => SaveStatus;
  isDirty: (docId: string) => boolean;
  /** 当前是否有保存请求正在等待响应。 */
  isSaving: (docId: string) => boolean;
  /** 关标签时调用：先存，再丢掉记录 */
  forget: (docId: string) => Promise<void>;
  /**
   * 直接丢掉记录，不保存。
   *
   * 用于「这篇文档即将被删除」：走 forget 会先 PUT 一次，而目标马上就没了 ——
   * 请求要么 404 要么把刚删的内容又写回去。
   */
  drop: (docId: string) => void;
  /** 用最新远端 revision 保存本地/合并稿。仍走 CAS，远端再次变化会继续冲突。 */
  overwrite: (
    docId: string,
    remoteRevision: number,
    patch?: DocPatch,
  ) => Promise<boolean>;
  /** 用户明确采用远端版本时，替换本地待存快照。 */
  acceptRemote: (docId: string, snapshot: DocumentSnapshot) => void;
};

function sameStoredDraft(
  left: StoredDocumentDraft,
  right: StoredDocumentDraft,
): boolean {
  return (
    left.title === right.title &&
    left.content === right.content &&
    left.theme === right.theme &&
    left.revision === right.revision &&
    left.conflict === right.conflict
  );
}

function isDocumentRevisionConflict(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.code === "document_revision_conflict") ||
    (error instanceof Error && error.message === "document_revision_conflict")
  );
}

function clearConflictDraft(docId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(conflictDraftKey(docId));
  } catch {
    // 与写入同理：清理本地兜底失败不应破坏已经完成的服务端操作。
  }
}

export function useDocumentSaver(onTitleCommitted?: () => void): DocumentSaver {
  const entries = useRef<Map<string, Entry>>(new Map());
  const lastStoredDrafts = useRef<Map<string, StoredDocumentDraft>>(new Map());
  // 状态要驱动标签栏渲染，所以进 state；待存内容留在 ref，避免每次打字都渲染
  const [statuses, setStatuses] = useState<Record<string, SaveStatus>>({});

  const save = useSaveDocument();
  // mutateAsync 在 react-query v5 里身份稳定，但存进 ref 更保险 ——
  // 它出现在多个 useCallback 的依赖里，身份一变就连锁重建
  const mutate = useRef(save.mutateAsync);
  mutate.current = save.mutateAsync;

  const titleCommitted = useRef(onTitleCommitted);
  titleCommitted.current = onTitleCommitted;

  const setStatus = useCallback((docId: string, status: SaveStatus) => {
    setStatuses((prev) =>
      prev[docId] === status ? prev : { ...prev, [docId]: status },
    );
  }, []);

  const storeConflictDraft = useCallback(
    (docId: string, snapshot: DocumentSnapshot, conflict: boolean): boolean => {
      if (typeof window === "undefined") return false;
      const draft = { ...snapshot, conflict };
      const key = conflictDraftKey(docId);
      const previous = lastStoredDrafts.current.get(docId);
      if (previous && sameStoredDraft(previous, draft)) {
        try {
          if (window.localStorage.getItem(key) !== null) return true;
        } catch {
          // 继续走写入分支，由统一的失败处理清掉内存记录和可能过期的旧草稿。
        }
      }
      try {
        window.localStorage.setItem(key, JSON.stringify(draft));
        lastStoredDrafts.current.set(docId, draft);
        return true;
      } catch {
        lastStoredDrafts.current.delete(docId);
        clearConflictDraft(docId);
        return false;
      }
    },
    [],
  );

  const clearStoredDraft = useCallback((docId: string) => {
    lastStoredDrafts.current.delete(docId);
    clearConflictDraft(docId);
  }, []);

  const doSave = useCallback(
    (docId: string): Promise<boolean> => {
      const entry = entries.current.get(docId);
      if (!entry || !entry.dirty) return Promise.resolve(true);

      if (entry.inFlight) {
        // 这不是「已有请求就立即返回」：flush 的调用方拿到同一个 Promise，
        // 会一直等到 in-flight 期间积累的新正文也保存完。
        return entry.inFlight;
      }

      const run = (async (): Promise<boolean> => {
        let titleCommittedNeeded = false;
        for (;;) {
          const current = entries.current.get(docId);
          if (!current || !current.dirty) return true;

          const sent = { ...current.pending };
          titleCommittedNeeded ||= current.titleDirty;
          setStatus(docId, "saving");

          try {
            const response = await mutate.current({
              docId,
              title: sent.title,
              content: sent.content,
              theme: sent.theme,
              expectedRevision: sent.revision,
              forceVersion: current.forceVersion,
            });
            const now = entries.current.get(docId);
            if (now) {
              now.pending.revision = response.document.revision;
              now.forceVersion = false;
            }
          } catch (error) {
            // dirty 保持 true：待存内容留着，下次 flush 会重试。
            if (entries.current.has(docId)) {
              const revisionConflict = isDocumentRevisionConflict(error);
              const backedUp = storeConflictDraft(
                docId,
                current.pending,
                revisionConflict,
              );
              setStatus(
                docId,
                revisionConflict
                  ? "conflict"
                  : backedUp
                    ? "backed-up"
                    : "failed",
              );
            }
            return false;
          }

          const now = entries.current.get(docId);
          if (!now) return true;
          const changedDuringFlight =
            now.pending.title !== sent.title ||
            now.pending.content !== sent.content ||
            now.pending.theme !== sent.theme;
          if (changedDuringFlight) {
            // 继续同一条 Promise 保存最新快照。flush 因此是屏障，不会在第二趟
            // 请求发出前就提前 resolve。
            continue;
          }

          now.dirty = false;
          now.titleDirty = false;
          clearStoredDraft(docId);
          setStatus(docId, "saved");
          if (titleCommittedNeeded) titleCommitted.current?.();
          return true;
        }
      })();

      entry.inFlight = run;
      void run.finally(() => {
        const current = entries.current.get(docId);
        if (current?.inFlight === run) current.inFlight = null;
      });
      return run;
    },
    [clearStoredDraft, setStatus, storeConflictDraft],
  );

  const seed = useCallback((docId: string, snapshot: DocumentSnapshot) => {
    const existing = entries.current.get(docId);
    if (existing) {
      if (!existing.dirty && !existing.inFlight) {
        existing.pending = { ...snapshot };
        existing.forceVersion = false;
      }
      return;
    }
    let pending = snapshot;
    let recovered = false;
    let conflicted = false;
    if (typeof window !== "undefined") {
      try {
        const stored = window.localStorage.getItem(conflictDraftKey(docId));
        if (stored) {
          const parsed = JSON.parse(stored) as Partial<StoredDocumentDraft>;
          if (
            typeof parsed.title === "string" &&
            typeof parsed.content === "string" &&
            typeof parsed.theme === "string" &&
            typeof parsed.revision === "number"
          ) {
            pending = {
              title: parsed.title,
              content: parsed.content,
              theme: parsed.theme,
              revision: parsed.revision,
            };
            recovered = true;
            // 旧版本只在真实 revision 冲突时写这份草稿，因此缺少字段要按冲突兼容；
            // 新版本会为普通保存失败显式写 conflict:false。
            conflicted = parsed.conflict !== false;
            lastStoredDrafts.current.set(docId, {
              ...pending,
              conflict: conflicted,
            });
          }
        }
      } catch {
        clearConflictDraft(docId);
      }
    }
    entries.current.set(docId, {
      pending: { ...pending },
      timer: null,
      titleDirty: false,
      dirty: recovered,
      inFlight: null,
      forceVersion: false,
    });
    if (recovered) setStatus(docId, conflicted ? "conflict" : "backed-up");
  }, [setStatus]);

  const queue = useCallback(
    (docId: string, patch: DocPatch) => {
      const entry = entries.current.get(docId);
      if (!entry) return; // 没 seed 过说明文档还没载入，此时的改动不该发
      entry.pending = { ...entry.pending, ...patch };
      entry.dirty = true;
      if (patch.title !== undefined) entry.titleDirty = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void doSave(docId);
      }, SAVE_DEBOUNCE_MS);
    },
    [doSave],
  );

  const flush = useCallback(
    async (docId: string) => {
      const entry = entries.current.get(docId);
      if (!entry) return true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      return doSave(docId);
    },
    [doSave],
  );

  const flushAll = useCallback(async () => {
    const results = await Promise.all([...entries.current.keys()].map(flush));
    return results.every(Boolean);
  }, [flush]);

  const forget = useCallback(
    async (docId: string) => {
      const saved = await flush(docId);
      if (!saved) return;
      const entry = entries.current.get(docId);
      // 存失败就留着记录：下次打开这篇还能接着重试，不静默丢弃
      if (entry && entry.dirty) return;
      entries.current.delete(docId);
      setStatuses((prev) => {
        if (!(docId in prev)) return prev;
        const next = { ...prev };
        delete next[docId];
        return next;
      });
    },
    [flush],
  );

  const drop = useCallback((docId: string) => {
    const entry = entries.current.get(docId);
    if (entry?.timer) clearTimeout(entry.timer);
    entries.current.delete(docId);
    clearStoredDraft(docId);
    setStatuses((prev) => {
      if (!(docId in prev)) return prev;
      const next = { ...prev };
      delete next[docId];
      return next;
    });
  }, [clearStoredDraft]);

  const overwrite = useCallback(
    (docId: string, remoteRevision: number, patch?: DocPatch) => {
      const entry = entries.current.get(docId);
      if (!entry || remoteRevision <= 0) return Promise.resolve(false);
      entry.pending = {
        ...entry.pending,
        ...patch,
        revision: remoteRevision,
      };
      entry.dirty = true;
      entry.titleDirty ||= patch?.title !== undefined;
      entry.forceVersion = true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      setStatus(docId, "saving");
      return doSave(docId);
    },
    [doSave, setStatus],
  );

  const acceptRemote = useCallback(
    (docId: string, snapshot: DocumentSnapshot) => {
      const entry = entries.current.get(docId);
      if (entry?.timer) clearTimeout(entry.timer);
      entries.current.set(docId, {
        pending: { ...snapshot },
        timer: null,
        titleDirty: false,
        dirty: false,
        inFlight: null,
        forceVersion: false,
      });
      clearStoredDraft(docId);
      setStatus(docId, "saved");
    },
    [clearStoredDraft, setStatus],
  );

  const peek = useCallback(
    (docId: string) => entries.current.get(docId)?.pending ?? null,
    [],
  );

  const applyImageMapping = useCallback(
    (docId: string, localURL: string, remoteURL: string) => {
      const entry = entries.current.get(docId);
      if (!entry) return false;
      const content = replaceDesktopLocalImageURLs(
        entry.pending.content,
        new Map([[localURL, remoteURL]]),
      );
      if (content === entry.pending.content) return false;
      entry.pending = { ...entry.pending, content };
      return true;
    },
    [],
  );

  const status = useCallback(
    (docId: string): SaveStatus => statuses[docId] ?? "idle",
    [statuses],
  );

  const isDirty = useCallback(
    (docId: string) => entries.current.get(docId)?.dirty ?? false,
    [],
  );

  const isSaving = useCallback(
    (docId: string) => Boolean(entries.current.get(docId)?.inFlight),
    [],
  );

  // 页面卸载：把所有待存内容发出去。定时器清掉但内容不能丢
  useEffect(() => {
    const map = entries.current;
    return () => {
      for (const [docId, entry] of map) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.dirty) void doSave(docId);
      }
    };
  }, [doSave]);

  // 必须 memo：返回对象字面量的话每次渲染都是新身份，把它放进 effect 依赖数组的
  // 调用方就会变成「每次渲染都跑一遍」。EditorPage 的「URL → 标签状态」effect 正是
  // 这么用的 —— 曾导致关标签后、路由还没更新的那几帧里又把它 activate 回来，
  // 表现为要点两次才关得掉。
  return useMemo(
    () => ({
      seed,
      queue,
      flush,
      flushAll,
      peek,
      applyImageMapping,
      status,
      isDirty,
      isSaving,
      forget,
      drop,
      overwrite,
      acceptRemote,
    }),
    [
      seed,
      queue,
      flush,
      flushAll,
      peek,
      applyImageMapping,
      status,
      isDirty,
      isSaving,
      forget,
      drop,
      overwrite,
      acceptRemote,
    ],
  );
}
