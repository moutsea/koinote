// 粘贴转存的判定逻辑。判错的症状很隐蔽：少转存一类地址，几个月后某些文档裂图；
// 多转存一类（把自己的图又抓一遍），则是静默的重复上传。点击时都看不出来。
import {
  dataUriToFile,
  imageSrcsFromHtml,
  isDataUri,
  isOwnImage,
  needsRehost,
  replaceImageSrcs,
} from "./_rehost_bundle.mjs";

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(label, g === w, `得到 ${g}，期望 ${w}`);
}

const HEX = "0123456789abcdef0123456789abcdef";

// ---------- isOwnImage ----------
ok("CDN 上的自己的图", isOwnImage(`https://img.koinote.app/u/alice/${HEX}.png`));
ok("Worker 代理的自己的图", isOwnImage(`/images/u/alice/${HEX}.png`));
ok("带查询串仍认得", isOwnImage(`https://img.koinote.app/u/alice/${HEX}.png?v=2`));
ok("带 fragment 仍认得", isOwnImage(`/images/u/alice/${HEX}.webp#x`));
ok("jpg/gif/webp 都认", isOwnImage(`/images/u/a/${HEX}.gif`));
ok("别人站上的图不算自己的", !isOwnImage("https://example.com/photo.png"));
ok("hex 太短不算", !isOwnImage("/images/u/alice/abc.png"));
ok("扩展名不在白名单不算", !isOwnImage(`/images/u/alice/${HEX}.svg`));
ok("空串不算", !isOwnImage(""));
ok("只有空白不算", !isOwnImage("   "));

// ---------- needsRehost ----------
ok("别人站上的 https 图要转存", needsRehost("https://example.com/a.png"));
ok("别人站上的 http 图要转存", needsRehost("http://example.com/a.png"));
ok("自己的图不必转存", !needsRehost(`https://img.koinote.app/u/alice/${HEX}.png`));
ok("Worker 代理的自己的图不必转存", !needsRehost(`/images/u/alice/${HEX}.png`));
ok("data URI 不走代抓", !needsRehost("data:image/png;base64,AAAA"));
ok("blob 不走代抓", !needsRehost("blob:https://example.com/uuid"));
ok("file 不走代抓", !needsRehost("file:///etc/passwd"));
ok("站内相对路径不走代抓", !needsRehost("/static/logo.png"));
ok("协议相对地址不走代抓", !needsRehost("//example.com/a.png"));
ok("空串不走代抓", !needsRehost(""));

// 不变量：自己的图永远不该被转存（否则每次粘贴自己的文档都会重复上传）
for (const ext of ["png", "jpg", "gif", "webp"]) {
  for (const base of ["https://img.koinote.app", "https://cdn.example.org/sub", ""]) {
    const url = `${base}/images/u/alice/${HEX}.${ext}`;
    ok(`自己的 ${ext} 图（${base || "相对"}）不被转存`, !needsRehost(url));
  }
}

// ---------- isDataUri ----------
ok("data URI", isDataUri("data:image/png;base64,AAAA"));
ok("大写 DATA 也认", isDataUri("DATA:image/png;base64,AAAA"));
ok("前置空白也认", isDataUri("  data:image/png;base64,AAAA"));
ok("http 不是 data URI", !isDataUri("https://example.com/a.png"));

// ---------- imageSrcsFromHtml ----------
eq(
  "双引号",
  imageSrcsFromHtml('<img src="https://example.com/a.png">'),
  ["https://example.com/a.png"],
);
eq("单引号", imageSrcsFromHtml("<img src='https://e.com/b.png'>"), [
  "https://e.com/b.png",
]);
eq("不带引号", imageSrcsFromHtml("<img src=https://e.com/c.png>"), [
  "https://e.com/c.png",
]);
eq(
  "多个 img，保序",
  imageSrcsFromHtml(
    '<p><img src="https://e.com/1.png"><span>x</span><img src="https://e.com/2.png"></p>',
  ),
  ["https://e.com/1.png", "https://e.com/2.png"],
);
eq(
  "重复的 src 去重",
  imageSrcsFromHtml('<img src="https://e.com/1.png"><img src="https://e.com/1.png">'),
  ["https://e.com/1.png"],
);
eq(
  "src 前面有别的属性",
  imageSrcsFromHtml('<img alt="x" width="10" src="https://e.com/a.png">'),
  ["https://e.com/a.png"],
);
eq("大写标签和属性", imageSrcsFromHtml('<IMG SRC="https://e.com/a.png">'), [
  "https://e.com/a.png",
]);
eq("没有 img", imageSrcsFromHtml("<p>纯文字</p>"), []);
eq("空串", imageSrcsFromHtml(""), []);
// a[href] 里的地址不该被当成图片
eq(
  "只取 img 的 src，不取 a 的 href",
  imageSrcsFromHtml('<a href="https://e.com/page.png">链接</a>'),
  [],
);

// ---------- replaceImageSrcs ----------
{
  const html = '<img src="https://e.com/a.png"><img src="https://e.com/b.png">';
  const mapping = new Map([["https://e.com/a.png", "/images/u/alice/x.png"]]);
  eq(
    "只替换映射里有的",
    replaceImageSrcs(html, mapping),
    '<img src="/images/u/alice/x.png"><img src="https://e.com/b.png">',
  );
}
{
  // 同一个字面值也出现在 a[href] 里 —— 全文 replace 会连带改掉它
  const html = '<a href="https://e.com/a.png">x</a><img src="https://e.com/a.png">';
  const mapping = new Map([["https://e.com/a.png", "/images/u/alice/x.png"]]);
  const out = replaceImageSrcs(html, mapping);
  ok("不动 a[href]", out.includes('href="https://e.com/a.png"'), out);
  ok("改掉 img[src]", out.includes('src="/images/u/alice/x.png"'), out);
}
{
  const html = '<img src="https://e.com/a.png">';
  eq("空映射原样返回", replaceImageSrcs(html, new Map()), html);
}
{
  // 单引号和无引号的 src 也要能替换
  const html = "<img src='https://e.com/a.png'><img src=https://e.com/b.png>";
  const mapping = new Map([
    ["https://e.com/a.png", "/x.png"],
    ["https://e.com/b.png", "/y.png"],
  ]);
  eq(
    "单引号与无引号都替换，且统一成双引号",
    replaceImageSrcs(html, mapping),
    '<img src="/x.png"><img src="/y.png">',
  );
}

// ---------- dataUriToFile ----------
{
  // 1x1 透明 PNG
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const file = dataUriToFile(png);
  ok("base64 PNG 转成 File", file !== null);
  ok("MIME 正确", file?.type === "image/png", file?.type);
  ok("文件名带 png 后缀", file?.name.endsWith(".png"), file?.name);
  ok("字节非空", (file?.size ?? 0) > 0, String(file?.size));
  // PNG 魔数必须原样保留，否则服务端按文件头校验时会拒掉
  const bytes = new Uint8Array(await file.arrayBuffer());
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  eq("PNG 魔数完整", Array.from(bytes.slice(0, 8)), magic);
}
{
  const file = dataUriToFile("data:image/jpeg;base64,/9j/4AAQSkZJRg==", 3);
  ok("jpeg 的扩展名", file?.name === "pasted-4.jpeg", file?.name);
}
ok("非图片的 data URI 返回 null", dataUriToFile("data:text/html;base64,PGI+") === null);
ok("不是 data URI 返回 null", dataUriToFile("https://e.com/a.png") === null);
ok("空 payload 返回 null", dataUriToFile("data:image/png;base64,") === null);
ok("非法 base64 返回 null", dataUriToFile("data:image/png;base64,!!!!") === null);
ok("空串返回 null", dataUriToFile("") === null);

// 不变量：needsRehost 与 isDataUri 不能同时为真 —— 两条处理路径必须互斥，
// 否则同一张图会既走代抓又走本地上传，出现两份对象
for (const src of [
  "data:image/png;base64,AAAA",
  "https://example.com/a.png",
  `/images/u/alice/${HEX}.png`,
  "blob:https://e.com/uuid",
  "",
]) {
  ok(
    `处理路径互斥: ${src.slice(0, 32) || "(空)"}`,
    !(needsRehost(src) && isDataUri(src)),
  );
}

console.log(`\nrehost: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
