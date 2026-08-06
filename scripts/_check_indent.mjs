import {
  chevronX,
  docIconX,
  docPad,
  folderIconRightX,
  folderIconX,
  folderPad,
  guideX,
} from "./_indent_bundle.mjs";

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${expected}, got ${actual}`);
}

// —— 这条是这次改动的核心诉求：文档要缩进到父文件夹图标的右侧 ——
for (let d = 0; d < 8; d += 1) {
  ok(
    `depth ${d}: 子文档图标在父文件夹图标右沿之外`,
    docIconX(d + 1) > folderIconRightX(d),
    `doc ${docIconX(d + 1)} vs folder right edge ${folderIconRightX(d)}`,
  );
}

// 同层的文件夹图标和文档图标要对齐，否则同一层看起来是错开的两列
for (let d = 0; d < 8; d += 1) {
  eq(`depth ${d}: 同层图标对齐`, docIconX(d), folderIconX(d));
}

// 每层都要真的往右走，且步长一致
for (let d = 0; d < 8; d += 1) {
  ok(`depth ${d}: 文件夹逐层右移`, folderPad(d + 1) > folderPad(d));
  ok(`depth ${d}: 文档逐层右移`, docPad(d + 1) > docPad(d));
  eq(`depth ${d}: 文件夹步长`, folderPad(d + 1) - folderPad(d), 28);
  eq(`depth ${d}: 文档步长`, docPad(d + 1) - docPad(d), 28);
}

// 步长下限：小于等于 14 的话子文档就顶不到父文件夹图标右边，层级看起来是平的
ok("步长大于图标清空所需的下限", folderPad(1) - folderPad(0) > 14);

// 最深一层（后端 maxFolderDepth = 8）在拖到最宽时要留得下标题
ok(
  "depth 8 在最宽侧栏下留得下标题",
  docIconX(8) + 60 <= 520,
  `icon at ${docIconX(8)}, 最宽 520`,
);

// 引导线落在本行 chevron 中心
for (let d = 0; d < 8; d += 1) {
  eq(`depth ${d}: 引导线在 chevron 中心`, guideX(d), chevronX(d) + 6);
  // 线只跨越它自己的子孙行（depth >= d+1），不能压到那些行的 chevron 上
  ok(
    `depth ${d}: 引导线在子项 chevron 左侧`,
    guideX(d) < chevronX(d + 1),
    `guide ${guideX(d)} vs child chevron ${chevronX(d + 1)}`,
  );
  // 相邻两层的线要分得开，不然深层嵌套会糊成一片
  ok(
    `depth ${d}: 相邻引导线分得开`,
    guideX(d + 1) - guideX(d) >= 12,
    `间距 ${guideX(d + 1) - guideX(d)}`,
  );
}

// 根层不缩进，但文档仍要和根文件夹的图标对齐
eq("根文件夹不缩进", folderPad(0), 0);
eq("根文档补 chevron 宽度", docPad(0), 26);

console.log(`\nindent: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
