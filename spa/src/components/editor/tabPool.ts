/**
 * 标签页的两份状态与它们的迁移规则，抽成纯函数。
 *
 * 抽出来是因为这是最容易出错的一段：谁在池里、谁该被淘汰、关掉当前标签之后激活
 * 谁 —— 靠手点覆盖不全，尤其「关掉最后一个」「关掉的正好是当前」这类边界。
 *
 * openTabs 是标签栏顺序，可以很长；liveIds 是 MRU 序的挂载池，有上限。
 * 当前标签恒定在池内 —— activate 保证这点。
 */

/** 同时保持存活的编辑器实例数上限 */
export const LIVE_LIMIT = 3;

export type TabState = {
  /** 标签栏顺序 */
  openTabs: string[];
  /** 挂载池，队首最近使用 */
  liveIds: string[];
  activeDocId: string | null;
};

export const EMPTY_TABS: TabState = {
  openTabs: [],
  liveIds: [],
  activeDocId: null,
};

/**
 * 激活（或打开）一篇文档。
 *
 * 不在 openTabs 里就追加到末尾；无论如何都把它提到 liveIds 队首。
 * 返回被挤出池子的 docId，调用方需要先把它们的待存内容 flush 掉再卸载。
 */
export function activate(
  state: TabState,
  docId: string,
  limit = LIVE_LIMIT,
): { next: TabState; evicted: string[] } {
  const openTabs = state.openTabs.includes(docId)
    ? state.openTabs
    : [...state.openTabs, docId];

  const live = [docId, ...state.liveIds.filter((id) => id !== docId)];
  const evicted = live.slice(limit);

  return {
    next: { openTabs, liveIds: live.slice(0, limit), activeDocId: docId },
    evicted,
  };
}

/**
 * 关闭一个标签。
 *
 * 关的是当前标签时，激活权交给它右边那个；右边没有就交给左边。这与浏览器的行为
 * 一致 —— 按顺序读下去的人期望关掉一篇后落到下一篇，而不是跳回开头。
 */
export function close(
  state: TabState,
  docId: string,
): { next: TabState; evicted: string[] } {
  const index = state.openTabs.indexOf(docId);
  if (index === -1) return { next: state, evicted: [] };

  const openTabs = state.openTabs.filter((id) => id !== docId);
  const liveIds = state.liveIds.filter((id) => id !== docId);

  let activeDocId = state.activeDocId;
  if (state.activeDocId === docId) {
    // 原位置右边的那个（关掉后它顶上来占据同一个下标），没有则取左边
    activeDocId = openTabs[index] ?? openTabs[index - 1] ?? null;
  }

  // 关掉的这个要卸载；它自己不在 evicted 里 —— 调用方按 docId 单独处理
  const base: TabState = { openTabs, liveIds, activeDocId };
  if (!activeDocId) return { next: base, evicted: [] };

  // 新的当前标签必须在池内
  const promoted = activate(base, activeDocId);
  return promoted;
}

/** 文档被删除：从两份状态里一起摘掉，逻辑与关标签相同 */
export const removeDeleted = close;

/**
 * 用最新文档列表回收已经不存在的标签。
 *
 * preserveIds 用于保护仍有编辑器内待存内容的文档：即使云端已经删除，也不能在
 * 内容落到本地库之前把标签和正文实例一起卸载。
 */
export function removeUnavailable(
  state: TabState,
  availableIds: Iterable<string>,
  preserveIds: Iterable<string> = [],
): { next: TabState; removed: string[] } {
  const available = new Set(availableIds);
  for (const id of preserveIds) available.add(id);
  const removed = state.openTabs.filter((id) => !available.has(id));
  let next = state;
  for (const id of removed) next = close(next, id).next;
  return { next, removed };
}

/**
 * 用服务端返回的标签组初始化。
 *
 * liveIds 只放 activeDocId：其余标签的实例等真的被点开再挂 —— 恢复会话时一次挂
 * 三个编辑器（每个都带 KaTeX、代码高亮、图片 node view）会让首屏明显卡一下。
 */
export function hydrate(
  openTabs: string[],
  activeDocId: string | null,
): TabState {
  const valid = activeDocId && openTabs.includes(activeDocId) ? activeDocId : (openTabs[0] ?? null);
  return {
    openTabs,
    liveIds: valid ? [valid] : [],
    activeDocId: valid,
  };
}
