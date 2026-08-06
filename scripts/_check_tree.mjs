// 文件树结构计算的校验。重点是环：把文件夹拖进自己的子孙会造出从根上摘不下来的
// 子树，在侧栏里彻底消失且不报错 —— 手点发现不了，只能靠断言。
import {
  ancestorsOf,
  buildTree,
  canDropDoc,
  canDropFolder,
  countDocs,
  countFolders,
  isDescendant,
} from "./_tree_bundle.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
