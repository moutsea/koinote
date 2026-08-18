// 版面宽度的路由表。页头和正文都从它取值 —— 判错的表现是某一页的页头和正文左边缘
// 错开，而这只有真去点那个页面才看得见。已经因此改过三轮，所以钉住。
import {
  EDGE_PADDING,
  EDITOR_ROOT_SCROLL_LOCK_CLASS,
  FOOTERLESS_PREFIXES,
  ROUTE_WIDTHS,
  containerClass,
  contentWidthFor,
  hasFooter,
  isUnder,
  shellViewportClass,
  shouldLockRootScroll,
  widthClass,
} from "./_layout_bundle.mjs";

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 得到 ${g}，期望 ${w}`);
  }
}

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------- 各路由的宽度 ----------
eq("编辑器通栏", contentWidthFor("/editor"), "full");
eq("编辑器带 docId 通栏", contentWidthFor("/editor/abc-123"), "full");
eq("编辑器深层路径通栏", contentWidthFor("/editor/a/b/c"), "full");
// 首页收窄到 6xl：通栏在超宽屏上把 hero 文字丢进一片空地，特性卡片也散成三块板子
eq("首页收窄", contentWidthFor("/"), "6xl");
eq("空路径按首页算", contentWidthFor(""), "6xl");
ok("首页不通栏", contentWidthFor("/") !== "full", contentWidthFor("/"));
// 控制台不通栏：信息卡和文档列表拉到 2560px 会变成两头各一个字、中间一片空白
eq("控制台收到 5xl", contentWidthFor("/dashboard"), "5xl");
eq("文档页收到 5xl", contentWidthFor("/documents"), "5xl");
eq("邀请页收到 5xl", contentWidthFor("/invitations"), "5xl");
eq("文档中心收到 6xl", contentWidthFor("/docs"), "6xl");
eq("MCP 指南收到 6xl", contentWidthFor("/docs/mcp"), "6xl");
eq("版本控制指南收到 6xl", contentWidthFor("/docs/version-history"), "6xl");
eq("分享页收到 3xl", contentWidthFor("/share/tok3n"), "3xl");
// 表里没列的路由走兜底
eq("登录页走兜底", contentWidthFor("/login"), "6xl");
eq("注册页走兜底", contentWidthFor("/register"), "6xl");

// ---------- 最长前缀优先 ----------
//
// 表里有 "/"，它匹配一切；更具体的路由必须赢，否则控制台会被首页的通栏抢走。
//
// 只写 contentWidthFor("/dashboard") === "5xl" 是空断言 —— 当前表恰好按前缀长度
// 降序排列，first-match 的实现也能过。所以直接打乱表序再验一遍：真正要钉的是
// 「结果与表序无关」。
{
  eq("控制台不被根路由抢走", contentWidthFor("/dashboard"), "5xl");
  eq("分享页不被根路由抢走", contentWidthFor("/share/x"), "3xl");
  eq("编辑器不被根路由抢走", contentWidthFor("/editor"), "full");

  // 把 "/" 挪到表首 —— first-match 实现在这里会让每个路径都变成 full
  const original = [...ROUTE_WIDTHS];
  const root = ROUTE_WIDTHS.findIndex(({ prefix }) => prefix === "/");
  ok("表里有根路由（不然下面这组白测）", root >= 0);
  if (root >= 0) {
    const [rootEntry] = ROUTE_WIDTHS.splice(root, 1);
    ROUTE_WIDTHS.unshift(rootEntry);
    try {
      eq("根路由排在表首时，控制台仍是 5xl", contentWidthFor("/dashboard"), "5xl");
      eq("根路由排在表首时，分享页仍是 3xl", contentWidthFor("/share/x"), "3xl");
      eq("根路由排在表首时，编辑器仍是 full", contentWidthFor("/editor"), "full");
      eq("根路由排在表首时，根本身仍是 6xl", contentWidthFor("/"), "6xl");
    } finally {
      ROUTE_WIDTHS.length = 0;
      ROUTE_WIDTHS.push(...original);
    }
  }

  // 完全反转表序，再全量比一遍
  const before = new Map(
    [
      "/",
      "/editor",
      "/editor/x",
      "/dashboard",
      "/documents",
      "/invitations",
      "/share/x",
      "/login",
    ].map((p) => [p, contentWidthFor(p)]),
  );
  ROUTE_WIDTHS.reverse();
  try {
    for (const [path, want] of before) {
      eq(`表序反转后仍一致: ${path}`, contentWidthFor(path), want);
    }
  } finally {
    ROUTE_WIDTHS.reverse();
  }
}

// ---------- 嵌套前缀：真正让「最长优先」有意义的场景 ----------
//
// 上面那组其实测不出 first-match 与 longest-prefix 的差别：分段匹配下 "/" 只能命中
// 根本身（path.startsWith("//") 永不成立），当前表里也没有互相嵌套的非根前缀 ——
// 两种实现结果一样。
//
// 所以这里临时塞一对嵌套前缀，把那条分支真正跑起来。未来真要给 /editor/settings
// 之类单独设宽度时，靠的就是它。
{
  const original = [...ROUTE_WIDTHS];
  try {
    ROUTE_WIDTHS.push({ prefix: "/editor/settings", width: "3xl" });
    eq("更长的嵌套前缀胜出（排在后）", contentWidthFor("/editor/settings"), "3xl");
    eq("嵌套前缀的子路径也胜出", contentWidthFor("/editor/settings/x"), "3xl");
    eq("父前缀不受影响", contentWidthFor("/editor"), "full");
    eq("父前缀的其它子路径不受影响", contentWidthFor("/editor/abc"), "full");
    // 兄弟路径不该被误伤：/editor/settings-old 不是 /editor/settings 的子路径
    eq("同名前缀的兄弟路径不受影响", contentWidthFor("/editor/settings-old"), "full");

    // 把嵌套前缀挪到父前缀之前，结果必须不变 —— first-match 在这两种排法里必有一种错
    ROUTE_WIDTHS.length = 0;
    ROUTE_WIDTHS.push({ prefix: "/editor/settings", width: "3xl" }, ...original);
    eq("更长的嵌套前缀胜出（排在前）", contentWidthFor("/editor/settings"), "3xl");
    eq("排在前时父前缀仍是 full", contentWidthFor("/editor"), "full");
  } finally {
    ROUTE_WIDTHS.length = 0;
    ROUTE_WIDTHS.push(...original);
  }
}

// ---------- 前缀陷阱：分段比对而非裸 startsWith ----------
eq("/editor-guide 不算编辑器", contentWidthFor("/editor-guide"), "6xl");
eq("/editors 不算编辑器", contentWidthFor("/editors"), "6xl");
eq("/editorial 不算编辑器", contentWidthFor("/editorial"), "6xl");
eq("/dashboards 不算控制台", contentWidthFor("/dashboards"), "6xl");
eq("/dashboard-old 不算控制台", contentWidthFor("/dashboard-old"), "6xl");
eq("/documents-old 不算文档页", contentWidthFor("/documents-old"), "6xl");
eq("/invitations-old 不算邀请页", contentWidthFor("/invitations-old"), "6xl");
eq("/shared 不算分享页", contentWidthFor("/shared"), "6xl");
eq("/docs/editor 不算编辑器", contentWidthFor("/docs/editor"), "6xl");

// ---------- 末尾斜杠不影响判定 ----------
for (const path of [
  "/",
  "/editor",
  "/editor/abc",
  "/dashboard",
  "/documents",
  "/invitations",
  "/share/tok3n",
  "/login",
  "/editor-guide",
  "/dashboards",
]) {
  eq(
    `末尾斜杠不影响: ${path}`,
    contentWidthFor(path),
    contentWidthFor(`${path}/`),
  );
}

// ---------- widthClass ----------
ok("通栏不含 max-w", !widthClass("full").includes("max-w"), widthClass("full"));
ok("通栏不居中", !widthClass("full").includes("mx-auto"), widthClass("full"));
// 通栏用 px-3 与编辑器侧栏的内边距取齐
ok("通栏用 px-3", widthClass("full").includes("px-3"), widthClass("full"));
for (const w of ["6xl", "5xl", "3xl"]) {
  ok(`${w} 居中`, widthClass(w).includes("mx-auto"), widthClass(w));
  ok(`${w} 带对应 max-w`, widthClass(w).includes(`max-w-${w}`), widthClass(w));
}

// ---------- containerClass 与宽度表一致 ----------
for (const path of [
  "/",
  "/editor",
  "/editor/abc-123",
  "/dashboard",
  "/documents",
  "/invitations",
  "/share/tok3n",
  "/login",
  "/editor-guide",
]) {
  eq(
    `containerClass 取自宽度表: ${path}`,
    containerClass(path),
    widthClass(contentWidthFor(path)),
  );
}

// ---------- 通栏页面的正文要和页头的 logo 对齐 ----------
//
// 页头始终通栏，内边距用的就是 EDGE_PADDING（见 AppShell），所以这条对齐是结构上
// 保证的、不靠断言。这里只钉住通栏档确实用了它 —— 换成 px-4 之类，编辑器页侧栏的
// 左边缘就会和 logo 差几个像素，而几个像素的错位最难靠眼睛发现。
ok(
  `通栏正文用 ${EDGE_PADDING}`,
  widthClass("full").split(/\s+/).includes(EDGE_PADDING),
  widthClass("full"),
);
// 收窄档不该用它：那几页的正文本来就和页头不对齐，移动端边距大一点更舒服
for (const w of ["6xl", "5xl", "3xl"]) {
  ok(
    `${w} 档不用 ${EDGE_PADDING}`,
    !widthClass(w).split(/\s+/).includes(EDGE_PADDING),
    widthClass(w),
  );
}

// ---------- 条款页 ----------
//
// 三份条款整页都是段落，通栏会让行长失控。它们必须收窄。
for (const path of ["/privacy", "/terms", "/cookies"]) {
  eq(`${path} 收窄`, contentWidthFor(path), "5xl");
  ok(
    `${path} 不通栏`,
    contentWidthFor(path) !== "full",
    contentWidthFor(path),
  );
}

// ---------- 页脚挂载 ----------
//
// 编辑器撑满视口自己管滚动，分享页自己收尾，两者都不挂全站页脚。
for (const path of [
  "/editor",
  "/editor/",
  "/editor/abc123",
  "/share/tok",
]) {
  ok(`${path} 不挂页脚`, !hasFooter(path), hasFooter(path));
}
// 其余页面都要有页脚 —— 隐私政策、服务条款这些入口只在页脚里，
// 首页丢了页脚就等于全站找不到条款页
for (const path of [
  "/",
  "/dashboard",
  "/documents",
  "/invitations",
  "/login",
  "/register",
  "/privacy",
  "/terms",
  "/cookies",
]) {
  ok(`${path} 挂页脚`, hasFooter(path), hasFooter(path));
}
// 分段比对，不是裸 startsWith：/editor-guide 不是编辑器
ok("/editor-guide 挂页脚", hasFooter("/editor-guide"), hasFooter("/editor-guide"));
ok("/shared-notes 挂页脚", hasFooter("/shared-notes"), hasFooter("/shared-notes"));

// ---------- 编辑器视口 ----------
//
// 桌面编辑器必须锁在一屏内，正文现有的 overflow-y-auto 才会成为滚动容器；移动端
// 则保留自然页面滚动，避开 iOS Safari 的动态地址栏与 100dvh 内层滚动抖动。
for (const path of ["/editor", "/editor/", "/editor/abc123"]) {
  ok(`${path} 锁住桌面根滚动`, shouldLockRootScroll(path));
  eq(
    `${path} 仅在桌面锁定视口`,
    shellViewportClass(path),
    "min-h-[100dvh] lg:h-[100dvh] lg:overflow-hidden",
  );
}
for (const path of ["/", "/dashboard", "/documents", "/editor-guide"]) {
  ok(`${path} 不锁根滚动`, !shouldLockRootScroll(path));
  eq(
    `${path} 保持自然页面高度`,
    shellViewportClass(path),
    "min-h-[100dvh]",
  );
}
eq(
  "根滚动锁 class 与全局样式约定一致",
  EDITOR_ROOT_SCROLL_LOCK_CLASS,
  "kn-editor-root-scroll-lock",
);

// 页脚里排着三条条款链接，宽度表里也得有对应条目，否则那三页会掉到兜底档
for (const path of ["/privacy", "/terms", "/cookies"]) {
  ok(
    `宽度表里有 ${path}`,
    ROUTE_WIDTHS.some((entry) => entry.prefix === path),
    ROUTE_WIDTHS.map((e) => e.prefix),
  );
}

// 不挂页脚的前缀必须在宽度表里有自己的条目：两张表都按前缀分派，
// 一边加了另一边忘了，页面会掉到兜底宽度
for (const prefix of FOOTERLESS_PREFIXES) {
  ok(
    `${prefix} 在宽度表里`,
    ROUTE_WIDTHS.some((entry) => entry.prefix === prefix),
    ROUTE_WIDTHS.map((e) => e.prefix),
  );
}

// ---------- isUnder：三处共用的前缀判定 ----------
//
// 宽度表、页脚开关、页头导航高亮都走它。原先这条规则在三个地方各写了一遍，
// 现在收成一个函数，所以这里把它自己钉住。
ok("精确命中", isUnder("/editor", "/editor"), true);
ok("子路径命中", isUnder("/editor/abc", "/editor"), true);
ok("深层子路径命中", isUnder("/editor/a/b/c", "/editor"), true);
ok("末尾斜杠等同", isUnder("/editor/", "/editor"), true);
ok("多个末尾斜杠等同", isUnder("/editor///", "/editor"), true);

// 关键的一条：同名前缀的兄弟路径不算命中。
// 裸 startsWith 在这里会返回 true，于是访问 /editor-guide 时页头的「编辑器」会高亮、
// 页脚会消失 —— 两个都是很难联想到前缀匹配的症状
ok("同名前缀不命中", !isUnder("/editor-guide", "/editor"), false);
ok("同名前缀不命中(2)", !isUnder("/editorx", "/editor"), false);
ok("不相关路径不命中", !isUnder("/dashboard", "/editor"), false);
ok("父路径不命中子前缀", !isUnder("/editor", "/editor/settings"), false);

// 根前缀只命中根本身，否则它会吃掉一切
ok("根命中根", isUnder("/", "/"), true);
ok("空串按根算", isUnder("", "/"), true);
ok("根不命中 /dashboard", !isUnder("/dashboard", "/"), false);
ok("根不命中 /editor", !isUnder("/editor", "/"), false);

// hasFooter 与 contentWidthFor 都建立在 isUnder 之上，这里确认它们真的一致：
// 若哪天有人给其中一个换了匹配规则，这组会失败
for (const path of ["/editor", "/editor/x", "/editor-guide", "/share/x", "/shared"]) {
  eq(
    `hasFooter 与 isUnder 一致: ${path}`,
    hasFooter(path),
    !FOOTERLESS_PREFIXES.some((p) => isUnder(path, p)),
  );
}

console.log(`\nlayout: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
