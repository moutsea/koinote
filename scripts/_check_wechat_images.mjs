// 微信导出的图片地址处理：相对地址绝对化 + 公网可达性判断。
//
// 为什么值得单独一套：这个 bug 的症状完全不在我们的页面里 —— 点复制成功，
// 粘贴成功，等到公众号预览时才看到裂图。没有断言的话，唯一的发现途径是
// 用户发一篇文章出去。
import { parseHTML } from "linkedom";
import {
  addWechatImageCaptions,
  absolutizeSrc,
  auditWechatImages,
  isLocalHost,
  isReachableByWechat,
  WECHAT_SKIP_CAPTION_ATTR,
} from "./_wechat_images_bundle.mjs";

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
    console.error(
      `FAIL  ${label}${detail === undefined ? "" : ` —— ${JSON.stringify(detail)}`}`,
    );
  }
}

// ---------- isLocalHost ----------

for (const host of [
  "localhost",
  "LocalHost",
  "127.0.0.1",
  "127.1.2.3", // 整个 127/8 都是回环
  "0.0.0.0",
  "10.0.0.5",
  "192.168.1.10",
  "172.16.0.1",
  "172.31.255.255",
  "169.254.1.1", // link-local
  "::1",
  "[::1]", // URL.hostname 对 IPv6 会带方括号
  "mac.local",
  "svc.internal",
  "box.lan",
]) {
  ok(`isLocalHost 认出内网：${host}`, isLocalHost(host) === true, host);
}

for (const host of [
  "img.koinote.app",
  "example.com",
  "1.1.1.1",
  "8.8.8.8",
  "172.32.0.1", // 172 私网只到 31，这个是公网
  "172.15.0.1", // 也在 16 以下
  "11.0.0.1", // 10/8 之外
  "192.169.1.1", // 192.168 之外
  "localhost.example.com", // 只是前缀像，不是内网后缀
]) {
  ok(`isLocalHost 放过公网：${host}`, isLocalHost(host) === false, host);
}

// 空主机名判为内网：拿不到主机就不能声称微信抓得到
ok("空主机名视为内网", isLocalHost("") === true);
ok("纯空白主机名视为内网", isLocalHost("   ") === true);

// ---------- absolutizeSrc ----------

const ORIGIN = "http://localhost:5273";

eq(
  "相对地址补成绝对",
  absolutizeSrc("/images/u/abc/deadbeef.png", ORIGIN),
  "http://localhost:5273/images/u/abc/deadbeef.png",
);
eq(
  "已是绝对地址则不动",
  absolutizeSrc("https://img.koinote.app/u/abc/deadbeef.png", ORIGIN),
  "https://img.koinote.app/u/abc/deadbeef.png",
);
eq("data URI 原样返回", absolutizeSrc("data:image/png;base64,AAA=", ORIGIN), "data:image/png;base64,AAA=");
eq("blob URL 原样返回", absolutizeSrc("blob:http://x/y", ORIGIN), "blob:http://x/y");
eq("空串原样返回", absolutizeSrc("", ORIGIN), "");
// 查询串和 fragment 必须留着：R2 自定义域名可能带签名参数
eq(
  "保留查询串",
  absolutizeSrc("/images/a.png?v=2", ORIGIN),
  "http://localhost:5273/images/a.png?v=2",
);

// ---------- isReachableByWechat ----------

ok(
  "公网 https 可达",
  isReachableByWechat("https://img.koinote.app/u/a/b.png") === true,
);
ok("公网 http 可达", isReachableByWechat("http://example.com/a.png") === true);
ok(
  "localhost 不可达",
  isReachableByWechat("http://localhost:5273/images/a.png") === false,
);
ok(
  "127.0.0.1 不可达",
  isReachableByWechat("http://127.0.0.1:8788/images/a.png") === false,
);
ok(
  "内网 IP 不可达",
  isReachableByWechat("http://192.168.1.5/images/a.png") === false,
);
// 没绝对化成功的相对地址：微信无从抓取
ok("裸相对地址不可达", isReachableByWechat("/images/a.png") === false);
ok("空串不可达", isReachableByWechat("") === false);
// file: 之类的非 http scheme
ok("file: 不可达", isReachableByWechat("file:///tmp/a.png") === false);

// ---------- auditWechatImages 的端到端 ----------

function audit(html, origin = ORIGIN) {
  const { document } = parseHTML(`<div id="stage">${html}</div>`);
  const stage = document.getElementById("stage");
  return { result: auditWechatImages(stage, origin), stage };
}

function captions(html) {
  const { document } = parseHTML(`<div id="stage">${html}</div>`);
  const stage = document.getElementById("stage");
  return { added: addWechatImageCaptions(stage), stage };
}

// ---------- Markdown 图片 alt 转可见图注 ----------

{
  const { added, stage } = captions(
    '<p><img src="/images/a.png" alt="  海边 &amp; 日落  "></p>',
  );
  eq("普通图片新增一个图注", added, 1);
  eq("图注使用解码后的纯文本", stage.querySelectorAll("p")[1].textContent, "海边 & 日落");
  eq("图注放在图片段落之后", stage.children[1].textContent, "海边 & 日落");
  ok(
    "图注携带可内联的样式",
    stage.children[1].getAttribute("data-wechat-keep-style")?.includes("text-align:center"),
  );
}

{
  const { added, stage } = captions(
    '<p><a href="https://example.com"><img src="/images/a.png" alt="可点击图片"></a></p>',
  );
  eq("链接图片新增一个图注", added, 1);
  eq("链接图片的图注在整个段落之后", stage.children[1].textContent, "可点击图片");
}

{
  const { added, stage } = captions(
    `<p><img src="/images/formula.png" alt="x^2" ${WECHAT_SKIP_CAPTION_ATTR}="true"></p>`,
  );
  eq("公式图片不新增图注", added, 0);
  eq("公式图片仍只有原段落", stage.children.length, 1);
}

{
  const { added } = captions('<p><img src="/images/a.png" alt=""></p>');
  eq("空 alt 不新增图注", added, 0);
}

{
  const source = '<p>看这张 <img src="/images/a.png" alt="图注"> 很好</p>';
  const { added, stage } = captions(source);
  const serialized = stage.innerHTML;
  const { document } = parseHTML(`<div id="reparsed">${serialized}</div>`);
  const reparsed = document.getElementById("reparsed");
  eq("行内图片不新增图注", added, 0);
  eq("行内图片重解析后仍只有一个段落", reparsed.querySelectorAll("p").length, 1);
  eq("行内图片重解析后文字不掉出段落", reparsed.querySelector("p").textContent, "看这张  很好");
  eq("行内图片最终 HTML 保持原结构", serialized, source);
}

{
  const source = '<p><img src="/images/a.png" alt="甲"><img src="/images/b.png" alt="乙"></p>';
  const { added, stage } = captions(source);
  const { document } = parseHTML(`<div id="reparsed">${stage.innerHTML}</div>`);
  const reparsed = document.getElementById("reparsed");
  eq("同段多图不新增图注", added, 0);
  eq("同段多图重解析后仍只有一个段落", reparsed.querySelectorAll("p").length, 1);
  eq("同段多图重解析后仍有两张图", reparsed.querySelectorAll("img").length, 2);
}

{
  const source = '<ul><li><img src="/images/a.png" alt="列表图"></li></ul>';
  const { added, stage } = captions(source);
  const { document } = parseHTML(`<div id="reparsed">${stage.innerHTML}</div>`);
  const reparsed = document.getElementById("reparsed");
  eq("列表图片不新增图注", added, 0);
  eq("列表图片重解析后仍只有一个列表项", reparsed.querySelectorAll("li").length, 1);
  eq("列表图片重解析后没有额外段落", reparsed.querySelectorAll("p").length, 0);
}

{
  // 本地开发的真实形态：Worker 回落到 /images/<key>
  const { result, stage } = audit(
    '<p><img src="/images/u/user1/deadbeef12345678.png" alt="a"></p>',
  );
  eq("本地相对地址：total", result.total, 1);
  eq("本地相对地址：absolutized", result.absolutized, 1);
  eq("本地相对地址：unreachable", result.unreachable, 1);
  eq("本地相对地址：hosts", result.unreachableHosts, ["localhost"]);
  // 关键断言：src 真的被改写进了 DOM，而不只是统计数字对
  eq(
    "本地相对地址：src 已绝对化",
    stage.querySelector("img").getAttribute("src"),
    "http://localhost:5273/images/u/user1/deadbeef12345678.png",
  );
}

{
  // 配了 CDN 之后的形态
  const { result, stage } = audit(
    '<p><img src="https://img.koinote.app/u/user1/deadbeef12345678.png"></p>',
  );
  eq("CDN 地址：unreachable", result.unreachable, 0);
  eq("CDN 地址：absolutized", result.absolutized, 0);
  eq("CDN 地址：hosts 为空", result.unreachableHosts, []);
  eq(
    "CDN 地址：src 未被改动",
    stage.querySelector("img").getAttribute("src"),
    "https://img.koinote.app/u/user1/deadbeef12345678.png",
  );
}

{
  // 部署到公网之后，即便仍走 Worker 代理（未配 IMAGE_PUBLIC_BASE），也是可达的。
  // 这条钉住「相对地址本身不是问题，问题是补全后落在哪个域」
  const { result, stage } = audit(
    '<p><img src="/images/u/user1/deadbeef12345678.png"></p>',
    "https://koinote.app",
  );
  eq("线上 Worker 代理：absolutized", result.absolutized, 1);
  eq("线上 Worker 代理：unreachable", result.unreachable, 0);
  eq(
    "线上 Worker 代理：src 补成线上域",
    stage.querySelector("img").getAttribute("src"),
    "https://koinote.app/images/u/user1/deadbeef12345678.png",
  );
}

{
  // 多张混合：可达与不可达同时存在，计数不能互相污染
  const { result } = audit(
    [
      '<img src="https://img.koinote.app/a.png">',
      '<img src="/images/b.png">',
      '<img src="http://127.0.0.1:8788/images/c.png">',
      '<img src="https://cdn.example.com/d.png">',
    ].join(""),
  );
  eq("混合：total", result.total, 4);
  eq("混合：unreachable", result.unreachable, 2);
  // 主机名去重，且两个不同的内网主机都要列出来
  eq("混合：hosts", result.unreachableHosts.sort(), ["127.0.0.1", "localhost"]);
}

{
  // 同一个内网主机出现多次，hosts 里只出现一次（提示里不该刷屏）
  const { result } = audit(
    '<img src="/images/a.png"><img src="/images/b.png"><img src="/images/c.png"><img src="/images/d.png">',
  );
  eq("重复主机：unreachable 逐张计", result.unreachable, 4);
  eq("重复主机：hosts 去重", result.unreachableHosts, ["localhost"]);
}

{
  // 没有图片的文章：不能误报
  const { result } = audit("<p>纯文字</p><pre><code>code</code></pre>");
  eq("无图：total", result.total, 0);
  eq("无图：unreachable", result.unreachable, 0);
}

{
  // 公式图走的是同一条路（wechatMath 产出的也是 img），带 keep-style 属性时
  // 改写 src 不能碰坏别的属性
  const { result, stage } = audit(
    '<img src="/images/formula.png" alt="x^2" data-wechat-keep-style="width:20px;">',
  );
  eq("公式图：unreachable", result.unreachable, 1);
  const img = stage.querySelector("img");
  eq("公式图：alt 保留", img.getAttribute("alt"), "x^2");
  eq(
    "公式图：keep-style 保留",
    img.getAttribute("data-wechat-keep-style"),
    "width:20px;",
  );
}

{
  // data URI 不该被判为裂图 —— 它自带内容，不需要谁去抓
  const { result } = audit('<img src="data:image/png;base64,iVBORw0KGgo=">');
  eq("data URI：absolutized 为 0", result.absolutized, 0);
  eq("data URI：unreachable 为 0", result.unreachable, 0);
}

console.log(`\n微信图片地址：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
