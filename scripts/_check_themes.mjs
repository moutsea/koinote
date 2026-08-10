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

// ---------- 屏幕上正文区底色必须跟随应用底色 ----------
//
// 浅色主题的 body 底色大多是 #fff，而站点底色是宣纸 #f6f4ee。正文区是居中的
// 定宽列，底色差一点点，左右就各留一道竖边 —— 读起来是没对齐的瑕疵而不是层次。
// 深色变体早就用 var(--background) 解决了这个问题，浅色这边原本漏了。
//
// 关键约束：只能改屏幕呈现，theme.rules 必须保持原样导出到微信 ——
// 公众号阅读界面是白底，导出物的 #fff 是对的。
for (const theme of WECHAT_THEMES) {
  const { id } = theme;
  const css = themeToCSS(id);
  const lightBody = /(?:^|\n)\.koinote-themed\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const darkBody = /\.dark \.koinote-themed\{([^}]*)\}/.exec(css)?.[1] ?? "";

  const bodyBg = lastBg(theme.rules.body);
  const isLightSurface = bodyBg ? luma(bodyBg) > 0.6 : false;

  if (isLightSurface) {
    // 浅底主题：屏幕上必须跟随应用底色，且覆盖要排在主题声明之后才生效
    check(
      `${id} 浅色屏幕底色跟随应用`,
      lightBody.includes("background:var(--background)"),
      lightBody,
    );
    const idx = lightBody.lastIndexOf("background:var(--background)");
    const lastLiteral = lightBody.lastIndexOf(`background:${bodyBg}`);
    check(
      `${id} 覆盖排在主题声明之后`,
      idx > lastLiteral,
      `var 在 ${idx}，字面色在 ${lastLiteral}`,
    );
  } else {
    // 深底的浅色变体（linear）：那是主题刻意的身份，且正文字色压在宣纸上读不了，
    // 必须保留。判据是亮度而不是 id 白名单 —— 后者新增主题时必然会漏。
    check(
      `${id} 深底浅色变体保留自己的底色`,
      !lightBody.includes("background:var(--background)"),
      lightBody,
    );
  }

  // 深色变体本来就该跟随应用底色，这条是原有行为，一并钉住防回退
  check(
    `${id} 深色屏幕底色跟随应用`,
    darkBody.includes("background:var(--background)"),
    darkBody,
  );

  // 导出用的规则表不能被这次改动污染：微信侧没有 CSS 变量可解析
  check(
    `${id} 导出规则不含 var()`,
    !/var\(/.test(theme.rules.body),
    theme.rules.body,
  );
}

// ---------- 文档标题跟着主题的 h1 走 ----------
//
// 标题在导出时就是正文的第一个 h1（各 export*.ts 里拼的 heading），所以编辑区
// 也必须用同一套排版。漏掉任何一套主题，表现就是那套主题下标题和正文的第一个
// h1 长得不一样 —— 而「编辑区即预览」本来是主题功能的全部意义。
//
// 挂在 .kn-doc-title 容器上而不是里面的 textarea：h1 的声明里既有排版也有盒模型
// （magazine 的上下 6px 实线、popart 的 box-shadow、多套主题的 border-bottom），
// 挂容器才能让边框和底色包住整块。
for (const theme of WECHAT_THEMES) {
  const { id } = theme;
  const css = themeToCSS(id);

  for (const [mode, prefix] of [
    ["浅色", ".koinote-themed"],
    ["深色", ".dark .koinote-themed"],
  ]) {
    // 收集该模式下所有 .kn-doc-title 规则块，按出现顺序拼起来（后面的覆盖前面的）
    const blocks = [
      ...css.matchAll(
        new RegExp(
          `(?:^|\\n)${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\.kn-doc-title\\{([^}]*)\\}`,
          "g",
        ),
      ),
    ].map((m) => m[1]);

    check(`${id} ${mode}模式有标题规则`, blocks.length > 0, String(blocks.length));

    const combined = blocks.join("");
    // 字号是「标题看起来像标题」的最低要求
    check(
      `${id} ${mode}模式标题有 font-size`,
      /font-size:/.test(combined),
      combined,
    );

    // 首个标题的上边距必须归零。主题的 h1 margin-top 是给正文中间的 h1 定的
    // （34~42px），标题在最上面，那段空白会白留一大片。
    // 而且覆盖必须排在主题声明之后 —— 顺序反了就不生效。
    const lastMarginTop = combined.lastIndexOf("margin-top:0");
    const lastMargin = Math.max(
      combined.lastIndexOf("margin:"),
      combined.lastIndexOf("margin-top:34"),
    );
    check(
      `${id} ${mode}模式标题上边距归零且排在主题声明之后`,
      lastMarginTop > lastMargin,
      `margin-top:0 在 ${lastMarginTop}，主题 margin 在 ${lastMargin}：${combined}`,
    );
  }

  // 标题规则不能只挂在 textarea 上 —— 那样带边框的主题（magazine / newsprint /
  // github 等）的线会画在输入框上而不是包住整块标题
  check(
    `${id} 标题规则挂在容器而非 textarea`,
    !/\.kn-doc-title\s*>\s*textarea\{/.test(css),
    "themeCss 不该直接给 textarea 出规则",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
