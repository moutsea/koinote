// 纯函数层校验 normalizeImageBase。平台差异部分见 verify_image_base.py。
import { normalizeImageBase } from "./_image_base_bundle.mjs";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) pass++;
  else { fail++; console.log(`FAIL  ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// 合法：应归一
check("裸域名带 scheme", normalizeImageBase("https://img.example.com"), "https://img.example.com");
check("末尾斜杠去掉", normalizeImageBase("https://img.example.com/"), "https://img.example.com");
check("多个末尾斜杠", normalizeImageBase("https://img.example.com///"), "https://img.example.com");
check("http 也允许", normalizeImageBase("http://img.example.com"), "http://img.example.com");
check("保留子路径", normalizeImageBase("https://img.example.com/assets"), "https://img.example.com/assets");
check("子路径去末尾斜杠", normalizeImageBase("https://img.example.com/assets/"), "https://img.example.com/assets");
check("前后空白", normalizeImageBase("  https://img.example.com  "), "https://img.example.com");
check("带端口", normalizeImageBase("https://img.example.com:8443"), "https://img.example.com:8443");
check("大写 scheme", normalizeImageBase("HTTPS://img.example.com"), "https://img.example.com");

// 非法：应返回 null，由调用方回落到 Worker 代理
check("空串", normalizeImageBase(""), null);
check("纯空白", normalizeImageBase("   "), null);
check("undefined", normalizeImageBase(undefined), null);
check("缺 scheme", normalizeImageBase("img.example.com"), null);
check("缺 scheme 带斜杠", normalizeImageBase("img.example.com/"), null);
check("协议相对", normalizeImageBase("//img.example.com"), null);
check("ftp", normalizeImageBase("ftp://img.example.com"), null);
check("带查询串", normalizeImageBase("https://img.example.com?v=1"), null);
check("带 fragment", normalizeImageBase("https://img.example.com#x"), null);
check("只有 scheme", normalizeImageBase("https://"), null);
check("data URL", normalizeImageBase("data:image/png;base64,AAA"), null);
check("javascript 伪协议", normalizeImageBase("javascript:alert(1)"), null);

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
