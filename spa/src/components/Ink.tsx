/**
 * 水墨风的通用装饰件。
 *
 * 全站的中国风元素收在这里，而不是各页面自己画：印章的红、纸的黄、墨的层次一旦散开写，
 * 改一处就会有另一处忘掉，而颜色的偏差比布局的偏差更难靠眼睛发现。
 */

import type { ReactNode } from "react";

/**
 * 朱砂印章。
 *
 * 竖排（writing-mode: vertical-rl）是印章的常规款式，横排看着像徽标而不像印。
 * aria-hidden：它是装饰，读屏念一个孤立的「鲤」字只会让人困惑。
 */
export function InkSeal({
  label = "鯉",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`kn-seal-stamp inline-flex select-none items-center justify-center rounded-md border-2 font-semibold tracking-widest ${className}`}
      style={{
        borderColor: "var(--cinnabar)",
        background: "var(--cinnabar-soft)",
        color: "var(--cinnabar)",
        writingMode: "vertical-rl",
        fontFamily: '"KaiTi", "STKaiti", "Songti SC", serif',
      }}
    >
      {label}
    </span>
  );
}

/**
 * 墨云背景。绝对定位铺满父元素，父元素需要 relative + overflow-hidden。
 *
 * pointer-events-none 是必须的：这几团模糊的圆盖在正文之上的话会吃掉点击，
 * 而 -z-10 只管绘制顺序，不管命中测试。
 */
export function InkClouds({ withCinnabar = false }: { withCinnabar?: boolean }) {
  return (
    <div className="kn-paper-grain pointer-events-none absolute inset-0 -z-10">
      <div
        className="kn-ink-drift absolute left-[12%] top-0 h-80 w-80 rounded-full blur-3xl"
        style={{ background: "var(--ink-wash-strong)" }}
      />
      <div
        className="kn-ink-drift absolute right-[15%] top-20 h-72 w-72 rounded-full blur-3xl"
        style={{ background: "var(--ink-wash)", animationDelay: "3s" }}
      />
      {withCinnabar && (
        <div
          className="absolute bottom-0 left-1/2 h-56 w-[560px] -translate-x-1/2 blur-2xl"
          style={{
            background: "linear-gradient(to top, var(--cinnabar-soft), transparent)",
          }}
        />
      )}
    </div>
  );
}

/**
 * 卷轴轴头：一道两端收细的横线，压在卷轴式容器的上方。
 *
 * 用 gradient 到 transparent 而不是实心条：实心条两端会有硬边，像根棍子；
 * 渐变收细才有轴头卷进纸里的感觉。
 */
export function ScrollRod({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`mx-auto h-2.5 rounded-full ${className}`}
      style={{
        background:
          "linear-gradient(to right, transparent, var(--ink-strong), transparent)",
      }}
    />
  );
}

/**
 * 宣纸卡片。全站的卡片都走这里，圆角、描边、纸色三样保持一致。
 */
export function PaperCard({
  children,
  className = "",
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border ${
        hover ? "transition hover:-translate-y-0.5 hover:shadow-lg" : ""
      } ${className}`}
      style={{
        borderColor: "var(--ink-line)",
        background: "var(--ink-paper-soft)",
      }}
    >
      {children}
    </div>
  );
}
