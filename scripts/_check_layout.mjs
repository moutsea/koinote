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

// ---------- 通栏 ----------
eq("/editor 通栏", isFullBleedRoute("/editor"), true);
eq("/editor/ 通栏（末尾斜杠）", isFullBleedRoute("/editor/"), true);
eq("/editor/<docId> 通栏", isFullBleedRoute("/editor/abc-123"), true);
eq("/editor 的深层路径通栏", isFullBleedRoute("/editor/abc/def"), true);
eq("/dashboard 通栏", isFullBleedRoute("/dashboard"), true);
eq("首页通栏", isFullBleedRoute("/"), true);
eq("空路径按首页算，通栏", isFullBleedRoute(""), true);

// ---------- 收窄：登录表单该窄，分享页要控行长 ----------
eq("/login 收窄", isFullBleedRoute("/login"), false);
eq("/register 收窄", isFullBleedRoute("/register"), false);
eq("/share/<token> 收窄", isFullBleedRoute("/share/tok3n"), false);

// 关键：根路由 "/" 在列表里，但它只能匹配根本身。
// 若按裸 startsWith("/") 判定，所有路径都会变成通栏 —— 登录页也会跟着通栏
eq("根路由不把 /login 一起吃掉", isFullBleedRoute("/login"), false);
eq("根路由不把 /share 一起吃掉", isFullBleedRoute("/share/x"), false);

// ---------- 前缀陷阱：这几条是抽出这个函数的理由 ----------
eq("/editor-guide 不算编辑器", isFullBleedRoute("/editor-guide"), false);
eq("/editors 不算编辑器", isFullBleedRoute("/editors"), false);
eq("/editorial 不算编辑器", isFullBleedRoute("/editorial"), false);
eq("/editor2 不算编辑器", isFullBleedRoute("/editor2"), false);
eq("/dashboards 不算控制台", isFullBleedRoute("/dashboards"), false);
eq("/dashboard-old 不算控制台", isFullBleedRoute("/dashboard-old"), false);
// 不在开头的 /editor 也不算
eq("/docs/editor 不算编辑器", isFullBleedRoute("/docs/editor"), false);

// ---------- 不变量：加了末尾斜杠不该改变判定 ----------
for (const path of [
  "/",
  "/editor",
  "/editor/abc",
  "/dashboard",
  "/login",
  "/register",
  "/editor-guide",
  "/dashboards",
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
