import { useState } from "react";
import { User as UserIcon } from "lucide-react";

/**
 * 用户头像。
 *
 * 三级回落：第三方头像图 → 名字首字 → 通用图标。
 *
 * 需要三级而不是两级，因为「有 URL」和「图能加载出来」是两件事：
 * Google 与 GitHub 的头像地址会失效（改过头像、删号、公司网络屏蔽 googleusercontent），
 * 只判 avatarUrl 是否为空的话，那种情况下会留一个碎图标。所以额外记一个 failed 状态。
 *
 * 首字回落用名字而不是邮箱：邮箱首字常常是姓氏拼音的第一个字母，一堆人都是 z/l/w，
 * 而昵称首字（中文名尤其）区分度高得多。
 */
export function Avatar({
  name,
  avatarUrl,
  size = 28,
  className = "",
}: {
  /** 显示名，用于首字回落与 alt */
  name: string;
  avatarUrl?: string | null;
  /** 边长，px */
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  const box = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${className}`;
  const style = { width: size, height: size };

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        // alt 留空 + aria-hidden：头像旁边always跟着用户名，读屏念两遍同一个人名是噪音。
        // 但 alt 属性本身必须在，缺了它读屏会去念 URL
        alt=""
        aria-hidden
        width={size}
        height={size}
        // 显式宽高 + 这两个属性一起给：
        // - referrerPolicy 不把当前页地址泄露给 Google / GitHub
        // - onError 触发首字回落，而不是留一个碎图
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`${box} object-cover`}
        style={{ ...style, background: "var(--ink-wash-strong)" }}
      />
    );
  }

  const initial = firstChar(name);

  return (
    <span
      aria-hidden
      className={box}
      style={{
        ...style,
        background: "var(--cinnabar-soft)",
        color: "var(--cinnabar)",
      }}
    >
      {initial ? (
        <span
          className="kn-heading-cn font-semibold leading-none"
          // 字号跟着边长走，不写死：头像在页头是 28px，菜单里是 36px
          style={{ fontSize: Math.round(size * 0.45) }}
        >
          {initial}
        </span>
      ) : (
        <UserIcon style={{ width: size * 0.55, height: size * 0.55 }} />
      )}
    </span>
  );
}

/**
 * 取显示名的第一个字符，用于头像回落。
 *
 * 导出是为了能单独断言 —— 它的边界情况都在字符串处理上，不需要渲染组件才能验。
 *
 * 用 Array.from 而不是 name[0]：后者按 UTF-16 码元取，遇到 emoji 或辅助平面的生僻汉字
 * 会截出半个代理对，渲染成一个乱码方块。用户昵称里放 emoji 很常见。
 */
export function firstChar(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return Array.from(trimmed)[0].toUpperCase();
}
