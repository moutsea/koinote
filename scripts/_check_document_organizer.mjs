import {
  ORGANIZER_BUCKET_LIMIT,
  buildDocumentOrganizationPlan,
  countDocumentOrganizationMoves,
  documentOrganizerFolderKey,
} from "./_document_organizer_bundle.mjs";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;

function ok(label, condition, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` —— ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  ok(label, got === want, `got ${got}, want ${want}`);
}

const labels = {
  unknownDate: "Unknown",
  weekOfMonth: "Week {n}",
  activityRecent7: "Recent 7",
  activityRecent30: "Recent 30",
  activityRecent90: "Recent 90",
  activityInactive: "Inactive",
  activityArchive: "Archive",
};
const now = new Date("2026-08-18T12:00:00");
const document = (docId, createdAt, updatedAt = createdAt, folderId = null) => ({
  docId,
  title: docId,
  folderId,
  revision: 1,
  createdAt,
  updatedAt,
});
const folder = (folderId, parentFolderId = null, organizerKind = null) => ({
  folderId,
  name: folderId,
  parentFolderId,
  organizerKind,
});

eq("单个目录最多 20 篇", ORGANIZER_BUCKET_LIMIT, 20);
eq(
  "自动目录位置键区分父级、策略和名称",
  documentOrganizerFolderKey("parent", "activity", "Recent 7"),
  JSON.stringify(["parent", "activity", "Recent 7"]),
);

{
  const plan = buildDocumentOrganizationPlan(
    [
      document("root", "2026-08-01T12:00:00"),
      document("manual", "2026-08-01T12:00:00", undefined, "manual-folder"),
      document("auto", "2026-08-01T12:00:00", undefined, "auto-child"),
      document("manual-child", "2026-08-01T12:00:00", undefined, "manual-child-folder"),
      document("auto-under-manual", "2026-08-01T12:00:00", undefined, "nested-auto"),
    ],
    [
      folder("manual-folder"),
      folder("auto-root", null, "activity"),
      folder("auto-child", "auto-root", "activity"),
      folder("manual-child-folder", "auto-root"),
      folder("nested-auto", "manual-folder", "smart"),
    ],
    "smart",
    "en",
    labels,
    now,
  );
  eq(
    "根目录与旧自动目录会重新参与整理",
    plan.assignments.map((item) => item.docId),
    ["root", "auto"],
  );
  eq("手动目录及其子树始终受保护", plan.documentCount, 2);
  eq("自动目录位于手动目录下时仍受保护", plan.assignments.some((item) => item.docId === "auto-under-manual"), false);
  eq("不额外创建策略容器", plan.folderCount, 1);
}

{
  const changedLater = document(
    "changed-later",
    "2026-06-10T12:00:00",
    "2026-08-17T12:00:00",
  );
  const smart = buildDocumentOrganizationPlan(
    [changedLater],
    [],
    "smart",
    "en",
    labels,
    now,
  );
  const activity = buildDocumentOrganizationPlan(
    [changedLater],
    [],
    "activity",
    "en",
    labels,
    now,
  );
  eq("智能整理优先使用创建时间", smart.groups[0].path, ["June 2026"]);
  eq("活跃度整理优先使用修改时间", activity.groups[0].path, ["Recent 7"]);
}

{
  const docs = Array.from({ length: ORGANIZER_BUCKET_LIMIT }, (_, index) =>
    document(`month-${index}`, `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00`),
  );
  const plan = buildDocumentOrganizationPlan(docs, [], "smart", "en", labels, now);
  eq("20 篇保持按月整理", plan.groups.map((group) => group.path), [["August 2026"]]);
  eq("按月整理只创建月份目录", plan.folderCount, 1);
}

{
  const docs = Array.from({ length: ORGANIZER_BUCKET_LIMIT + 1 }, (_, index) =>
    document(`week-${index}`, `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00`),
  );
  const plan = buildDocumentOrganizationPlan(docs, [], "smart", "en", labels, now);
  ok(
    "超过 20 篇自动拆到周",
    plan.groups.every((group) => group.path.length === 2 && group.path[1].startsWith("Week ")),
  );
  eq("21 天产生三周目录", plan.groups.length, 3);
  eq("文件夹数量只包含月份和三周", plan.folderCount, 4);
}

{
  const docs = Array.from({ length: ORGANIZER_BUCKET_LIMIT + 1 }, (_, index) =>
    document(`day-${index}`, "2026-08-04T12:00:00"),
  );
  const plan = buildDocumentOrganizationPlan(docs, [], "smart", "en", labels, now);
  ok("单周仍过多时拆到日期", plan.groups.every((group) => group.path.length === 3));
}

{
  const atAge = (days) => {
    const value = new Date(now);
    value.setDate(value.getDate() - days);
    return value.toISOString();
  };
  const plan = buildDocumentOrganizationPlan(
    [
      document("active", atAge(3)),
      document("month", atAge(20)),
      document("quarter", atAge(60)),
      document("inactive", atAge(180)),
      document("archive", atAge(500)),
    ],
    [],
    "activity",
    "en",
    labels,
    now,
  );
  eq(
    "活跃度边界按最后修改时间分层",
    plan.groups.map((group) => group.path[0]),
    ["Recent 7", "Recent 30", "Recent 90", "Inactive", "Archive"],
  );
}

{
  const duplicateLocationFolders = [
    { ...folder("a-canonical", null, "activity"), name: "Recent 7" },
    { ...folder("z-duplicate", null, "activity"), name: "Recent 7" },
  ];
  const plan = buildDocumentOrganizationPlan(
    [document("doc", "2026-08-17T12:00:00")],
    duplicateLocationFolders,
    "activity",
    "en",
    labels,
    now,
  );
  eq(
    "重复自动目录预览使用稳定的规范目录",
    countDocumentOrganizationMoves(
      plan,
      [document("doc", "2026-08-17T12:00:00", undefined, "z-duplicate")],
      duplicateLocationFolders,
    ),
    1,
  );
}

{
  const plan = buildDocumentOrganizationPlan(
    [document("fallback", "2026-07-02T12:00:00", "not-a-date")],
    [],
    "activity",
    "en",
    labels,
    now,
  );
  eq("修改日期无效时回退创建日期", plan.groups[0].path, ["Recent 90"]);
}

{
  const plan = buildDocumentOrganizationPlan(
    [document("unknown", null, null)],
    [],
    "smart",
    "en",
    labels,
    now,
  );
  eq("缺少日期时进入明确兜底目录", plan.groups[0].path, ["Unknown"]);
}

{
  const plan = buildDocumentOrganizationPlan(
    [
      document("already-there", "2026-08-01T12:00:00", undefined, "august"),
      document("needs-moving", "2026-08-02T12:00:00"),
    ],
    [
      {
        ...folder("august", null, "smart"),
        name: "August 2026",
      },
    ],
    "smart",
    "en",
    labels,
    now,
  );
  eq(
    "确认数量只包含真正需要移动的文档",
    countDocumentOrganizationMoves(
      plan,
      [
        document("already-there", "2026-08-01T12:00:00", undefined, "august"),
        document("needs-moving", "2026-08-02T12:00:00"),
      ],
      [{ ...folder("august", null, "smart"), name: "August 2026" }],
    ),
    1,
  );
}

{
  const executor = readFileSync(
    new URL("../spa/src/documentOrganizer.ts", import.meta.url),
    "utf8",
  );
  const sidebar = readFileSync(
    new URL("../spa/src/components/editor/DocumentList.tsx", import.meta.url),
    "utf8",
  );
  ok(
    "执行前重新确认文档仍在可整理范围",
    /listDocuments\(\)/.test(executor) &&
      /listFolders\(\)/.test(executor) &&
      /isDocumentInOrganizerScope\(document, folders\)/.test(executor),
  );
  ok(
    "自动目录持久标记并直接建在根目录",
    /organizerKind: plan\.strategy/.test(executor) &&
      /let parentFolderId: string \| null = null/.test(executor) &&
      !/containerName/.test(executor),
  );
  ok(
    "旧自动目录只在确认为空时清理",
    /deleteEmptyOrganizerFolder/.test(executor),
  );
  ok(
    "整理结果只统计真正移动的文档",
    /if \(document\?\.folderId !== folderId\) \{\s*await moveDocument\(assignment\.docId, folderId\);\s*moved \+= 1;\s*\}/.test(executor),
  );
  ok(
    "整理操作串行化并跨标签互斥",
    /organizationQueue/.test(executor) &&
      /koinote:document-organization/.test(executor) &&
      /lockManager\.request\(ORGANIZATION_LOCK_NAME, operation\)/.test(executor),
  );
  ok(
    "整理入口固定在侧栏底部滚动区之后",
    sidebar.indexOf("ref={organizerMenuRef}") >
      sidebar.indexOf("rootAcceptsDrop"),
  );
  ok(
    "整理交互是向上菜单内二次确认而不是弹窗预览",
    /role="menu"/.test(sidebar) &&
      /bottom-full/.test(sidebar) &&
      /setPendingOrganizerStrategy\("smart"\)/.test(sidebar) &&
      /setPendingOrganizerStrategy\("activity"\)/.test(sidebar) &&
      /onConfirm=\{\(\) => void organize\(pendingOrganizerStrategy\)\}/.test(sidebar) &&
      !/DocumentOrganizerDialog/.test(sidebar),
  );
}

console.log(`文档整理：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
