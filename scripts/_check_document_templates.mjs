import { readFileSync } from "node:fs";
import {
  DOCUMENT_TEMPLATE_IDS,
  DOCUMENT_TEMPLATES,
  buildDocumentFromTemplate,
  canUseDocumentTemplate,
} from "./_document_templates_bundle.mjs";

let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  ok(label, got === want, `got ${got}, want ${want}`);
}

const locales = ["en", "zh", "ja", "fr"];
const now = new Date("2026-08-19T12:00:00Z");

eq("模板 ID 不重复", new Set(DOCUMENT_TEMPLATE_IDS).size, 15);
eq("目录与 ID 数量一致", DOCUMENT_TEMPLATES.length, DOCUMENT_TEMPLATE_IDS.length);
eq(
  "免费用户拥有五款基础模板",
  DOCUMENT_TEMPLATES.filter((template) => template.tier === "free").map(
    (template) => template.id,
  ),
  ["meeting-notes", "daily-note", "weekly-review", "todo-list", "table"],
);
eq(
  "会员拥有十款高级模板",
  DOCUMENT_TEMPLATES.filter((template) => template.tier === "lifetime").map(
    (template) => template.id,
  ),
  [
    "daily-report",
    "weekly-report",
    "okr",
    "kpi",
    "article-outline",
    "research-paper",
    "project-readme",
    "product-requirements",
    "decision-record",
    "technical-design",
  ],
);

const addedTemplateStructures = {
  "todo-list": ["- [ ]", "## 等待与委派", "## 今日收尾"],
  table: ["## 字段定义", "| ID | 项目 |", "## 变更记录"],
  "daily-report": ["## 今日完成", "## 关键数据", "## 明日优先事项"],
  "weekly-report": ["## 关键成果", "## 指标与趋势", "## 下周三个优先结果"],
  okr: ["## Objective", "## Key Results", "## 每周 Check-in", "## 周期结束评分"],
  kpi: ["## KPI 定义表", "## 护栏指标", "## 阈值与响应", "## 数据质量检查"],
};

for (const [templateId, markers] of Object.entries(addedTemplateStructures)) {
  const copy = buildDocumentFromTemplate(templateId, "zh", now);
  ok(
    `${templateId} 包含完整业务结构`,
    markers.every((marker) => copy.content.includes(marker)),
  );
}

for (const template of DOCUMENT_TEMPLATES) {
  ok(
    `免费模板 ${template.id} 对免费账号可用`,
    template.tier === "lifetime" || canUseDocumentTemplate(template, "free"),
  );
  ok(
    `会员模板 ${template.id} 只对会员开放`,
    template.tier === "free" ||
      (!canUseDocumentTemplate(template, "free") &&
        canUseDocumentTemplate(template, "lifetime")),
  );
  ok(
    `本地模式不冒充会员 ${template.id}`,
    template.tier === "free" ||
      !canUseDocumentTemplate(template, "lifetime", true),
  );

  for (const locale of locales) {
    const copy = buildDocumentFromTemplate(template.id, locale, now);
    ok(`${template.id}.${locale} 标题非空`, copy.title.trim().length > 0);
    ok(`${template.id}.${locale} 正文有结构`, copy.content.startsWith("# "));
    ok(`${template.id}.${locale} 动态日期已替换`, !copy.title.includes("{date}") && !copy.content.includes("{date}"));
    ok(`${template.id}.${locale} 单篇远低于后端上限`, new TextEncoder().encode(copy.content).length < 32 * 1024);
    const fences = copy.content.match(/```/g)?.length ?? 0;
    ok(`${template.id}.${locale} 代码围栏成对`, fences % 2 === 0, String(fences));
  }
}

const dialog = readFileSync(
  new URL("../spa/src/components/DocumentTemplateDialog.tsx", import.meta.url),
  "utf8",
);
const editor = readFileSync(
  new URL("../spa/src/pages/EditorPage.tsx", import.meta.url),
  "utf8",
);
const desktopHome = readFileSync(
  new URL("../spa/src/pages/DesktopHomePage.tsx", import.meta.url),
  "utf8",
);
const dashboard = readFileSync(
  new URL("../spa/src/pages/DashboardPage.tsx", import.meta.url),
  "utf8",
);
const documents = readFileSync(
  new URL("../spa/src/pages/DocumentsPage.tsx", import.meta.url),
  "utf8",
);
const routes = readFileSync(
  new URL("../spa/src/main.tsx", import.meta.url),
  "utf8",
);

ok(
  "选择器按会员与本地模式统一判权",
  dialog.includes("canUseDocumentTemplate") &&
    dialog.includes("membershipTier") &&
    dialog.includes("localMode"),
);
ok(
  "锁定模板提供升级路径",
  dialog.includes("onUpgrade()") && dialog.includes("upgradeHint"),
);
ok(
  "编辑器创建时再次校验权限",
  editor.includes("documentTemplateById(templateId)") &&
    editor.includes("canUseDocumentTemplate("),
);
ok(
  "编辑器侧栏与标签栏共用模板创建",
  editor.includes("onCreate={handleCreate}") &&
    editor.includes("onCreate={handleTemplateCreate}"),
);
ok(
  "桌面首页离线复用内置模板",
  desktopHome.includes("buildDocumentFromTemplate") &&
    desktopHome.includes("<DocumentTemplateDialog"),
);
ok(
  "账号页与文档页的新建按钮进入模板选择",
  dashboard.includes("search={{ create: true }}") &&
    documents.match(/search=\{\{ create: true \}\}/g)?.length === 2,
);
ok(
  "编辑器 create 查询参数为可选布尔值",
  routes.includes("): { create?: true }") &&
    routes.match(/validateSearch: parseEditorSearch/g)?.length === 2,
);

console.log(`文档模板：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
