/**
 * 站内 logo：一笔水墨锦鲤尾，尾梢一点朱砂。
 *
 * 为什么是 PNG 而不是 SVG：这是真实笔触，有干笔的笔丝、墨色渐变和飞白。
 * 矢量化只能拟合成几条平滑的路径，笔锋全丢 —— 那就不是水墨了。
 * 站内别处（BrandIcons）用内联 SVG 是因为那些是纯几何图形，情况不同。
 *
 * 两套图而不是一套加 CSS 滤镜：墨色几乎是黑的（宣纸上正是要这样），
 * 压在深色模式的玄墨底 #14130f 上会整个消失 —— 实测确认过。
 * 深色那套把墨反白成宣纸色，朱砂原样保留（它在深底上本来就读得清）。
 * 用 filter:invert() 会把朱砂一起翻成青色，所以老老实实两张图。
 *
 * 两张图同时渲染、靠 CSS 切换可见性，而不是读当前主题再选 src：
 * 主题是 .dark class 切的，读 JS 状态会在切换瞬间闪一下旧图。
 */

type LogoProps = {
  className?: string;
  /**
   * "auto"（默认）跟随主题；"reversed" 固定用反白那张。
   *
   * 页脚需要 reversed：它恒定是深色面板（.kn-app-footer 把整套墨色 token 反过来），
   * 浅色模式下也是深底，跟随主题会在那里放一张几乎看不见的黑墨图。
   */
  variant?: "auto" | "reversed";
};

export function Logo({ className = "h-5 w-5", variant = "auto" }: LogoProps) {
  if (variant === "reversed") {
    return (
      <img
        src="/logo-dark.png"
        alt=""
        aria-hidden="true"
        className={`shrink-0 object-contain ${className}`}
      />
    );
  }

  return (
    <span className={`relative inline-block shrink-0 ${className}`}>
      <img
        src="/logo.png"
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-contain dark:hidden"
      />
      <img
        src="/logo-dark.png"
        alt=""
        aria-hidden="true"
        className="absolute inset-0 hidden h-full w-full object-contain dark:block"
      />
    </span>
  );
}
