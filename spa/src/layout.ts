/**
 * 页头宽度要跟着正文走。
 *
 * 大部分页面的正文是居中收窄的（dashboard max-w-5xl、share max-w-3xl、home
 * max-w-6xl），页头也收窄才对得上；编辑器是通栏的，页头收窄就会和下方紧贴视口边缘的
 * 侧栏、标签行错开一大截 —— 宽屏上 logo 落在 400px 开外，而它正下方的侧栏标题在
 * 12px 处。
 *
 * 抽成纯函数是因为「前缀匹配」这件事很容易写错：startsWith("/editor") 会把
 * /editor-guide 之类的路由也算进来。按路径分段比对才是对的。
 */

/**
 * 正文通栏（不居中收窄）的路由前缀。
 *
 * 加新页面时要么把它列进来、要么让它的正文居中收窄 —— 两者不一致的话，页头和正文的
 * 左边缘会错开，而这只有真去点那个页面才看得见。
 *
 * 目前只有 /login 和 /share 还是收窄的：登录表单本来就该窄（max-w-md），
 * 分享页是给外人读的长文（max-w-3xl 是为了行长）。
 */
const FULL_BLEED_ROUTES = ["/editor", "/dashboard", "/"];

/**
 * 这个路径下的正文是不是通栏的。
 *
 * 按分段比对而不是裸 startsWith：/editor 与 /editor/<docId> 都算，
 * 但 /editor-guide 不算 —— 它是另一个页面，不该继承编辑器的布局。
 */
export function isFullBleedRoute(pathname: string): boolean {
  // 去掉末尾斜杠，让 /editor/ 与 /editor 判定一致
  const path = pathname.replace(/\/+$/, "") || "/";
  return FULL_BLEED_ROUTES.some(
    (route) => path === route || path.startsWith(`${route}/`),
  );
}
