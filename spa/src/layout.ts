/**
 * 正文宽度的唯一来源。
 *
 * 只管正文，不管页头 —— 页头始终通栏（见 AppShell）。它是全站导航，属于应用外壳；
 * 正文收窄是为了行长和阅读，那个理由对一排图标按钮不成立。
 *
 * 集中在这里是因为宽度原先散在 AppShell 和五个页面里各自决定，改过三轮都是「一边改了
 * 另一边没跟上」。现在页面一律走 PageContainer，宽度只在这张表里调。
 */

/** 正文容器的宽度档位 */
export type ContentWidth = "full" | "6xl" | "5xl" | "3xl";

/**
 * 页头与通栏正文共用的左右内边距。
 *
 * 导出而不是两边各写一个 px-3：编辑器页侧栏的左边缘要和页头的 logo 对齐，两边写死的话
 * 改了一处就差几个像素，而几个像素的错位最难靠眼睛发现。12px 这个值本身取自编辑器
 * 侧栏的内边距。
 */
export const EDGE_PADDING = "px-3";

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
 * 通栏用 px-3 而不是 px-4 sm:px-6，与页头及编辑器侧栏的 12px 取齐 —— 通栏页面的正文
 * 左边缘要和页头的 logo 对上。收窄档用 px-4 sm:px-6，移动端上边距更舒服；那几页的正文
 * 本来就和页头不对齐，不必迁就。
 */
export function widthClass(width: ContentWidth): string {
  switch (width) {
    case "full":
      return `w-full ${EDGE_PADDING}`;
    case "6xl":
      return "mx-auto w-full max-w-6xl px-4 sm:px-6";
    case "5xl":
      return "mx-auto w-full max-w-5xl px-4 sm:px-6";
    case "3xl":
      return "mx-auto w-full max-w-3xl px-4 sm:px-6";
  }
}

/** 某个路径下正文容器的 class。页面通过 PageContainer 间接用它 */
export function containerClass(pathname: string): string {
  return widthClass(contentWidthFor(pathname));
}
