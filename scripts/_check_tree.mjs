// 文件树结构计算的校验。重点是环：把文件夹拖进自己的子孙会造出从根上摘不下来的
// 子树，在侧栏里彻底消失且不报错 —— 手点发现不了，只能靠断言。
import {
  ancestorsOf,
  buildTree,
  canCreateSubfolder,
  canDropDoc,
  canDropFolder,
  countDocs,
  countFolders,
  isDescendant,
  MAX_FOLDER_DEPTH,
} from "./_tree_bundle.mjs";
import {
  readTreeDragPayload,
  TREE_DRAG_MIME,
  writeTreeDragPayload,
} from "./_tree_drag_bundle.mjs";
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got),
    w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`);
  }
};
const ok = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
};

const f = (folderId, name, parentFolderId = null) => ({ folderId, name, parentFolderId });
const d = (docId, title, folderId = null, updatedAt = null) => ({
  docId,
  title,
  folderId,
  updatedAt,
});

function fakeDataTransfer() {
  const values = new Map();
  return {
    effectAllowed: "uninitialized",
    setData(type, value) {
      values.set(type, value);
    },
    getData(type) {
      return values.get(type) ?? "";
    },
    values,
  };
}

{
  const transfer = fakeDataTransfer();
  const payload = { kind: "doc", id: "doc-1" };
  writeTreeDragPayload(transfer, payload);
  eq("拖文档声明 move 操作", transfer.effectAllowed, "move");
  eq("自定义 MIME 可恢复文档载荷", readTreeDragPayload(transfer), payload);
  ok("同时写入 text/plain 以启动 WKWebView 拖放", transfer.values.has("text/plain"));
  ok("写入 Koinote 自定义 MIME", transfer.values.has(TREE_DRAG_MIME));
}

{
  const transfer = fakeDataTransfer();
  transfer.setData(
    "text/plain",
    'koinote-tree:{"kind":"folder","id":"folder-1"}',
  );
  eq("自定义 MIME 被过滤时从 text/plain 恢复", readTreeDragPayload(transfer), {
    kind: "folder",
    id: "folder-1",
  });
}

for (const [name, value] of [
  ["无效 JSON", "{"],
  ["未知 kind", '{"kind":"image","id":"1"}'],
  ["空 id", '{"kind":"doc","id":"  "}'],
  ["普通外部文本", "doc-1"],
]) {
  const transfer = fakeDataTransfer();
  transfer.setData(
    "text/plain",
    value.startsWith("{") ? `koinote-tree:${value}` : value,
  );
  eq(`${name} 不会成为文件树拖放`, readTreeDragPayload(transfer), null);
}

{
  const treeRowSource = readFileSync(
    new URL("../spa/src/components/editor/TreeRow.tsx", import.meta.url),
    "utf8",
  );
  const documentListSource = readFileSync(
    new URL("../spa/src/components/editor/DocumentList.tsx", import.meta.url),
    "utf8",
  );
  eq(
    "文档和文件夹 dragstart 都写入 DataTransfer",
    treeRowSource.match(/writeTreeDragPayload\(e\.dataTransfer, payload\)/g)?.length,
    2,
  );
  ok(
    "文件夹落点从 DataTransfer 恢复载荷",
    /onDrop=\{\(e\) => \{[\s\S]*?readTreeDragPayload\(e\.dataTransfer\) \?\? h\.dragging/.test(
      treeRowSource,
    ),
  );
  ok(
    "根落点从 DataTransfer 恢复载荷",
    /onDrop=\{\(e\) => \{[\s\S]*?readTreeDragPayload\(e\.dataTransfer\) \?\? dragging/.test(
      documentListSource,
    ),
  );
  ok(
    "文件夹 drop 阻止冒泡到根落点",
    /onDrop=\{\(e\) => \{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\)/.test(
      treeRowSource,
    ),
  );
  ok(
    "文件夹 dragover 在校验前阻止根落点误亮",
    /onDragOver=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*const payload =/.test(
      treeRowSource,
    ),
  );
  ok(
    "文件夹落点高亮绑定当前拖拽对象",
    /overDrag !== null && overDrag === h\.dragging && acceptsDrop/.test(
      treeRowSource,
    ),
  );
  ok(
    "根落点高亮绑定当前拖拽对象",
    /rootOverDrag !== null &&\s*rootOverDrag === dragging &&\s*rootAcceptsDrop/.test(
      documentListSource,
    ),
  );

  const tauriConfig = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  ok(
    "客户端关闭 Tauri 原生拖放处理器以保留 HTML5 文件树拖放",
    tauriConfig.app.windows.every((window) => window.dragDropEnabled === false),
  );
}

// ---------- buildTree ----------

{
  const tree = buildTree([], []);
  eq("空输入", tree, { folders: [], docs: [] });
}

{
  const tree = buildTree([], [d("d1", "根下文档")]);
  eq("只有根下文档", tree.docs.length, 1);
  eq("没有文件夹", tree.folders.length, 0);
}

{
  const folders = [f("A", "甲"), f("B", "乙", "A"), f("C", "丙", "B")];
  const docs = [d("d1", "在C", "C"), d("d2", "在根")];
  const tree = buildTree(folders, docs);
  eq("根下一个文件夹", tree.folders.length, 1);
  eq("根下一篇文档", tree.docs.length, 1);
  eq("三层嵌套：第二层", tree.folders[0].folders.length, 1);
  eq("三层嵌套：第三层", tree.folders[0].folders[0].folders.length, 1);
  eq("最深层的文档", tree.folders[0].folders[0].folders[0].docs.length, 1);
  eq("文件夹总数", countFolders(tree), 3);
  eq("文档总数", countDocs(tree), 2);
}

// 文件夹按名称排序，文档保持传入顺序（调用方已按 updatedAt 排好）。
// 用拉丁字母断言顺序：CJK 的 localeCompare 结果取决于运行时的排序规则，
// 断言某个具体次序是在测环境而不是测代码。
{
  const tree = buildTree([f("A", "banana"), f("B", "apple"), f("C", "cherry")], []);
  eq(
    "文件夹按名称排序",
    tree.folders.map((x) => x.name),
    ["apple", "banana", "cherry"],
  );
}

// CJK 只要求确定性：同样输入两次得到同样顺序
{
  const once = buildTree([f("A", "乙"), f("B", "甲"), f("C", "丙")], []).folders.map(
    (x) => x.name,
  );
  const twice = buildTree([f("A", "乙"), f("B", "甲"), f("C", "丙")], []).folders.map(
    (x) => x.name,
  );
  eq("CJK 名称排序是确定的", once, twice);
  eq("CJK 排序不丢项", once.length, 3);
}

{
  const tree = buildTree([f("A", "b2"), f("B", "b10"), f("C", "b1")], []);
  eq(
    "名称排序用自然数序（b1 < b2 < b10）",
    tree.folders.map((x) => x.name),
    ["b1", "b2", "b10"],
  );
}

// 脏数据：父指向不存在的文件夹 —— 落到根下，不能丢
{
  const tree = buildTree([f("A", "孤儿", "NOT_EXIST")], [d("d1", "同样孤儿", "NOT_EXIST")]);
  eq("父不存在的文件夹落到根下", tree.folders.length, 1);
  eq("父不存在的文档落到根下", tree.docs.length, 1);
  eq("一个都没丢", countFolders(tree) + countDocs(tree), 2);
}

// 脏数据：自己当自己的父
{
  const tree = buildTree([f("A", "自环", "A")], []);
  eq("自环文件夹落到根下", tree.folders.length, 1);
  eq("自环不产生无限递归", countFolders(tree), 1);
}

// 脏数据：两个文件夹互为父子（环）。
// 环里的文件夹从根上够不到 —— 必须被提到根下，否则整片从侧栏消失且不报错。
{
  const tree = buildTree([f("A", "甲", "B"), f("B", "乙", "A")], []);
  ok("互为父子不栈溢出", true);
  eq("环里的两个文件夹都提到根下", tree.folders.length, 2);
  eq("一个都没丢", countFolders(tree), 2);
}

// 三个成环，外加一个挂在环下的正常文件夹
{
  const tree = buildTree(
    [f("A", "a", "C"), f("B", "b", "A"), f("C", "c", "B"), f("D", "d", "A")],
    [d("x", "在环里的文档", "A")],
  );
  eq("三元环不丢文件夹", countFolders(tree), 4);
  eq("环里文件夹下的文档也不丢", countDocs(tree), 1);
}

// 文档不会因为嵌套而丢失
{
  const folders = [f("A", "a"), f("B", "b", "A"), f("C", "c", "B"), f("D", "d")];
  const docs = [
    d("1", "x", null),
    d("2", "x", "A"),
    d("3", "x", "B"),
    d("4", "x", "C"),
    d("5", "x", "D"),
  ];
  eq("各层文档合计不变", countDocs(buildTree(folders, docs)), 5);
}

// ---------- ancestorsOf / isDescendant ----------

{
  const folders = [f("A", "a"), f("B", "b", "A"), f("C", "c", "B")];
  eq("C 的祖先链", ancestorsOf(folders, "C"), ["B", "A"]);
  eq("根下文件夹无祖先", ancestorsOf(folders, "A"), []);

  ok("A 是 C 的祖先", isDescendant(folders, "A", "C"));
  ok("B 是 C 的祖先", isDescendant(folders, "B", "C"));
  ok("C 不是 A 的祖先", !isDescendant(folders, "C", "A"));
  ok("自己算自己的子孙", isDescendant(folders, "A", "A"));
}

// 环里求祖先不能死循环
{
  const folders = [f("A", "a", "B"), f("B", "b", "A")];
  const chain = ancestorsOf(folders, "A");
  ok("环里求祖先能终止", Array.isArray(chain), `得到 ${JSON.stringify(chain)}`);
}

// ---------- canDropFolder：核心 ----------

{
  const folders = [f("A", "a"), f("B", "b", "A"), f("C", "c", "B"), f("D", "d")];

  eq("拖到自己身上非法", canDropFolder(folders, "A", "A"), {
    ok: false,
    reason: "self",
  });

  // 这条是整个文件树最容易出的错：A 拖进 B（A 的孙）会造出摘不下来的环
  eq("拖进自己的子非法", canDropFolder(folders, "A", "B"), {
    ok: false,
    reason: "cycle",
  });
  eq("拖进自己的孙非法", canDropFolder(folders, "A", "C"), {
    ok: false,
    reason: "cycle",
  });

  eq("拖到当前位置是 noop", canDropFolder(folders, "B", "A"), {
    ok: false,
    reason: "noop",
  });
  eq("根下文件夹拖到根是 noop", canDropFolder(folders, "A", null), {
    ok: false,
    reason: "noop",
  });
  eq("未知文件夹载荷被拒绝", canDropFolder(folders, "GHOST", "D"), {
    ok: false,
    reason: "missing",
  });

  eq("拖进兄弟合法", canDropFolder(folders, "A", "D"), { ok: true });
  eq("深层文件夹拖到根合法", canDropFolder(folders, "C", null), { ok: true });
  eq("子拖进叔父合法", canDropFolder(folders, "B", "D"), { ok: true });
}

// ---------- canDropDoc ----------

{
  const docs = [d("1", "x", null), d("2", "x", "A")];
  eq("文档拖到当前所在是 noop", canDropDoc(docs, "2", "A"), {
    ok: false,
    reason: "noop",
  });
  eq("根下文档拖到根是 noop", canDropDoc(docs, "1", null), {
    ok: false,
    reason: "noop",
  });
  eq("文档拖进文件夹合法", canDropDoc(docs, "1", "A"), { ok: true });
  eq("文档拖出到根合法", canDropDoc(docs, "2", null), { ok: true });
  eq("未知文档载荷被拒绝", canDropDoc(docs, "GHOST", "A"), {
    ok: false,
    reason: "missing",
  });
}

// 不变量：任何合法的文件夹拖放都不会造环
{
  const folders = [f("A", "a"), f("B", "b", "A"), f("C", "c", "B"), f("D", "d"), f("E", "e", "D")];
  for (const dragged of ["A", "B", "C", "D", "E"]) {
    for (const target of [null, "A", "B", "C", "D", "E"]) {
      const verdict = canDropFolder(folders, dragged, target);
      if (!verdict.ok) continue;
      // 应用这次移动，再检查树里的文件夹数量没变（有环就会少）
      const moved = folders.map((x) =>
        x.folderId === dragged ? { ...x, parentFolderId: target } : x,
      );
      eq(
        `合法移动 ${dragged}→${target ?? "根"} 后无人丢失`,
        countFolders(buildTree(moved, [])),
        folders.length,
      );
    }
  }
}

// 右键菜单的深度闸门。+2 写成 +1 的话最深一层的「新建子文件夹」还能点，点了报错
{
  eq("根下还能建", canCreateSubfolder(-1), true);
  eq("depth 0 的文件夹里还能建", canCreateSubfolder(0), true);
  // 渲染在 depth 6 的文件夹在第 7 层，它的子文件夹是第 8 层 —— 正好到上限
  eq("倒数第二层还能建", canCreateSubfolder(MAX_FOLDER_DEPTH - 2), true);
  // depth 7 在第 8 层，再建就是第 9 层，超了
  eq("最深一层不能再建", canCreateSubfolder(MAX_FOLDER_DEPTH - 1), false);
  eq("超出后仍然不能建", canCreateSubfolder(MAX_FOLDER_DEPTH), false);

  // 闸门允许的最深一次新建，落点不能超过上限
  let deepest = -1;
  for (let d = -1; d <= MAX_FOLDER_DEPTH + 2; d += 1) {
    if (canCreateSubfolder(d)) deepest = d;
  }
  eq("闸门允许的最深新建正好落在上限", deepest + 2, MAX_FOLDER_DEPTH);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
