// 页头导航的自适应收起：放不下的入口按优先级收进「更多」菜单。
//
// 固定断点不够用：同一排入口在中文里约 450px，法文要 700px 以上，登录后右侧
// 还多出搜索和账户菜单。只能按实际宽度算。纯函数放在这里，AppShell 负责量尺寸，
// scripts/_check_header_nav.mjs 直接测这里的取舍。

export type HeaderNavKey = "editor" | "space" | "hub" | "download" | "docs" | "pricing";

/**
 * 先收谁。下载入口在首页和页脚都有；文档整组进菜单后仍能逐篇打开；
 * 编辑器是主入口，最后才收。
 */
export const HEADER_NAV_COLLAPSE_ORDER: readonly HeaderNavKey[] = [
  "download",
  "docs",
  "hub",
  "space",
  "pricing",
  "editor",
];

export function fitHeaderNav({
  available,
  keys,
  widths,
  moreWidth,
  gap,
}: {
  /** 导航区可用宽度 */
  available: number;
  /** 当前要显示的入口，按页面上的顺序 */
  keys: readonly HeaderNavKey[];
  /** 各入口的完整宽度（含下拉箭头） */
  widths: Partial<Record<HeaderNavKey, number>>;
  moreWidth: number;
  gap: number;
}): Set<HeaderNavKey> {
  const hidden = new Set<HeaderNavKey>();
  const required = () => {
    const visible = keys.filter((key) => !hidden.has(key));
    const count = visible.length + (hidden.size ? 1 : 0);
    const content =
      visible.reduce((sum, key) => sum + (widths[key] ?? 0), 0) + (hidden.size ? moreWidth : 0);
    return content + Math.max(0, count - 1) * gap;
  };
  for (const key of HEADER_NAV_COLLAPSE_ORDER) {
    if (!keys.includes(key)) continue;
    // 半个像素的余量：getBoundingClientRect 给的是小数，累加后会差出零点几
    if (required() <= available + 0.5) break;
    hidden.add(key);
  }
  return hidden;
}

export function sameNavSet(a: ReadonlySet<HeaderNavKey>, b: ReadonlySet<HeaderNavKey>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}
