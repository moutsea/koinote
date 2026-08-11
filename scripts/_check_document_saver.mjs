import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;

function ok(label, condition, detail) {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` —— ${detail}` : ""}`);
  }
}

const saver = readFileSync(
  new URL("../spa/src/components/editor/useDocumentSaver.ts", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../spa/src/pages/EditorPage.tsx", import.meta.url),
  "utf8",
);
const bareSaver = saver.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const barePage = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

ok(
  "保存层跟踪当前 Promise",
  /inFlight:\s*Promise<boolean>\s*\|\s*null/.test(bareSaver),
  "boolean 只能说明正在保存，不能让 flush 等待它",
);
ok(
  "已有保存时 flush 返回同一 Promise",
  /if\s*\(entry\.inFlight\)[\s\S]{0,120}return entry\.inFlight/.test(bareSaver),
  "立即 return 会让删除流程误以为最新正文已经落库",
);
ok(
  "保存链会处理请求期间的新快照",
  /for\s*\(;;\)[\s\S]{0,1600}changedDuringFlight[\s\S]{0,200}continue/.test(bareSaver),
  "只等待第一趟请求仍会漏掉 in-flight 期间的新改动",
);
ok(
  "flush 把保存结果返回调用方",
  /const flush[\s\S]{0,500}return doSave\(docId\)/.test(bareSaver),
  "删除流程必须能区分保存成功和失败",
);
ok(
  "保存失败返回 false 且保留 dirty",
  /catch\s*\{[\s\S]{0,260}setStatus\(docId,\s*"failed"\)[\s\S]{0,100}return false/.test(bareSaver),
  "失败不能被吞成成功",
);

const deleteBody =
  /const handleDelete = useCallback\([\s\S]*?\n\s*\},\n\s*\[confirmDelete/.exec(barePage)?.[0] ?? "";
ok("找到删除流程", deleteBody.length > 0, "EditorPage 的结构变了，需更新测试");
ok(
  "删除前等待 flush 结果",
  /const saved = await saver\.flush\(docId\)/.test(deleteBody),
  "必须先让后端看到最新正文，删除时才能把刚上传的图排进 GC",
);
ok(
  "保存失败会中止删除",
  /if\s*\(!saved\)\s*\{[\s\S]{0,180}return;/.test(deleteBody) &&
    deleteBody.indexOf("if (!saved)") < deleteBody.indexOf("remove.mutate"),
  "继续删除会让仅存在于待存正文里的图片永久占配额",
);

console.log(`文档保存屏障：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
