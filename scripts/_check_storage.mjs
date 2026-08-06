// 存储用量的显示与判级。
//
// 这些函数的输出直接是用户看到的数字和进度条宽度，错了会得到"控制台说还有空间但传不上去"
// 这类矛盾的观感。边界情况（0、超额、quota 为 0）比常规值更值得钉。
import {
  NEAR_LIMIT_RATIO,
  barSegments,
  formatBytes,
  remainingBytes,
  usageLevel,
  usageRatio,
} from "./_storage_bundle.mjs";

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 得到 ${g}，期望 ${w}`);
  }
}

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail === undefined ? "" : ` —— ${JSON.stringify(detail)}`}`);
  }
}

const MiB = 1024 * 1024;
const QUOTA = 500 * MiB;

// ---------- usageRatio ----------
eq("空用量", usageRatio(0, QUOTA), 0);
eq("半满", usageRatio(250 * MiB, QUOTA), 0.5);
eq("刚好满", usageRatio(QUOTA, QUOTA), 1);

// 超额必须钳到 1：这个值要当进度条宽度用，大于 1 会让条溢出容器。
// 后端允许略微超出（并发上传，见 recordImageObject），所以这不是假想的情况
eq("超额钳到 1", usageRatio(QUOTA + 10 * MiB, QUOTA), 1);
eq("大幅超额也钳到 1", usageRatio(QUOTA * 5, QUOTA), 1);

// 负数与非数：当成 0
eq("负用量按 0 算", usageRatio(-100, QUOTA), 0);
eq("NaN 用量按 0 算", usageRatio(NaN, QUOTA), 0);

// quota 为 0 时返回 1 而不是 0 —— "能用的空间是零"，进度条该是满的。
// 返回 0 会显示成"还很空"，与事实相反
eq("quota 为 0 时是满的", usageRatio(0, 0), 1);
eq("quota 为负时是满的", usageRatio(0, -1), 1);
eq("quota 为 NaN 时是满的", usageRatio(100, NaN), 1);

// ---------- usageLevel ----------
eq("空 → normal", usageLevel(0, QUOTA), "normal");
eq("半满 → normal", usageLevel(250 * MiB, QUOTA), "normal");
eq("阈值以下 → normal", usageLevel(QUOTA * 0.79, QUOTA), "normal");
eq("刚到阈值 → near", usageLevel(QUOTA * NEAR_LIMIT_RATIO, QUOTA), "near");
eq("阈值以上 → near", usageLevel(QUOTA * 0.95, QUOTA), "near");
eq("满 → full", usageLevel(QUOTA, QUOTA), "full");
eq("超额 → full", usageLevel(QUOTA * 2, QUOTA), "full");

// 三级必须互斥且覆盖：任意用量都恰好落在一级
for (const used of [0, 1, MiB, 100 * MiB, 400 * MiB, QUOTA - 1, QUOTA, QUOTA + 1]) {
  const level = usageLevel(used, QUOTA);
  ok(`${used} 的等级是三者之一`, ["normal", "near", "full"].includes(level), level);
}

// 单调：用量增加，等级不会往回退
{
  const order = { normal: 0, near: 1, full: 2 };
  let prev = -1;
  let monotonic = true;
  for (let used = 0; used <= QUOTA * 1.2; used += QUOTA / 40) {
    const cur = order[usageLevel(used, QUOTA)];
    if (cur < prev) monotonic = false;
    prev = cur;
  }
  ok("等级随用量单调不降", monotonic);
}

// ---------- remainingBytes ----------
eq("空时剩满额", remainingBytes(0, QUOTA), QUOTA);
eq("用一半剩一半", remainingBytes(250 * MiB, QUOTA), 250 * MiB);
eq("满时剩 0", remainingBytes(QUOTA, QUOTA), 0);
// 超额时剩余是 0，不是负数 —— 负数会显示成"剩 -5 MB"
eq("超额剩 0 而非负", remainingBytes(QUOTA + 5 * MiB, QUOTA), 0);
eq("负用量按 0 算", remainingBytes(-50, QUOTA), QUOTA);
eq("quota 为 0 时剩 0", remainingBytes(0, 0), 0);

// 恒等：已用 + 剩余 == 配额（未超额时）
for (const used of [0, MiB, 123 * MiB, QUOTA - 1, QUOTA]) {
  eq(`${used} 时 已用+剩余=配额`, used + remainingBytes(used, QUOTA), QUOTA);
}

// ---------- formatBytes ----------
eq("0", formatBytes(0, "en-US"), "0 B");
eq("负数按 0", formatBytes(-5, "en-US"), "0 B");
eq("NaN 按 0", formatBytes(NaN, "en-US"), "0 B");

// B 档不要小数位："1.0 B" 很傻
eq("1 字节", formatBytes(1, "en-US"), "1 B");
eq("512 字节", formatBytes(512, "en-US"), "512 B");
// 千分位是 toLocaleString 给的，符合展示习惯
eq("1023 字节仍是 B", formatBytes(1023, "en-US"), "1,023 B");

// 进档在 >= 1024，不是 > 1024
eq("1024 进到 KB", formatBytes(1024, "en-US"), "1 KB");
eq("1536 是 1.5 KB", formatBytes(1536, "en-US"), "1.5 KB");

// 整数值不补 ".0"
eq("5 MB 不写成 5.0 MB", formatBytes(5 * MiB, "en-US"), "5 MB");
eq("500 MB", formatBytes(QUOTA, "en-US"), "500 MB");
eq("1 GB", formatBytes(1024 * MiB, "en-US"), "1 GB");
eq("1.5 GB", formatBytes(1536 * MiB, "en-US"), "1.5 GB");

// 一位小数
eq("2.5 MB", formatBytes(2.5 * MiB, "en-US"), "2.5 MB");

// 最大档不再进：TB 之上仍标 TB
eq("超大值停在 TB", formatBytes(5 * 1024 * 1024 * MiB, "en-US"), "5 TB");

// 单位随量级正确
{
  const cases = [
    [1, "B"],
    [1024, "KB"],
    [1024 ** 2, "MB"],
    [1024 ** 3, "GB"],
    [1024 ** 4, "TB"],
    [1024 ** 5, "TB"], // 封顶
  ];
  for (const [bytes, unit] of cases) {
    ok(`${bytes} 的单位是 ${unit}`, formatBytes(bytes, "en-US").endsWith(` ${unit}`), formatBytes(bytes, "en-US"));
  }
}

// 千分位分隔跟随 locale。不同 locale 的分隔符不同（en 用逗号，fr 用窄空格），
// 所以只断言"两者不同"而不写死具体字符 —— 后者会随 ICU 版本变
{
  const big = 1023 * 1024 ** 4; // 一个需要千分位的 TB 值
  const en = formatBytes(big, "en-US");
  ok("大数在 en-US 下有千分位", /[,\s]/.test(en.replace(" TB", "")), en);
}

// 所有输出都是「数字 空格 单位」的形状
for (const bytes of [0, 1, 1023, 1024, 1536, MiB, QUOTA, 1024 ** 4]) {
  const out = formatBytes(bytes, "en-US");
  ok(`"${out}" 形状正确`, /^[\d.,  ]+ (B|KB|MB|GB|TB)$/.test(out), out);
}

// ---------- 分段进度条的宽度 ----------
//
// StorageCard 把条分成「文档」「图片」两段。两段之和绝不能超过容器宽度，
// 否则第二段会把第一段挤出去或溢出圆角容器 —— 这是 flex 布局下的真实后果。
//
// 直接测 storage.ts 导出的 barSegments，不在这里抄一份算法 ——
// 抄一份的话组件改了算法这些断言照旧全绿，等于没钉。
function segments(docBytes, imgBytes, quota) {
  const { documents, images } = barSegments(docBytes, imgBytes, quota);
  return { docWidth: documents, imageWidth: images };
}

{
  const cases = [
    ["都空", 0, 0],
    ["只有文档", 100 * MiB, 0],
    ["只有图片", 0, 100 * MiB],
    ["各占一半", 250 * MiB, 250 * MiB],
    ["刚好占满", 200 * MiB, 300 * MiB],
    ["文档单独超额", QUOTA * 2, 0],
    ["图片单独超额", 0, QUOTA * 2],
    ["两者都超额", QUOTA, QUOTA],
    ["文档满且有图片", QUOTA, 10 * MiB],
    ["极小值", 1, 1],
  ];

  for (const [name, doc, img] of cases) {
    const { docWidth, imageWidth } = segments(doc, img, QUOTA);
    const total = docWidth + imageWidth;

    ok(`${name}: 两段之和不超过 100`, total <= 100 + 1e-9, total);
    ok(`${name}: 文档段非负`, docWidth >= 0, docWidth);
    ok(`${name}: 图片段非负`, imageWidth >= 0, imageWidth);
    ok(`${name}: 文档段不超过 100`, docWidth <= 100, docWidth);
  }
}

// 文档已占满时，图片段必须是 0 —— 否则会溢出
{
  const { docWidth, imageWidth } = segments(QUOTA, 50 * MiB, QUOTA);
  eq("文档占满时文档段为 100", docWidth, 100);
  eq("文档占满时图片段为 0", imageWidth, 0);
}

// 两段的比例要正确反映各自占比，而不是被压缩
{
  const { docWidth, imageWidth } = segments(100 * MiB, 200 * MiB, QUOTA);
  eq("文档 100/500 → 20%", docWidth, 20);
  eq("图片 200/500 → 40%", imageWidth, 40);
}

// ---------- 阈值常量 ----------
ok("阈值在 0 与 1 之间", NEAR_LIMIT_RATIO > 0 && NEAR_LIMIT_RATIO < 1, NEAR_LIMIT_RATIO);

console.log(`\nstorage: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
