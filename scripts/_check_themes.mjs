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

/** 应用深色模式的底色，见 spa/src/globals.css 的 .dark */
const APP_DARK_BG = "#0a0a0a";

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

  // 底色必须跟随应用的 --background，不能是具体色值。
  // 正文区是居中定宽列，底色与页面差一点点，左右就各留一道竖边 —— 深色下尤其明显
  check(
    `${id} dark.body 底色跟随 var(--background)`,
    /background:\s*var\(--background\)/.test(db),
    `实际 ${db.match(/background:[^;]*/)?.[0] ?? "无"}，深色底不该写死色值，会与页面留出接缝`,
  );

  // 文字色要能在应用的深色底（#0a0a0a）上读得出来
  const textColor = db.match(/(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,6})/)?.[1];
  check(`${id} dark.body 文字色可解析`, Boolean(textColor), db);
  if (textColor) {
    check(
      `${id} dark.body 文字在应用底色上有足够反差`,
      luma(textColor) - luma(APP_DARK_BG) > 0.45,
      `文字 ${textColor} 亮度 ${luma(textColor).toFixed(2)}，底 ${APP_DARK_BG} 亮度 ${luma(APP_DARK_BG).toFixed(2)}`,
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

  // 浅色规则里不能出现 var()：导出时这些声明会被内联进 style 属性，
  // 微信那边没有我们的 CSS 变量，var(--background) 解析不出来，底色直接丢失
  for (const [tag, value] of Object.entries(theme.rules)) {
    check(
      `${id} rules.${tag} 不含 var()`,
      !/var\(/.test(value),
      `导出会内联这段声明，微信侧没有变量可解析：${value}`,
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
