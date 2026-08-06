// 头像首字回落。
//
// 邮箱注册的用户没有头像，OAuth 用户的头像地址也会失效，这两种情况都落到「名字首字」。
// 取首字看着是一行代码的事，实际全是 Unicode 的坑：name[0] 按 UTF-16 码元取，
// emoji 昵称会截出半个代理对，渲染成乱码方块。
import { firstChar } from "./_avatar_bundle.mjs";

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  if (got === want) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  }
}

// ---------- 常规 ----------
eq("英文名取首字母并大写", firstChar("alice"), "A");
eq("已大写保持", firstChar("Alice"), "A");
eq("中文名取首字", firstChar("张三"), "张");
eq("日文名", firstChar("たなか"), "た");
eq("邮箱兜底时取首字母", firstChar("zhang@example.com"), "Z");

// ---------- 空白 ----------
eq("空串", firstChar(""), "");
eq("纯空格", firstChar("   "), "");
eq("前导空格被裁掉", firstChar("  bob"), "B");
eq("制表与换行也算空白", firstChar("\t\nbob"), "B");

// ---------- 代理对 ----------
//
// 这几条是这个函数存在的理由。name[0] 在这里会返回半个代理对（\uD83D 之类），
// 浏览器渲染成一个乱码方块，而不是空 —— 所以 UI 上看不出"出错了"，只觉得难看。
{
  // 😀 U+1F600，两个 UTF-16 码元
  const emoji = "😀";
  eq("emoji 完整取出", firstChar(emoji), emoji);
  eq("emoji 开头的昵称", firstChar("😀 小明"), emoji);
  // 对照：证明这条断言不是白测的 —— 朴素取法确实会截半
  eq("对照：朴素取法会截半", emoji[0].length, 1);
  eq("对照：完整 emoji 是两个码元", emoji.length, 2);
}
{
  // 𠮷 U+20BB7，辅助平面的生僻汉字（"𠮷野家"那个字）
  const rare = "𠮷";
  eq("辅助平面汉字完整取出", firstChar(rare), rare);
  eq("对照：它也是两个码元", rare.length, 2);
}

// ---------- toUpperCase 不该破坏非拉丁字符 ----------
//
// 中日文没有大小写，toUpperCase 应当是恒等的。
// 德文 ß 是个例外（toUpperCase 变成两个字符 SS），这里钉住我们知道这件事：
// 取的仍然是单个字符的大写形式，不是把整串变长
eq("中文不受 toUpperCase 影响", firstChar("张"), "张");
eq("ß 的大写是 SS（已知行为）", firstChar("ßeta"), "SS");

// ---------- 单字符 ----------
eq("单个字母", firstChar("a"), "A");
eq("单个汉字", firstChar("李"), "李");

// ---------- 非字母开头 ----------
eq("数字开头", firstChar("42号"), "4");
eq("下划线开头", firstChar("_admin"), "_");

console.log(`\navatar: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
