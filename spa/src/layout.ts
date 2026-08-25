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
export type ContentWidth = "full" | "7xl" | "6xl" | "5xl" | "3xl";

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
  // 设置中心包含侧栏和内容区，需要比单栏账户页多留一档空间
  { prefix: "/settings", width: "7xl" },
  { prefix: "/dashboard", width: "5xl" },
  { prefix: "/ai-settings", width: "5xl" },
  { prefix: "/mcp/activity", width: "5xl" },
  { prefix: "/documents", width: "5xl" },
  { prefix: "/invitations", width: "5xl" },
  { prefix: "/pricing", width: "6xl" },
  { prefix: "/docs", width: "6xl" },
  { prefix: "/changelog", width: "5xl" },
  // 管理后台包含宽表格和 30 天趋势，比个人控制台多留一档宽度
  { prefix: "/admin", width: "6xl" },
  // 分享页给外人读长文，3xl 是为了行长
  { prefix: "/share", width: "3xl" },
  // 条款页同理：整页都是段落，宽了没法读。卷轴的纸面宽度在页面内另有 max-w-3xl，
  // 这里给 5xl 是留出纸面两侧的余地，好让墨云背景露出来
  { prefix: "/privacy", width: "5xl" },
  { prefix: "/terms", width: "5xl" },
  { prefix: "/cookies", width: "5xl" },
  // 首页收窄到 6xl。
  //
  // 原先是通栏，但超宽屏上撑得太开：hero 的标题和副标题本来就各有 max-w 兜着，
  // 通栏只是把那两段文字放到一片空地中间；下面的特性网格三列一拉，卡片之间的
  // 间距远大于卡片内的留白，看着是三块孤立的板子而不是一组。
  //
  // 6xl 与登录、注册的兜底同档 —— 那两页也是「一栏内容居中」的版面。
  // 墨云背景仍然是通栏的：它画在 PageContainer 之外（见 HomePage 的 InkClouds），
  // 收窄的只是内容。
  { prefix: "/", width: "6xl" },
];

/** 没匹配上时的兜底。登录、注册这类页面自己会再收窄一层 */
const DEFAULT_WIDTH: ContentWidth = "6xl";

/**
 * 这个路径的正文该用多宽。
 *
 * 匹配规则见 isUnder。分段比对下 "/" 只能命中根本身（"//" 永不成立），所以它不会抢走
 * /dashboard。取最长前缀是为另一种情况准备的：将来若给 /editor/settings 之类单独设
 * 宽度，它必须赢过 /editor，且不能依赖两者在表里的先后。
 */
export function contentWidthFor(pathname: string): ContentWidth {
  const matches = ROUTE_WIDTHS.filter(({ prefix }) =>
    isUnder(pathname, prefix),
  );
  if (matches.length === 0) return DEFAULT_WIDTH;
  // 最长前缀优先："/" 会匹配一切，但更具体的路由该赢
  return matches.reduce((a, b) => (b.prefix.length > a.prefix.length ? b : a))
    .width;
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
    case "7xl":
      return "mx-auto w-full max-w-7xl px-4 sm:px-6";
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

/**
 * 路径是否落在某个路由前缀之下。
 *
 * 全站按前缀判路由的地方都走这里：宽度表、页脚开关、页头导航的高亮态。
 * 按分段比对而不是裸 startsWith —— 后者会把 /editor-guide 判成编辑器，
 * 而这类错判的表现（导航项莫名高亮、页脚莫名消失）很难联想到是前缀匹配的问题。
 *
 * 末尾斜杠先去掉，让 /editor/ 与 /editor 判定一致；空串按根算。
 */
export function isUnder(pathname: string, prefix: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** 桌面编辑器用来锁住浏览器根滚动容器的 class。 */
export const EDITOR_ROOT_SCROLL_LOCK_CLASS = "kn-editor-root-scroll-lock";

/** 只有编辑器路由需要把根滚动交给正文自己的滚动容器。 */
export function shouldLockRootScroll(pathname: string): boolean {
  return isUnder(pathname, "/editor");
}

/**
 * 应用外壳的视口高度策略。
 *
 * 这个 class 挂在包含页头的整个 AppShell 上。桌面编辑器把外壳锁在视口内，再由 flex
 * 给 main 分配页头以下的剩余高度，让正文、文件树和大纲各自滚动。移动端保留页面自然
 * 滚动，避开 iOS Safari 地址栏变化时 100dvh 与内层滚动容器互相拉扯。
 */
export function shellViewportClass(pathname: string): string {
  return shouldLockRootScroll(pathname)
    ? "min-h-[100dvh] lg:h-[100dvh] lg:overflow-hidden"
    : "min-h-[100dvh]";
}

/**
 * 不挂全站页脚的路由前缀。
 *
 * 编辑器是撑满视口高度的两列工作区，自己管滚动；底下接一段页脚的话，要么被挤出视口
 * 白占高度，要么把编辑区压扁。分享页是给外人读一篇文档的落地页，末尾自己收了个尾，
 * 再叠一堆站内导航是喧宾夺主。
 */
export const FOOTERLESS_PREFIXES = ["/editor", "/share"];

/** 这个路径要不要挂全站页脚 */
export function hasFooter(pathname: string): boolean {
  return !FOOTERLESS_PREFIXES.some((prefix) => isUnder(pathname, prefix));
}
