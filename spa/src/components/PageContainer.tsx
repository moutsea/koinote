import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { containerClass } from "../layout";

/**
 * 正文容器。宽度从 layout.ts 的路由表取，与页头同源。
 *
 * 页面自己写 mx-auto max-w-5xl 也能达到同样效果，但那样宽度就有两处定义 ——
 * 改了页头忘了页面（或反过来）会让两者的左边缘错开，而这只有真去点那个页面才看得见。
 * 已经因此改过三轮，所以让页面别再自己决定。
 *
 * 不接 width 参数：能覆盖就等于又把决定权散回页面了。要调某一页的宽度，改 layout.ts
 * 里那张表。
 */
export function PageContainer({
  children,
  className = "",
}: {
  children: ReactNode;
  /** 只接与宽度无关的样式，比如上下留白 */
  className?: string;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return <div className={`${containerClass(pathname)} ${className}`}>{children}</div>;
}
