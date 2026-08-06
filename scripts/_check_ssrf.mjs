// 代抓端点的目标校验。判错的代价是内网可达，而错了没有任何可见症状 —— 只能靠断言。
import { checkFetchTarget } from "./_ssrf_bundle.mjs";

let pass = 0;
let fail = 0;

function blocked(url, note = "") {
  const v = checkFetchTarget(url);
  if (!v.ok) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  应拒绝 ${url}${note ? ` (${note})` : ""} —— 却放行了`);
  }
}

function allowed(url) {
  const v = checkFetchTarget(url);
  if (v.ok) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  应放行 ${url} —— 却以 ${v.reason} 拒绝`);
  }
}

function reasonIs(url, want) {
  const v = checkFetchTarget(url);
  if (!v.ok && v.reason === want) pass += 1;
  else {
    fail += 1;
    console.error(
      `FAIL  ${url} 的 reason 应为 ${want}，得到 ${v.ok ? "ok" : v.reason}`,
    );
  }
}

// ---------- 正常的公网图片地址 ----------
allowed("https://example.com/a.png");
allowed("http://example.com/a.png");
allowed("https://example.com:443/a.png");
allowed("http://example.com:80/a.png");
allowed("https://img.example.co.uk/deep/path/a.jpg?v=2");
allowed("https://1.1.1.1/a.png");
allowed("https://8.8.8.8/a.png");
// 公网 IPv6
allowed("https://[2606:4700:4700::1111]/a.png");

// ---------- scheme ----------
reasonIs("data:image/png;base64,AAAA", "scheme_not_allowed");
reasonIs("file:///etc/passwd", "scheme_not_allowed");
reasonIs("gopher://example.com/", "scheme_not_allowed");
reasonIs("ftp://example.com/a.png", "scheme_not_allowed");
reasonIs("blob:https://example.com/uuid", "scheme_not_allowed");
reasonIs("javascript:alert(1)", "scheme_not_allowed");

// ---------- 端口 ----------
reasonIs("http://example.com:22/", "port_not_allowed");
reasonIs("http://example.com:6379/", "port_not_allowed");
reasonIs("http://example.com:5432/", "port_not_allowed");
reasonIs("http://example.com:8080/", "port_not_allowed");

// ---------- 凭证 ----------
reasonIs("http://user:pw@example.com/a.png", "credentials_not_allowed");
reasonIs("http://user@example.com/a.png", "credentials_not_allowed");

// ---------- 主机名 ----------
reasonIs("http://localhost/a.png", "host_not_allowed");
reasonIs("http://LOCALHOST/a.png", "host_not_allowed");
reasonIs("http://metadata.google.internal/computeMetadata/v1/", "host_not_allowed");
reasonIs("http://foo.internal/a.png", "host_not_allowed");
reasonIs("http://nas.local/a.png", "host_not_allowed");
reasonIs("http://router.lan/a.png", "host_not_allowed");

// ---------- 回环与私网，点分十进制 ----------
blocked("http://127.0.0.1/a.png");
blocked("http://127.1.2.3/a.png");
blocked("http://10.0.0.1/a.png");
blocked("http://192.168.1.1/a.png");
blocked("http://172.16.0.1/a.png");
blocked("http://172.31.255.255/a.png");
blocked("http://0.0.0.0/a.png");
// 云元数据服务：拿到的是 IAM 凭证，这条最要紧
blocked("http://169.254.169.254/latest/meta-data/", "云元数据");
blocked("http://100.64.0.1/a.png", "CGNAT");
blocked("http://224.0.0.1/a.png", "组播");
blocked("http://255.255.255.255/a.png");

// 172.16/12 的边界：15 和 32 不在私网里，不该被误拒
allowed("http://172.15.0.1/a.png");
allowed("http://172.32.0.1/a.png");

// ---------- 回环的花式写法 ----------
// 这几种浏览器和 fetch 都会解析成 127.0.0.1，只按点分十进制匹配会全部漏掉
blocked("http://2130706433/a.png", "十进制整数形式的 127.0.0.1");
blocked("http://0x7f000001/a.png", "十六进制");
blocked("http://0177.0.0.1/a.png", "八进制");
blocked("http://127.1/a.png", "两段式");
blocked("http://127.0.1/a.png", "三段式");
blocked("http://0/a.png", "0 即 0.0.0.0");

// 十进制形式的其它私网地址
blocked("http://167772161/a.png", "10.0.0.1");
blocked("http://3232235777/a.png", "192.168.1.1");
blocked("http://2852039166/a.png", "169.254.169.254");

// ---------- IPv6 ----------
blocked("http://[::1]/a.png", "IPv6 回环");
blocked("http://[::]/a.png");
blocked("http://[fe80::1]/a.png", "链路本地");
blocked("http://[fc00::1]/a.png", "唯一本地");
blocked("http://[fd12:3456::1]/a.png", "唯一本地");
// IPv4 映射：绕过所有纯 IPv6 分支
blocked("http://[::ffff:127.0.0.1]/a.png", "IPv4 映射回环");
blocked("http://[::ffff:169.254.169.254]/a.png", "IPv4 映射元数据");
blocked("http://[::ffff:10.0.0.1]/a.png", "IPv4 映射私网");
blocked("http://[::ffff:7f00:1]/a.png", "十六进制写的 IPv4 映射回环");

// ---------- 畸形输入 ----------
reasonIs("", "empty_url");
reasonIs("   ", "empty_url");
reasonIs("not a url", "invalid_url");
reasonIs("http://", "invalid_url");
reasonIs(`https://example.com/${"a".repeat(3000)}`, "url_too_long");

// ---------- 不变量：放行的一定不是私网 ----------
{
  // 同一个地址的多种写法，判定必须一致
  const loopback = [
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://[::ffff:127.0.0.1]/",
  ];
  const verdicts = loopback.map((u) => checkFetchTarget(u).ok);
  if (verdicts.every((v) => v === false)) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  127.0.0.1 的各种写法判定不一致: ${JSON.stringify(verdicts)}`);
  }
}

console.log(`\nssrf: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
