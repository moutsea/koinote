// 页头宽度的路由判定。裸 startsWith 会把 /editor-guide 之类也算成编辑器，
// 症状是某个页面的页头突然通栏 —— 只有真去点那个页面才看得见。
import { isFullBleedRoute } from "./_layout_bundle.mjs";

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  if (got === want) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 得到 ${got}，期望 ${want}`);
  }
}

// ---------- 通栏：编辑器 ----------
eq("/editor 通栏", isFullBleedRoute("/editor"), true);
eq("/editor/ 通栏（末尾斜杠）", isFullBleedRoute("/editor/"), true);
eq("/editor/<docId> 通栏", isFullBleedRoute("/editor/abc-123"), true);
eq("/editor 的深层路径通栏", isFullBleedRoute("/editor/abc/def"), true);

// ---------- 收窄：其它页面 ----------
eq("首页收窄", isFullBleedRoute("/"), false);
eq("空路径收窄", isFullBleedRoute(""), false);
eq("/dashboard 收窄", isFullBleedRoute("/dashboard"), false);
eq("/login 收窄", isFullBleedRoute("/login"), false);
eq("/share/<token> 收窄", isFullBleedRoute("/share/tok3n"), false);

// ---------- 前缀陷阱：这几条是抽出这个函数的理由 ----------
eq("/editor-guide 不算编辑器", isFullBleedRoute("/editor-guide"), false);
eq("/editors 不算编辑器", isFullBleedRoute("/editors"), false);
eq("/editorial 不算编辑器", isFullBleedRoute("/editorial"), false);
eq("/editor2 不算编辑器", isFullBleedRoute("/editor2"), false);
// 不在开头的 /editor 也不算
eq("/docs/editor 不算编辑器", isFullBleedRoute("/docs/editor"), false);

// ---------- 不变量：加了末尾斜杠不该改变判定 ----------
for (const path of [
  "/",
  "/editor",
  "/editor/abc",
  "/dashboard",
  "/login",
  "/editor-guide",
  "/share/tok3n",
]) {
  eq(
    `末尾斜杠不影响判定: ${path}`,
    isFullBleedRoute(path),
    isFullBleedRoute(`${path}/`),
  );
}

console.log(`\nlayout: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
