/**
 * 版面宽度的唯一来源。
 *
 * 页头和正文必须用同一个宽度，否则两者的左边缘会错开 —— 这个错开改过三轮：先是页头
 * max-w-6xl 配编辑器通栏，再是页头通栏配控制台 max-w-5xl，每次都是「一边改了另一边
 * 没跟上」。根因是宽度散在 AppShell 和五个页面里各自决定。
 *
 * 现在只在这里定：路由 → 宽度。页头用 containerClass，页面用 PageContainer，
 * 两者都从这张表取值，漂开在结构上就不可能了。
 */

/** 正文容器的宽度档位 */
export type ContentWidth = "full" | "6xl" | "5xl" | "3xl";

/**
 * 各路由的正文宽度。按前缀匹配，最长的前缀优先。
 *
 * 为什么不是一律通栏：通栏只对「内容本身能铺开」的版面成立。编辑器有侧栏和正文两列，
 * 铺得越开越好用；首页是营销版面，卡片网格按列数自适应。而控制台是一列信息卡加一份
 * 列表 —— 列表行是「标题在左、日期在右」，拉到 2560px 就变成两头各一个字、中间一片
 * 空白，读起来像坏了而不是宽敞。
 */
export const ROUTE_WIDTHS: Array<{ prefix: string; width: ContentWidth }> = [
  // 编辑器：两列版面，铺满才好用
  { prefix: "/editor", width: "full" },
  // 控制台：信息卡 + 文档列表，需要收窄兜住行内的左右间距
  { prefix: "/dashboard", width: "5xl" },
  // 分享页给外人读长文，3xl 是为了行长
  { prefix: "/share", width: "3xl" },
  // 首页是营销版面，通栏
  { prefix: "/", width: "full" },
];

/** 没匹配上时的兜底。登录、注册这类页面自己会再收窄一层 */
const DEFAULT_WIDTH: ContentWidth = "6xl";

/**
 * 这个路径的正文该用多宽。
 *
 * 按路径分段比对而不是裸 startsWith：
 *   - startsWith("/editor") 会把 /editor-guide 也算成编辑器
 *   - 表里有 "/"，裸 startsWith 会让每个路径都命中它
 *
 * 分段比对下 "/" 只能命中根本身（path.startsWith("//") 永不成立），所以它不会抢走
 * /dashboard。取最长前缀是为另一种情况准备的：将来若给 /editor/settings 之类单独设
 * 宽度，它必须赢过 /editor，且不能依赖两者在表里的先后。
 */
export function contentWidthFor(pathname: string): ContentWidth {
  // 去掉末尾斜杠，让 /editor/ 与 /editor 判定一致；空串按根算
  const path = pathname.replace(/\/+$/, "") || "/";
  const matches = ROUTE_WIDTHS.filter(
    ({ prefix }) => path === prefix || path.startsWith(`${prefix}/`),
  );
  if (matches.length === 0) return DEFAULT_WIDTH;
  // 最长前缀优先："/" 会匹配一切，但更具体的路由该赢
  return matches.reduce((a, b) => (b.prefix.length > a.prefix.length ? b : a)).width;
}

/**
 * 宽度档位对应的容器 class。
 *
 * 通栏用 px-3 而不是 px-4 sm:px-6：编辑器的侧栏内边距是 12px，页头要与它取齐。
 * 收窄档用 px-4 sm:px-6，是移动端上更舒服的边距。
 */
export function widthClass(width: ContentWidth): string {
  switch (width) {
    case "full":
      return "w-full px-3";
    case "6xl":
      return "mx-auto w-full max-w-6xl px-4 sm:px-6";
    case "5xl":
      return "mx-auto w-full max-w-5xl px-4 sm:px-6";
    case "3xl":
      return "mx-auto w-full max-w-3xl px-4 sm:px-6";
  }
}

/** 某个路径的容器 class。页头与正文都走这里 */
export function containerClass(pathname: string): string {
  return widthClass(contentWidthFor(pathname));
}

/** 正文是否通栏。只用于少数需要分支的地方 */
export function isFullBleedRoute(pathname: string): boolean {
  return contentWidthFor(pathname) === "full";
}
