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
const markdownEditor = readFileSync(
  new URL("../spa/src/components/editor/MarkdownEditor.tsx", import.meta.url),
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
const bareMarkdownEditor = markdownEditor.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

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
  "桌面登出可一次落库所有编辑器内容",
  /const flushAll[\s\S]{0,500}Promise\.all\(\[\.\.\.entries\.current\.keys\(\)\]\.map\(flush\)\)[\s\S]{0,200}every\(Boolean\)/.test(bareSaver),
  "只检查 SQLite 待同步数会漏掉仍在 800ms 防抖窗口内的内容",
);
ok(
  "保存失败返回 false 且保留 dirty",
  /catch\s*\([^)]*\)\s*\{[\s\S]{0,1200}["']failed["'][\s\S]{0,500}return false/.test(bareSaver),
  "失败不能被吞成成功",
);
ok(
  "所有保存异常都会保留本地草稿",
  /catch\s*\([^)]*\)\s*\{[\s\S]{0,650}storeConflictDraft\([\s\S]{0,120}current\.pending,[\s\S]{0,120}revisionConflict/.test(bareSaver) &&
    /const storeConflictDraft[\s\S]{0,650}localStorage\.setItem[\s\S]{0,180}JSON\.stringify\(draft\)/.test(bareSaver),
  "数据库或网络失败后刷新页面也不能静默丢掉本地内容",
);
ok(
  "恢复草稿显式区分冲突与普通保存失败",
  /const draft = \{ \.\.\.snapshot, conflict \}/.test(bareSaver) &&
    /conflicted\s*=\s*parsed\.conflict !== false/.test(bareSaver) &&
    /dirty:\s*recovered/.test(bareSaver) &&
    /conflicted \? ["']conflict["'] : ["']backed-up["']/.test(bareSaver),
  "离线失败恢复后必须进入可重试状态，不能误开冲突合并框",
);
ok(
  "旧版无类别草稿继续按真实冲突恢复",
  /conflicted\s*=\s*parsed\.conflict !== false/.test(bareSaver),
  "旧版本只在 revision 冲突时写草稿，缺少字段不能降级成普通失败",
);
ok(
  "备份写入失败会删除可能过期的旧草稿",
  /catch\s*\{[\s\S]{0,180}lastStoredDrafts\.current\.delete\(docId\)[\s\S]{0,120}clearConflictDraft\(docId\)/.test(bareSaver),
  "QuotaExceededError 后不能在刷新时恢复更旧的正文",
);
ok(
  "相同恢复草稿不会重复同步写入",
  /sameStoredDraft\(previous, draft\)[\s\S]{0,180}localStorage\.getItem\(key\) !== null[\s\S]{0,80}return true[\s\S]{0,300}JSON\.stringify\(draft\)/.test(bareSaver),
  "持续离线编辑时不应为同一快照反复 stringify 和 setItem",
);
ok(
  "内存去重前确认 localStorage 草稿仍存在",
  /sameStoredDraft\(previous, draft\)[\s\S]{0,180}localStorage\.getItem\(key\) !== null/.test(bareSaver),
  "其他标签页登出或浏览器回收存储后必须重新写入草稿",
);
ok(
  "草稿备份结果会决定恢复提示",
  /const backedUp\s*=\s*storeConflictDraft[\s\S]{0,500}backedUp[\s\S]{0,120}["']backed-up["'][\s\S]{0,120}["']failed["']/.test(bareSaver),
  "备份成功与 localStorage 失败必须给用户不同指引",
);
ok(
  "桌面 revision 冲突会进入合并流程",
  /error instanceof ApiError[\s\S]{0,200}error\.code === ["']document_revision_conflict["'][\s\S]{0,250}error instanceof Error[\s\S]{0,200}error\.message === ["']document_revision_conflict["']/.test(bareSaver),
  "桌面离线存储抛出普通 Error，不能误判成一般保存失败",
);
ok(
  "干净保存器会吸收最新 revision",
  /const seed[\s\S]{0,500}!existing\.dirty\s*&&\s*!existing\.inFlight[\s\S]{0,250}existing\.pending\s*=\s*\{\s*\.\.\.snapshot\s*\}/.test(bareSaver),
  "后台同步更新查询后必须刷新保存基线，否则下一次编辑还会使用旧 revision",
);
ok(
  "图床地址映射会同步进保存器基线",
  /const applyImageMapping[\s\S]{0,900}replaceDesktopLocalImageURLs[\s\S]{0,500}entry\.pending\s*=\s*\{\s*\.\.\.entry\.pending,\s*content\s*\}/.test(bareSaver),
  "只替换编辑器节点会让同步层再次把整篇文档当成远端更新并重建编辑器",
);
ok(
  "脏草稿不会被 seed 覆盖",
  /if\s*\(existing\)[\s\S]{0,350}if\s*\(!existing\.dirty\s*&&\s*!existing\.inFlight\)[\s\S]{0,350}return/.test(bareSaver),
  "查询刷新不能覆盖尚未落库的用户编辑",
);
ok(
  "备份提示可以直接重试保存",
  /const retryableSave\s*=\s*status === ["']backed-up["']\s*\|\|\s*status === ["']failed["']/.test(bareMarkdownEditor) &&
    /retryableSave\s*\?[\s\S]{0,500}<button[\s\S]{0,250}onClick=\{onFlush\}/.test(bareMarkdownEditor),
  "用户不应再去其他位置寻找重试入口",
);
ok(
  "保存失败提示同时说明备份结果",
  /`\$\{t\.editor\.saveFailed\} · \$\{t\.editor\.saveFailedBackedUp\}`/.test(bareMarkdownEditor) &&
    /`\$\{t\.editor\.saveFailed\} · \$\{t\.editor\.saveBackupFailed\}`/.test(bareMarkdownEditor),
  "只有“草稿已备份”会掩盖真正的保存失败",
);
ok(
  "长语言的保存失败提示不会挤掉编辑器操作",
  /max-w-\[16rem\][^"']*truncate[^"']*text-xs/.test(bareMarkdownEditor),
  "法语等长文案必须限制宽度并允许截断",
);
ok(
  "revision 冲突会自动打开合并界面",
  /status !== ["']conflict["'][\s\S]{0,180}conflictPromptedRef\.current = false[\s\S]{0,220}conflictPromptedRef\.current = true[\s\S]{0,100}setConflictOpen\(true\)/.test(bareLiveEditor),
  "只显示红色状态文字会让用户不知道下一步该做什么",
);
ok(
  "采用远端版本会清除冲突草稿",
  /const acceptRemote[\s\S]{0,1000}clearStoredDraft\(docId\)/.test(bareSaver),
  "用户解决冲突后不应在下次刷新重新进入冲突状态",
);
ok(
  "登出会清除所有冲突草稿",
  /const clearClientSession[\s\S]{0,240}clearAllConflictDrafts\(\)/.test(auth) &&
    /if \(isDesktopRuntime\(\)\)[\s\S]{0,300}await apiLogout\(\)[\s\S]{0,300}finally[\s\S]{0,180}clearClientSession\(\)/.test(auth) &&
    /await apiLogout\(\);[\s\S]{0,100}clearClientSession\(\)/.test(auth) &&
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
