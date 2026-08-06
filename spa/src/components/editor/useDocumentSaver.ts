import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export type SaveStatus = "idle" | "saving" | "saved" | "failed";

export type DocPatch = Partial<{
  title: string;
  content: string;
  theme: string;
}>;

/** PUT 要求 title/content/theme 一起给，所以待存内容始终是完整三元组 */
type Snapshot = { title: string; content: string; theme: string };

type Entry = {
  pending: Snapshot;
  timer: ReturnType<typeof setTimeout> | null;
  /** 只有标题变过才需要刷侧栏列表，正文变化不用 */
  titleDirty: boolean;
  /** 有改动尚未落库 */
  dirty: boolean;
  /** 正在请求中。此时来的新改动要等这次回来再发第二趟 */
  inFlight: boolean;
  /** in-flight 期间又有改动 */
  resaveNeeded: boolean;
};

export type DocumentSaver = {
  /** 文档首次载入时铺一份基线。已有待存内容时不覆盖 —— 那可能比服务端的新 */
  seed: (docId: string, snapshot: Snapshot) => void;
  /** 记下改动并排入防抖队列 */
  queue: (docId: string, patch: DocPatch) => void;
  /** 立刻存。换主题、关标签、淘汰实例时用 */
  flush: (docId: string) => Promise<void>;
  /** 读当前待存内容，不触发渲染。用于把未存改动合进传给编辑器的 document */
  peek: (docId: string) => Snapshot | null;
  status: (docId: string) => SaveStatus;
  isDirty: (docId: string) => boolean;
  /** 关标签时调用：先存，再丢掉记录 */
  forget: (docId: string) => Promise<void>;
  /**
   * 直接丢掉记录，不保存。
   *
   * 用于「这篇文档即将被删除」：走 forget 会先 PUT 一次，而目标马上就没了 ——
   * 请求要么 404 要么把刚删的内容又写回去。
   */
  drop: (docId: string) => void;
};

export function useDocumentSaver(onTitleCommitted?: () => void): DocumentSaver {
  const entries = useRef<Map<string, Entry>>(new Map());
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

  const doSave = useCallback(
    async (docId: string): Promise<void> => {
      const entry = entries.current.get(docId);
      if (!entry || !entry.dirty) return;

      if (entry.inFlight) {
        // 正在发的那趟带的是旧内容，回来后要再发一趟
        entry.resaveNeeded = true;
        return;
      }

      entry.inFlight = true;
      const sent = { ...entry.pending };
      const sentTitleDirty = entry.titleDirty;
      setStatus(docId, "saving");

      try {
        await mutate.current({ docId, ...sent });
        // 比对发出去的与现在的：期间又改过就不能标记为已保存
        const now = entries.current.get(docId);
        if (now) {
          now.inFlight = false;
          const changedDuringFlight =
            now.pending.title !== sent.title ||
            now.pending.content !== sent.content ||
            now.pending.theme !== sent.theme;
          if (changedDuringFlight || now.resaveNeeded) {
            now.resaveNeeded = false;
            await doSave(docId);
            return;
          }
          now.dirty = false;
          now.titleDirty = false;
        }
        setStatus(docId, "saved");
        if (sentTitleDirty) titleCommitted.current?.();
      } catch {
        const now = entries.current.get(docId);
        if (now) {
          now.inFlight = false;
          // dirty 保持 true：待存内容留着，下次 flush 会重试
        }
        setStatus(docId, "failed");
      }
    },
    [setStatus],
  );

  const seed = useCallback((docId: string, snapshot: Snapshot) => {
    if (entries.current.has(docId)) return;
    entries.current.set(docId, {
      pending: { ...snapshot },
      timer: null,
      titleDirty: false,
      dirty: false,
      inFlight: false,
      resaveNeeded: false,
    });
  }, []);

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
      if (!entry) return;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      await doSave(docId);
    },
    [doSave],
  );

  const forget = useCallback(
    async (docId: string) => {
      await flush(docId);
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
    setStatuses((prev) => {
      if (!(docId in prev)) return prev;
      const next = { ...prev };
      delete next[docId];
      return next;
    });
  }, []);

  const peek = useCallback(
    (docId: string) => entries.current.get(docId)?.pending ?? null,
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
    () => ({ seed, queue, flush, peek, status, isDirty, forget, drop }),
    [seed, queue, flush, peek, status, isDirty, forget, drop],
  );
}
