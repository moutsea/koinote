import { readFileSync } from "node:fs";
import { isSafeImageKey } from "./_image_key_worker_bundle.mjs";
import {
  imageFetchURL,
  sameOriginImageURL,
} from "./_image_key_loading_bundle.mjs";
import { isOwnImage } from "./_image_key_rehost_bundle.mjs";

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

const cases = [
  { name: "8 位 hex", key: "u/a/01234567.png", valid: true },
  { name: "64 位 hex", key: `u/${"a".repeat(128)}/${"b".repeat(64)}.webp`, valid: true },
  { name: "连字符和下划线 owner", key: "u/google-user_42/89abcdef.jpg", valid: true },
  { name: "7 位 hex", key: "u/alice/0123456.png", valid: false },
  { name: "65 位 hex", key: `u/alice/${"a".repeat(65)}.png`, valid: false },
  { name: "大写 hex", key: "u/alice/0123456A.png", valid: false },
  { name: "大写扩展名", key: "u/alice/01234567.PNG", valid: false },
  { name: "不支持的扩展名", key: "u/alice/01234567.svg", valid: false },
  { name: "owner 过长", key: `u/${"a".repeat(129)}/01234567.gif`, valid: false },
  { name: "空 owner", key: "u//01234567.png", valid: false },
  { name: "嵌套 u 路径", key: "u/alice/u/bob/01234567.png", valid: false },
  { name: "双斜杠", key: "u/alice//01234567.png", valid: false },
  { name: "路径穿越", key: "u/alice/../01234567.png", valid: false },
];

for (const testCase of cases) {
  const workerResult = isSafeImageKey(testCase.key);
  const loadingResult = sameOriginImageURL(`https://img.koinote.app/${testCase.key}`);
  const rehostResult = isOwnImage(`/images/${testCase.key}`);

  check(
    `${testCase.name}：Worker key 校验`,
    workerResult === testCase.valid,
    `得到 ${workerResult}，期望 ${testCase.valid}`,
  );
  check(
    `${testCase.name}：同源图片映射`,
    (loadingResult !== null) === testCase.valid,
    `得到 ${JSON.stringify(loadingResult)}`,
  );

  // isOwnImage 按 URL 的最后一个 /u/<owner>/<file> 判断，因为部署者可配置带子路径的
  // 图片公开基址。嵌套 /u/ 因而可以合法表示“公开基址以 /u/alice 结尾、key 属于 bob”，
  // 不是一个可直接交给 R2 的 key；其他 key 形状必须与 Worker/同源映射保持一致。
  const expectedRehost = testCase.name === "嵌套 u 路径" ? true : testCase.valid;
  check(
    `${testCase.name}：粘贴转存判定`,
    rehostResult === expectedRehost,
    `得到 ${rehostResult}，期望 ${expectedRehost}`,
  );
}

const validKey = "u/alice/01234567.png";
check(
  "查询串不属于 R2 key",
  isSafeImageKey(`${validKey}?v=2`) === false,
);
check(
  "CDN URL 查询串不影响同源映射",
  sameOriginImageURL(`https://img.koinote.app/${validKey}?v=2`) ===
    `/images/${validKey}?v=2`,
);
check(
  "图片 URL 查询串不触发重复转存",
  isOwnImage(`/images/${validKey}?v=2`) === true,
);

const reportedURL =
  "https://img.koinote.app/u/google_104742467398561921274/3644918289f68adacc34fcbd8f68c9c7.png";
check(
  "导出读取自有图片时走同源代理",
  imageFetchURL(reportedURL) ===
    "/images/u/google_104742467398561921274/3644918289f68adacc34fcbd8f68c9c7.png",
  imageFetchURL(reportedURL),
);
check(
  "导出读取地址保留下划线且不添加 Markdown 转义",
  !imageFetchURL(reportedURL).includes("\\_") &&
    imageFetchURL(reportedURL).includes("google_104742467398561921274"),
  imageFetchURL(reportedURL),
);
const externalURL = "https://images.example.com/article/cover.png";
check(
  "导出读取外站图片时保持原地址",
  imageFetchURL(externalURL) === externalURL,
  imageFetchURL(externalURL),
);

for (const file of ["exportDocx.ts", "exportPdf.ts"]) {
  const source = readFileSync(
    new URL(`../spa/src/components/editor/${file}`, import.meta.url),
    "utf8",
  );
  check(
    `${file} 通过共享规则读取图片`,
    /fetchAppResource\(imageFetchURL\(src\)/.test(source),
    "自有 CDN 地址不能直接交给 fetchAppResource",
  );
}

console.log(`图片 key 正则：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
