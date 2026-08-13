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
const liveEditor = readFileSync(
  new URL("../spa/src/components/editor/LiveEditor.tsx", import.meta.url),
  "utf8",
);
const auth = readFileSync(
  new URL("../spa/src/auth.ts", import.meta.url),
  "utf8",
);
const conflictDrafts = readFileSync(
  new URL("../spa/src/conflictDrafts.ts", import.meta.url),
  "utf8",
);
const bareSaver = saver.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const barePage = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const bareLiveEditor = liveEditor.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

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
  /for\s*\(;;\)[\s\S]{0,2600}changedDuringFlight[\s\S]{0,300}continue/.test(bareSaver),
  "只等待第一趟请求仍会漏掉 in-flight 期间的新改动",
);
ok(
  "flush 把保存结果返回调用方",
  /const flush[\s\S]{0,500}return doSave\(docId\)/.test(bareSaver),
  "删除流程必须能区分保存成功和失败",
);
ok(
  "保存失败返回 false 且保留 dirty",
  /catch\s*\([^)]*\)\s*\{[\s\S]{0,900}["']failed["'][\s\S]{0,500}return false/.test(bareSaver),
  "失败不能被吞成成功",
);
ok(
  "revision 冲突会保留本地草稿",
  /document_revision_conflict[\s\S]{0,700}storeConflictDraft\(docId,\s*current\.pending\)/.test(bareSaver) &&
    /function storeConflictDraft[\s\S]{0,350}localStorage\.setItem[\s\S]{0,180}JSON\.stringify\(snapshot\)/.test(bareSaver),
  "刷新页面后不能静默丢掉发生冲突的本地内容",
);
ok(
  "采用远端版本会清除冲突草稿",
  /const acceptRemote[\s\S]{0,1000}clearConflictDraft\(docId\)/.test(bareSaver),
  "用户解决冲突后不应在下次刷新重新进入冲突状态",
);
ok(
  "登出会清除所有冲突草稿",
  /await apiLogout\(\)[\s\S]{0,120}clearAllConflictDrafts\(\)/.test(auth) &&
    /CONFLICT_DRAFT_PREFIX\s*=\s*["']koinote:conflict-draft:["']/.test(conflictDrafts) &&
    /localStorage\.removeItem\(key\)/.test(conflictDrafts),
  "完整正文不应在账号退出后继续留在共用设备上",
);
ok(
  "编辑器等待冲突草稿恢复后再挂载",
  /seededDocId\s*===\s*docId/.test(bareLiveEditor) &&
    /saver\.seed[\s\S]{0,400}setSeededDocId\(docId\)/.test(bareLiveEditor),
  "先挂载远端正文会让 MarkdownEditor 错过 effect 中恢复的本地草稿",
);
ok(
  "采用远端或合并稿会同步标题缓存",
  /function acceptDocument[\s\S]{0,500}onTitleChange\?\.\(docId,\s*next\.title\)/.test(bareLiveEditor) &&
    /onOverwrite[\s\S]{0,700}onTitleChange\?\.\(docId,\s*patch\.title\)/.test(bareLiveEditor),
  "正文已切换但标签仍显示旧标题会让用户误判当前文档",
);
ok(
  "免费用户不显示版本历史入口",
  /historyAvailable\s*&&\s*\([\s\S]{0,650}openHistory/.test(bareLiveEditor) &&
    /historyAvailable=\{session\.data\?\.user\?\.membershipTier\s*===\s*["']lifetime["']\}/.test(barePage),
  "版本历史是会员权益，前端入口必须跟随会员状态",
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
