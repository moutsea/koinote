/**
 * 文件树的结构计算，纯函数。
 *
 * 抽出来的理由和 tabPool 一样：这里的错误靠手点发现不了。「把文件夹拖进自己的
 * 子孙」会造出一个从根上摘不下来的环 —— 那棵子树在侧栏里彻底消失，且不报错。
 * 这条必须有断言钉住。
 */

/**
 * 嵌套深度上限，与后端 folders.go 的 maxFolderDepth 对齐。
 *
 * 前端有这个常量只为把「新建子文件夹」置灰 —— 让菜单项点不动比点了报错好。
 * 真正的约束在服务端，改这里不会放宽任何限制。
 */
export const MAX_FOLDER_DEPTH = 8;

/**
 * 在某个容器里还能不能再建一层文件夹。用于把右键菜单的「新建子文件夹」置灰。
 *
 * containerDepth 是容器的 0-based 渲染层号，根是 -1。渲染在 depth d 的文件夹处在第
 * d+1 层，它里面的新文件夹就是第 d+2 层 —— 这个 +2 容易写错成 +1，而错了的表现只是
 * 菜单项能点、点了报错，手点很容易当成后端的问题，所以放在这里由断言钉住。
 */
export function canCreateSubfolder(containerDepth: number): boolean {
  return containerDepth + 2 <= MAX_FOLDER_DEPTH;
}

export type FolderNode = {
  folderId: string;
  name: string;
  /** null = 根下 */
  parentFolderId: string | null;
};

export type DocNode = {
  docId: string;
  title: string;
  updatedAt?: string | null;
  /** null = 根下 */
  folderId: string | null;
};

/** 一层里的内容：先文件夹后文档 */
export type TreeLevel = {
  folders: TreeFolder[];
  docs: DocNode[];
};

export type TreeFolder = FolderNode & TreeLevel;

/**
 * 由两张扁平表拼出树。
 *
 * 排序：文件夹按名称，文档按最近编辑。两种排法不同是有意的 —— 文件夹是用户自己
 * 命的名，字母序便于按名字找；文档的「最近改过的在上面」才是真正有用的顺序。
 *
 * 父 id 指向不存在的文件夹时，该项落到根下而不是被丢掉。这种数据本不该出现，
 * 但真出现了，让用户看见并能移走比让它凭空消失好。
 */
export function buildTree(folders: FolderNode[], docs: DocNode[]): TreeLevel {
  const known = new Set(folders.map((f) => f.folderId));
  const byParent = new Map<string | null, TreeFolder[]>();
  const docsByFolder = new Map<string | null, DocNode[]>();

  const nodes = new Map<string, TreeFolder>();
  for (const f of folders) {
    nodes.set(f.folderId, { ...f, folders: [], docs: [] });
  }

  const parentOf = new Map(folders.map((x) => [x.folderId, x.parentFolderId]));

  /**
   * 这个文件夹该挂在谁下面。
   *
   * 从它往上走：走到 null 说明能到根，原样返回父 id；走回已经踩过的节点说明它在
   * 一个环里（或挂在环下），返回 null 把它提到根下。
   *
   * 提到根下这件事很重要：环里的文件夹从根上够不到，只靠递归守卫的话它们不会
   * 造成死循环，但会从侧栏里整片消失 —— 用户看不见也没法移走，且没有任何报错。
   * 宁可让它出现在根下（能看见、能整理），也不能让它凭空不见。
   */
  const safeParentOf = (f: FolderNode): string | null => {
    if (!f.parentFolderId || !known.has(f.parentFolderId)) return null;
    const walked = new Set<string>([f.folderId]);
    let cur: string | null = f.parentFolderId;
    while (cur) {
      if (walked.has(cur)) return null; // 在环里
      if (!known.has(cur)) return null; // 链条断在不存在的父上
      walked.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return f.parentFolderId;
  };

  for (const f of folders) {
    const node = nodes.get(f.folderId)!;
    const key = safeParentOf(f);
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }

  for (const d of docs) {
    const key = d.folderId && known.has(d.folderId) ? d.folderId : null;
    const list = docsByFolder.get(key) ?? [];
    list.push(d);
    docsByFolder.set(key, list);
  }

  const byName = (a: TreeFolder, b: TreeFolder) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });

  // 已访问集合防环：脏数据造出的环会让递归不终止
  const seen = new Set<string>();
  const level = (parentId: string | null): TreeLevel => ({
    folders: (byParent.get(parentId) ?? []).sort(byName).map((node) => {
      if (seen.has(node.folderId)) return { ...node, folders: [], docs: [] };
      seen.add(node.folderId);
      const child = level(node.folderId);
      return { ...node, folders: child.folders, docs: child.docs };
    }),
    docs: docsByFolder.get(parentId) ?? [],
  });

  return level(null);
}

/** folderId 的所有祖先，从父到根 */
export function ancestorsOf(
  folders: FolderNode[],
  folderId: string,
): string[] {
  const parentOf = new Map(folders.map((f) => [f.folderId, f.parentFolderId]));
  const chain: string[] = [];
  const guard = new Set<string>([folderId]);
  let cur = parentOf.get(folderId) ?? null;
  while (cur && !guard.has(cur)) {
    chain.push(cur);
    guard.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return chain;
}

/** target 是否是 folderId 的子孙（含自身） */
export function isDescendant(
  folders: FolderNode[],
  folderId: string,
  target: string,
): boolean {
  if (folderId === target) return true;
  return ancestorsOf(folders, target).includes(folderId);
}

/**
 * 这个拖放合法吗。
 *
 * 非法情况包括载荷不存在、拖到自己身上、拖进自己的子孙（会造环），以及拖到当前
 * 已在的位置（无意义，但不该报错，静默忽略即可）。
 */
export function canDropFolder(
  folders: FolderNode[],
  dragged: string,
  targetFolderId: string | null,
): { ok: boolean; reason?: "missing" | "self" | "cycle" | "noop" } {
  const draggedFolder = folders.find((folder) => folder.folderId === dragged);
  if (!draggedFolder) return { ok: false, reason: "missing" };
  if (dragged === targetFolderId) return { ok: false, reason: "self" };
  if (targetFolderId && isDescendant(folders, dragged, targetFolderId)) {
    return { ok: false, reason: "cycle" };
  }
  const current = draggedFolder.parentFolderId;
  if (current === targetFolderId) return { ok: false, reason: "noop" };
  return { ok: true };
}

/** 文档的拖放：不会造环，只需排除未知载荷和「已经在那儿」 */
export function canDropDoc(
  docs: DocNode[],
  docId: string,
  targetFolderId: string | null,
): { ok: boolean; reason?: "missing" | "noop" } {
  const draggedDocument = docs.find((document) => document.docId === docId);
  if (!draggedDocument) return { ok: false, reason: "missing" };
  const current = draggedDocument.folderId;
  if (current === targetFolderId) return { ok: false, reason: "noop" };
  return { ok: true };
}

/** 树里的文件夹总数，用于测试与空状态判断 */
export function countFolders(level: TreeLevel): number {
  return level.folders.reduce((n, f) => n + 1 + countFolders(f), 0);
}

/** 树里的文档总数。丢文档的 bug 靠它暴露 */
export function countDocs(level: TreeLevel): number {
  return level.docs.length + level.folders.reduce((n, f) => n + countDocs(f), 0);
}
