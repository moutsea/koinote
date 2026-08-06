// 朱砂色阶的对比度。
//
// 色阶是手写的（globals.css 的 @theme），不是从某个设计系统抄来的，所以「600 底配白字
// 能不能读」这种事没人替我保证过。编辑器里选中态、主按钮都用了这几档，配错的表现是
// 浅底上一层更浅的字 —— 截图上看着有颜色，实际读不出来。
//
// WCAG 2.1 的门槛：正文 4.5:1，大字（>=18.66px 粗体或 24px）3:1，非文字（图标、边框）3:1。

const SCALE = {
  50: "#fdf4f2",
  100: "#fbe7e3",
  200: "#f7d0c8",
  300: "#efaea1",
  400: "#e4826f",
  500: "#d45a43",
  600: "#b93b28",
  700: "#9c3020",
  800: "#82291d",
  900: "#6d251b",
  950: "#3b0f0a",
};

// 页面底色。浅色是宣纸，深色是玄墨
const PAPER_LIGHT = "#f6f4ee";
const PAPER_DARK = "#14130f";
const WHITE = "#ffffff";

let pass = 0;
let fail = 0;

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function atLeast(label, fg, bg, min) {
  const ratio = contrast(fg, bg);
  if (ratio >= min) {
    pass += 1;
  } else {
    fail += 1;
    console.error(
      `FAIL  ${label} —— ${ratio.toFixed(2)}:1，需要 ${min}:1 (${fg} on ${bg})`,
    );
  }
}

// ---------- 色阶单调 ----------
//
// 亮度必须随档位单调下降。手写色阶最容易犯的错是中间某档比邻档更亮，
// 于是 hover 状态看起来比静止状态更淡。
const steps = Object.keys(SCALE).map(Number).sort((a, b) => a - b);
for (let i = 1; i < steps.length; i += 1) {
  const prev = SCALE[steps[i - 1]];
  const cur = SCALE[steps[i]];
  if (luminance(prev) > luminance(cur)) {
    pass += 1;
  } else {
    fail += 1;
    console.error(
      `FAIL  ${steps[i - 1]} 应比 ${steps[i]} 亮 —— ${prev}=${luminance(prev).toFixed(4)}, ${cur}=${luminance(cur).toFixed(4)}`,
    );
  }
}

// ---------- 主按钮：白字压在 600 上 ----------
//
// 首页 CTA、登录提交、分享确认全是这个组合，是全站最显眼的一处
atLeast("白字 on cinnabar-600", WHITE, SCALE[600], 4.5);

// ---------- 编辑器选中态 ----------
//
// EditorToolbar: bg-cinnabar-100 + text-cinnabar-700
atLeast("cinnabar-700 on cinnabar-100", SCALE[700], SCALE[100], 4.5);
// TreeRow 选中的文档: bg-cinnabar-50 + text-cinnabar-800
atLeast("cinnabar-800 on cinnabar-50", SCALE[800], SCALE[50], 4.5);
// TreeRow 拖放目标: bg-cinnabar-100，里面是默认文字色（焦墨）
atLeast("焦墨 on cinnabar-100", "#1f2328", SCALE[100], 4.5);

// ---------- 深色主题 ----------
//
// 深色下 UI 用 300/400（.dark 里 --cinnabar 也换亮一档，同一个道理）
atLeast("cinnabar-400 on 玄墨", SCALE[400], PAPER_DARK, 4.5);
atLeast("cinnabar-300 on 玄墨", SCALE[300], PAPER_DARK, 4.5);
// EditorToolbar 深色选中态: dark:bg-cinnabar-950/60 + dark:text-cinnabar-300。
// 950/60 压在玄墨上近似 950 与玄墨的混合，这里用 950 本身做保守估计
atLeast("cinnabar-300 on cinnabar-950", SCALE[300], SCALE[950], 4.5);
// TreeRow 深色选中: dark:bg-cinnabar-950/50 + dark:text-cinnabar-200
atLeast("cinnabar-200 on cinnabar-950", SCALE[200], SCALE[950], 4.5);

// ---------- 正文链接 ----------
//
// 「去编辑器」这类行内链接用 600，压在宣纸上
atLeast("cinnabar-600 on 宣纸", SCALE[600], PAPER_LIGHT, 4.5);

// ---------- 非文字元素 ----------
//
// 焦点环、拖放目标环、折叠文件夹图标：3:1 足够。
// 浅色下这几处一律从 500 起，不能用 400 —— 见下面那条反向断言
atLeast("cinnabar-500 环 on 宣纸", SCALE[500], PAPER_LIGHT, 3);
atLeast("cinnabar-600 图标 on 宣纸", SCALE[600], PAPER_LIGHT, 3);

// 反向断言：400 在宣纸上「够不着」3:1。
//
// 钉住这条是因为 400 看着已经挺红了，很容易被顺手用在拖放目标环上，而那个环是拖拽时
// 唯一的落点提示 —— 看不见就等于没做。一旦有人把 400 调深到能过 3:1，这条会失败并
// 提醒他：要么改回来，要么把浅色下的环也一并降档，别让色阶失去层次。
{
  const ratio = contrast(SCALE[400], PAPER_LIGHT);
  if (ratio < 3) {
    pass += 1;
  } else {
    fail += 1;
    console.error(
      `FAIL  cinnabar-400 不应达到 3:1（当前 ${ratio.toFixed(2)}:1）—— ` +
        `400 调深了的话，浅色下的环/边框该重新评估档位`,
    );
  }
}

// ---------- 朱砂令牌本身 ----------
//
// --cinnabar 在两个主题下各自要压得住自己的纸底。
// 深色下换成 #d8503a 就是为了这条，浅色的 #b93b28 在玄墨上只有 2.x:1
atLeast("--cinnabar 浅色 on 宣纸", "#b93b28", PAPER_LIGHT, 4.5);
atLeast("--cinnabar 深色 on 玄墨", "#d8503a", PAPER_DARK, 4.5);
// 页脚固定深底，朱砂在那里换成了更亮的 #df6a56
atLeast("页脚朱砂 on 页脚底", "#df6a56", "#24231f", 4.5);
// 页脚正文与次要文字
atLeast("页脚 ink-mid on 页脚底", "#c4beb2", "#24231f", 4.5);
atLeast("页脚 ink-faint on 页脚底", "#928d84", "#24231f", 3);

// ---------- 墨色令牌 ----------
//
// 正文、次要文字在各自纸底上的可读性
atLeast("焦墨 on 宣纸", "#1f2328", PAPER_LIGHT, 4.5);
atLeast("浓墨 on 宣纸", "#34383f", PAPER_LIGHT, 4.5);
atLeast("中墨 on 宣纸", "#626872", PAPER_LIGHT, 4.5);
atLeast("淡墨银 on 玄墨", "#ece6d6", PAPER_DARK, 4.5);
atLeast("亮墨 on 玄墨", "#d8d1bf", PAPER_DARK, 4.5);
atLeast("中墨银 on 玄墨", "#9a9483", PAPER_DARK, 4.5);

console.log(`\ncontrast: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
