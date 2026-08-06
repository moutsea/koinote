// 主题契约校验：每套主题都必须有能独立成立的深色变体。
//
// 类型只能保证 dark.body 与 dark.pre 存在，保证不了它们「真的是深色」——
// 写成 background:#fff 也能过编译。这里补上运行时约束，新增主题时会拦下来。
import { WECHAT_THEMES, resolveThemeRules } from "./_themes_bundle.mjs";
import { themeToCSS } from "./_theme_css_bundle.mjs";

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
};

/** 感知亮度，与 themeCss.ts 的判定保持同一套算法 */
function luma(hex) {
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** 取声明串里最后一个 background 的色值 —— 后者才是生效的那个 */
function lastBg(decls) {
  const all = decls?.match(/background:\s*(#[0-9a-fA-F]{3,6})/g);
  return all?.[all.length - 1]?.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? null;
}

const TAGS = new Set([
  "body", "h1", "h2", "h3", "h4", "p", "blockquote", "ul", "ol", "li",
  "strong", "em", "code", "pre", "pre code", "hr", "a", "img", "table",
  "th", "td",
]);

check("主题数量不为空", WECHAT_THEMES.length > 0);

for (const theme of WECHAT_THEMES) {
  const id = theme.id;

  check(`${id} 有 dark`, Boolean(theme.dark), "缺深色变体");
  if (!theme.dark) continue;

  // dark 的键必须都是合法标签名，写错标签会静默失效
  for (const key of Object.keys(theme.dark)) {
    check(`${id} dark.${key} 是合法标签`, TAGS.has(key), `未知标签 ${key}`);
  }

  // body 必须同时声明底色与文字色：只给底色会让文字沿用浅色那套，撞成同色
  const db = theme.dark.body ?? "";
  check(`${id} dark.body 声明了 background`, /background:/.test(db));
  check(`${id} dark.body 声明了 color`, /color:/.test(db));

  const bodyBg = lastBg(db);
  check(`${id} dark.body 底色可解析`, Boolean(bodyBg), db);
  if (bodyBg) {
    check(
      `${id} dark.body 底色确实是深色`,
      luma(bodyBg) < 0.3,
      `${bodyBg} 亮度 ${luma(bodyBg).toFixed(2)}，深色变体不该用亮底`,
    );
  }

  // pre 底色决定高亮配色分流。深色变体里它必须是深底，
  // 否则深色页面上会突然亮出一块浅色代码块
  const merged = resolveThemeRules(theme, "dark");
  const preBg = lastBg(merged.pre);
  check(`${id} dark.pre 底色可解析`, Boolean(preBg), merged.pre);
  if (preBg) {
    check(
      `${id} dark.pre 底色确实是深色`,
      luma(preBg) < 0.4,
      `${preBg} 亮度 ${luma(preBg).toFixed(2)}`,
    );
  }

  // 正文色与底色不能撞：差值太小等于看不见字
  const textColor = db.match(/(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,6})/)?.[1];
  if (textColor && bodyBg) {
    check(
      `${id} 正文与底色有足够反差`,
      Math.abs(luma(textColor) - luma(bodyBg)) > 0.45,
      `文字 ${textColor} 与底 ${bodyBg} 亮度差 ${Math.abs(luma(textColor) - luma(bodyBg)).toFixed(2)}`,
    );
  }

  // 生成的 CSS 必须同时含浅色块与 .dark 块
  const css = themeToCSS(id);
  check(`${id} CSS 含浅色作用域`, css.includes(`.koinote-themed{`));
  check(`${id} CSS 含深色作用域`, css.includes(`.dark .koinote-themed{`));

  // 两种模式都要有显式的 hljs 配色，不靠继承 globals.css
  const hl = [...css.matchAll(/([^\n{]*\.hljs-string[^{]*)\{color:(#[0-9a-f]{6});\}/gi)];
  const lightPalette = hl.find(([, sel]) => !sel.trim().startsWith(".dark"))?.[2];
  const darkPalette = hl.find(([, sel]) => sel.trim().startsWith(".dark"))?.[2];
  check(`${id} 浅色模式有显式高亮配色`, Boolean(lightPalette));
  check(`${id} 深色模式有显式高亮配色`, Boolean(darkPalette));

  // 配色要与该模式下 pre 的底色亮度对得上
  const lightPreBg = lastBg(theme.rules.pre);
  if (lightPreBg && lightPalette) {
    const want = luma(lightPreBg) > 0.6 ? "#032f62" : "#a5d6ff";
    check(
      `${id} 浅色模式配色与底色匹配`,
      lightPalette === want,
      `底 ${lightPreBg} 期望 ${want}，实际 ${lightPalette}`,
    );
  }
  if (preBg && darkPalette) {
    const want = luma(preBg) > 0.6 ? "#032f62" : "#a5d6ff";
    check(
      `${id} 深色模式配色与底色匹配`,
      darkPalette === want,
      `底 ${preBg} 期望 ${want}，实际 ${darkPalette}`,
    );
  }
}

// 不套主题时不该产出任何 CSS
check("空串不产出 CSS", themeToCSS("") === "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
