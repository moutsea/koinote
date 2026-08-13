// 配额链路的三处常量必须对齐。
//
// 这条链路跨三个代码库：Go 后端判超额、Worker 转成错误码、SPA 认那个码弹窗。
// 三处各写一份字面量，任何一处改了名字，表现是「上传静默失败，弹窗永远不出现」——
// 没有任何编译错误，也没有运行时报错，只有用户觉得"点了没反应"。
//
// 所以这里直接读三边的源码比对。读源码做断言不优雅，但跨语言的常量对齐没有别的办法。
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
  }
}

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const backend = read("backend/internal/server/image_quota.go");
const worker = read("worker/images.ts");
const api = read("spa/src/api.ts");
const gc = read("backend/internal/server/image_gc.go");
const migration = read("backend/migrations/0008_image_quota.sql");

// ---------- 错误码一致 ----------
//
// 两个码：图片上传超额由 Worker 回 image_quota_exceeded，文档保存超额由后端回
// storage_quota_exceeded。两者都要触发同一个弹窗。
const CODE = "image_quota_exceeded";
ok(`后端用 ${CODE}`, backend.includes(`"${CODE}"`), "backend/image_quota.go 里找不到");
ok(`Worker 用 ${CODE}`, worker.includes(`"${CODE}"`), "worker/images.ts 里找不到");
ok(`SPA 用 ${CODE}`, api.includes(`"${CODE}"`), "spa/src/api.ts 里找不到");

const TEMPORARY_CODE = "temporary_image_quota_exceeded";
ok(
  `后端用 ${TEMPORARY_CODE}`,
  backend.includes(`"${TEMPORARY_CODE}"`),
  "backend/image_quota.go 里找不到",
);
ok(
  `Worker 透传 ${TEMPORARY_CODE}`,
  worker.includes(`"${TEMPORARY_CODE}"`),
  "worker/images.ts 里找不到",
);
ok(
  `SPA 识别 ${TEMPORARY_CODE}`,
  api.includes(`"${TEMPORARY_CODE}"`),
  "spa/src/api.ts 里找不到",
);
ok(
  "临时配额不触发主配额弹窗",
  !/QUOTA_CODES\s*=\s*new Set<string>\(\[[^\]]*TEMPORARY_IMAGE_QUOTA_CODE/.test(api),
  "临时导出配额应由公众号导出提示处理",
);
const wechatMath = read("spa/src/components/editor/wechatMath.ts");
const wechatDialog = read("spa/src/components/editor/WechatDialog.tsx");
ok(
  "公式转换单独统计临时配额失败",
  wechatMath.includes("temporaryQuotaFailed") &&
    wechatMath.includes("TEMPORARY_IMAGE_QUOTA_CODE"),
  "spa/src/components/editor/wechatMath.ts",
);
ok(
  "公众号导出显示临时配额专属提示",
  wechatDialog.includes("wechatMathTemporaryQuotaExceeded"),
  "spa/src/components/editor/WechatDialog.tsx",
);

const DOC_CODE = "storage_quota_exceeded";
const documentsGo = read("backend/internal/server/documents.go");
const documentService = read("backend/internal/server/document_service.go");
ok(`后端文档路径用 ${DOC_CODE}`, documentsGo.includes(`"${DOC_CODE}"`), "documents.go");
ok(`SPA 认 ${DOC_CODE}`, api.includes(`"${DOC_CODE}"`), "spa/src/api.ts");

// 两个码都要能触发弹窗。只认一个的表现是"文档存不下时静默失败"
ok(
  "SPA 把两个码都算作配额错误",
  /QUOTA_CODES\s*=\s*new Set<string>\(\[\s*IMAGE_QUOTA_CODE,\s*STORAGE_QUOTA_CODE/.test(api),
  "spa/src/api.ts 里 QUOTA_CODES 应含两个码",
);

// 四份译文都要有这两个码，否则超额时用户看到的是英文兜底
for (const locale of ["zh", "en", "fr", "ja"]) {
  const messages = read(`spa/src/i18n/${locale}.ts`);
  ok(`${locale} 有 ${CODE} 的译文`, messages.includes(`${CODE}:`), `spa/src/i18n/${locale}.ts`);
  ok(`${locale} 有 ${DOC_CODE} 的译文`, messages.includes(`${DOC_CODE}:`), `spa/src/i18n/${locale}.ts`);
}

// ---------- 用量口径含文档 ----------
//
// 配额是"云端存储"而不是"图床"。漏掉文档不只是显示不准 ——
// 纯文字文档会完全不受限制，配额可以被无限绕过。
ok(
  "用量查询统计 documents",
  /storageUsageFor[\s\S]{0,900}FROM documents/.test(backend),
  "backend/image_quota.go",
);
// octet_length 而不是 length：后者按字符算，中文正文少算约三分之二
ok(
  "文档字节用 octet_length",
  /storageUsageFor[\s\S]{0,900}octet_length\(content\)/.test(backend),
  "length() 按字符算，中文会大幅少算",
);
// 三处判定都要按总量算
for (const [name, src, anchor] of [
  ["图片记账", backend, "INSERT INTO image_objects"],
  ["新建文档", documentService, "INSERT INTO documents"],
]) {
  const idx = src.indexOf(anchor);
  ok(`找到${name}的语句`, idx >= 0, anchor);
  if (idx >= 0) {
    const stmt = src.slice(idx, src.indexOf("`", idx));
    ok(`${name}的判定含 image_objects`, stmt.includes("image_objects"), "要按文档+图片总量算");
    ok(`${name}的判定含 octet_length`, stmt.includes("octet_length"), "要按文档+图片总量算");
  }
}

const updateStart = documentService.indexOf("func (a *App) updateDocument");
const updateEnd = documentService.indexOf("type documentVersionMode", updateStart);
const updateBody =
  updateStart >= 0 && updateEnd > updateStart
    ? documentService.slice(updateStart, updateEnd)
    : "";
ok("找到更新文档实现", updateBody.length > 0, "document_service.go");
ok(
  "更新文档的扩容判定含 image_objects",
  /if\s+newBytes\s*>\s*oldBytes[\s\S]*?FROM image_objects/.test(updateBody),
  "扩容时要按文档+图片总量算",
);
ok(
  "更新文档的扩容判定含 octet_length",
  /if\s+newBytes\s*>\s*oldBytes[\s\S]*?octet_length\(content\)/.test(updateBody),
  "扩容时要按文档+图片总量算",
);

// 更新文档必须留"缩小则放行"的例外，否则超额用户连删正文都做不到。
//
// 当前实现先算字节数，只在 newBytes > oldBytes 时跑配额查询。缩小直接跳过判定，
// 比把例外塞进一条巨大 UPDATE 的 OR 分支更容易审计。
ok(
  "更新文档允许缩小",
  /oldBytes\s*:=\s*len\(previous\.Doc\.Title\)\s*\+\s*len\(previous\.Doc\.Content\)/.test(
    updateBody,
  ) &&
    /newBytes\s*:=\s*len\(params\.Title\)\s*\+\s*len\(params\.Content\)/.test(
      updateBody,
    ) &&
    /if\s+newBytes\s*>\s*oldBytes\s*\{/.test(updateBody),
  "缺少例外会让超额用户被锁死，没有自救途径",
);

// SPA 要用后端给的分项。写死成只显示总数就失去了"该删什么"的信息
const storageCardSrc = read("spa/src/components/StorageCard.tsx");
for (const field of ["documentBytes", "imageBytes"]) {
  ok(`StorageCard 用了 ${field}`, storageCardSrc.includes(field), "spa/src/components/StorageCard.tsx");
  ok(`api.ts 声明了 ${field}`, api.includes(field), "spa/src/api.ts");
}

// ---------- 路由路径两处一致 ----------
//
// Worker 报账打的路径必须与后端注册的一致
const RECORD_PATH = "/api/images/record";
ok(
  `Worker 报账打 ${RECORD_PATH}`,
  worker.includes(`"${RECORD_PATH}"`),
  "worker/images.ts",
);
const routes = read("backend/internal/server/server.go");
ok(
  `后端注册了 POST ${RECORD_PATH}`,
  routes.includes(`POST ${RECORD_PATH}`),
  "backend/internal/server/server.go",
);

const USAGE_PATH = "/api/storage/usage";
ok(`SPA 查 ${USAGE_PATH}`, api.includes(`"${USAGE_PATH}"`), "spa/src/api.ts");
ok(
  `后端注册了 GET ${USAGE_PATH}`,
  routes.includes(`GET ${USAGE_PATH}`),
  "backend/internal/server/server.go",
);

// 用量端点不能挂在 /api/images/ 下：Worker 对那个前缀有专门分派，
// 加同前缀的路由要改两处，容易漏
ok(
  "用量端点不在 /api/images/ 下",
  !USAGE_PATH.startsWith("/api/images/"),
  USAGE_PATH,
);

// ---------- 报账头与后端认的头一致 ----------
const session = read("backend/internal/server/session.go");
for (const header of ["X-Koinote-Internal-Token", "X-Auth-User-Id"]) {
  ok(`Worker 发 ${header}`, worker.includes(header), "worker/images.ts");
  ok(`后端认 ${header}`, session.includes(header), "backend/internal/server/session.go");
}

// ---------- 配额上限来自环境变量 ----------
//
// 配额是运营旋钮，改它不该要重新编译。真值在 IMAGE_QUOTA_MB，后端读进 Config。
const configGo = read("backend/internal/config/config.go");
ok(
  "config 读 IMAGE_QUOTA_MB",
  configGo.includes("IMAGE_QUOTA_MB"),
  "backend/internal/config/config.go",
);
ok(
  "config 定义了 DefaultImageQuotaMB",
  /DefaultImageQuotaMB\s+int64\s*=\s*500/.test(configGo),
  "backend/internal/config/config.go",
);
// 后端各处必须走 imageQuota()，不能再有写死的常量 —— 那会让环境变量形同虚设
ok(
  "后端通过 imageQuota() 取配额",
  backend.includes("func (a *App) imageQuota()"),
  "backend/image_quota.go",
);
ok(
  "后端不再写死 500 MiB 的常量",
  !/const\s+ImageQuotaBytes/.test(backend),
  "配额应当来自 config，不是代码常量",
);
// 解析失败必须回落到默认值而不是 0：0 的后果是所有人都传不了图
ok(
  "解析失败回落到默认值",
  configGo.includes("DefaultImageQuotaMB * mib"),
  "backend/internal/config/config.go",
);

// .env.example 要有这一项，否则自部署的人不知道它可配
const envExample = read(".env.example");
ok("`.env.example` 里有 IMAGE_QUOTA_MB", envExample.includes("IMAGE_QUOTA_MB="), ".env.example");
// compose 要透传，否则容器部署改了 .env 也不生效
const compose = read("docker-compose.yml");
ok(
  "docker-compose 透传 IMAGE_QUOTA_MB",
  compose.includes("IMAGE_QUOTA_MB:"),
  "docker-compose.yml",
);
const storage = read("spa/src/storage.ts");
ok(
  "SPA 的 storage.ts 不写死配额数值",
  !/500\s*\*\s*1024\s*\*\s*1024/.test(storage),
  "配额应当从 /api/storage/usage 取",
);
const storageCard = read("spa/src/components/StorageCard.tsx");
ok(
  "StorageCard 不写死配额数值",
  !/500\s*\*\s*1024\s*\*\s*1024/.test(storageCard),
  "配额应当从接口取",
);

// ---------- 账本与回收的顺序 ----------
//
// forgetImageObjects 必须在 R2 删除成功之后调用。反过来的话中间失败会让那些对象
// 永远不再计入配额，而它们还占着存储。
{
  const deleteIdx = gc.indexOf("deleteImagesViaWorker(ctx, keys)");
  const forgetIdx = gc.indexOf("forgetImageObjects(ctx, keys)");
  ok("回收里调了 deleteImagesViaWorker", deleteIdx >= 0);
  ok("回收里调了 forgetImageObjects", forgetIdx >= 0);
  ok(
    "先删 R2 再减账本",
    deleteIdx >= 0 && forgetIdx > deleteIdx,
    `delete@${deleteIdx} forget@${forgetIdx}`,
  );
}

// ---------- 迁移 ----------
ok("迁移建了 image_objects 表", migration.includes("CREATE TABLE IF NOT EXISTS image_objects"));
// bytes 不能为负，否则一行坏数据能把用量算成负的、让配额失效
ok("bytes 有非负约束", /CHECK\s*\(bytes\s*>=\s*0\)/.test(migration));
// 用户删号时账本要跟着清
ok("user_id 是 CASCADE", /REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE/.test(migration));
// 按用户求和是最热的查询
ok("有 user_id 索引", migration.includes("image_objects_user_idx"));

// ---------- 记账语句是单条 ----------
//
// 与 Go 侧的 TestRecordImageObjectUsesSingleStatement 重复，但这里能一起跑，
// 而 Go 测试要单独 go test。判断与插入必须在同一句，否则并发上传会突破配额
{
  const idx = backend.indexOf("INSERT INTO image_objects");
  ok("找到记账语句", idx >= 0);
  if (idx >= 0) {
    const stmt = backend.slice(idx, backend.indexOf("`", idx));
    for (const want of ["SELECT", "WHERE", "SUM(bytes)", "ON CONFLICT"]) {
      ok(`记账语句含 ${want}`, stmt.includes(want), "判断与插入必须在同一句 SQL 里");
    }
  }
}

// ---------- 超额时要回滚删除 ----------
//
// Worker 写完 R2 才报账，所以超额路径必须把刚写的对象删掉，否则留下不计入账本的孤儿
{
  const quotaIdx = worker.indexOf('recorded.outcome === "quota"');
  ok("Worker 处理了 quota 分支", quotaIdx >= 0);
  if (quotaIdx >= 0) {
    const branch = worker.slice(quotaIdx, quotaIdx + 600);
    ok("超额时删掉刚写的对象", branch.includes("IMAGES.delete(key)"), branch.slice(0, 200));
  }
}

console.log(`\nquota wiring: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
