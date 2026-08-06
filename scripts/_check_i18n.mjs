// 四份手写译文的一致性。
//
// TS 的 Messages 接口已经保证「key 不缺」，所以这里不重复那件事。它管不到的是：
//   - 条款条数四语不一致（漏译一整条，类型完全合法）
//   - body 是空数组或空字符串（渲染出一个只有标题的条款）
//   - 联系邮箱在某一份译文里写错（法律页上的错邮箱等于没有联系方式）
//   - 某个语言把 legal 整份复制成了另一语言（漏译时最常见的偷懒）
import { en } from "./_i18n_bundle.mjs";
import { zh } from "./_i18n_bundle.mjs";
import { fr } from "./_i18n_bundle.mjs";
import { ja } from "./_i18n_bundle.mjs";

const LOCALES = { en, zh, fr, ja };
const LEGAL_KINDS = ["privacy", "terms", "cookies"];
const CONTACT_EMAIL = "cfjwlchangji@gmail.com";

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail === undefined ? "" : ` —— ${JSON.stringify(detail)}`}`);
  }
}

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 得到 ${g}，期望 ${w}`);
  }
}

// ---------- 条款条数四语必须一致 ----------
//
// 以 en 为基准。数目不等说明某个语言漏了一整条 —— 类型检查看不出来，
// 而少一条免责声明在法律页上不是小事。
for (const kind of LEGAL_KINDS) {
  const want = en.legal[kind].sections.length;
  ok(`${kind} 基准条数 > 0`, want > 0, want);
  for (const [name, messages] of Object.entries(LOCALES)) {
    eq(`${name}.legal.${kind} 条数`, messages.legal[kind].sections.length, want);
  }
}

// ---------- 每条都要有标题和正文 ----------
for (const [name, messages] of Object.entries(LOCALES)) {
  for (const kind of LEGAL_KINDS) {
    const doc = messages.legal[kind];

    ok(`${name}.${kind}.title 非空`, doc.title.trim().length > 0, doc.title);
    ok(`${name}.${kind}.summary 非空`, doc.summary.trim().length > 0, doc.summary);

    doc.sections.forEach((section, i) => {
      const at = `${name}.${kind}[${i}]`;
      ok(`${at}.title 非空`, section.title.trim().length > 0, section.title);
      ok(`${at}.body 非空数组`, Array.isArray(section.body) && section.body.length > 0, section.body);
      section.body.forEach((paragraph, j) => {
        ok(`${at}.body[${j}] 非空`, paragraph.trim().length > 0, paragraph);
      });
      // items 可选，但给了就不能是空数组或空串
      if (section.items !== undefined) {
        ok(`${at}.items 非空数组`, section.items.length > 0, section.items);
        section.items.forEach((item, j) => {
          ok(`${at}.items[${j}] 非空`, item.trim().length > 0, item);
        });
      }
    });
  }
}

// ---------- 三份文档的标题不能互相重复 ----------
//
// 复制粘贴改标题时漏改一处，页面上会出现两个「隐私政策」，而路由是对的、类型也是对的。
for (const [name, messages] of Object.entries(LOCALES)) {
  const titles = LEGAL_KINDS.map((k) => messages.legal[k].title);
  eq(`${name} 三份条款标题互不相同`, new Set(titles).size, titles.length);
}

// ---------- 联系邮箱 ----------
//
// 每份文档都必须至少出现一次联系邮箱，且不能出现别的邮箱地址。
// 末段限定为 \w+，不能是 [\w.]+ —— 后者会把句末的英文句点吃进来，
// 于是 "...gmail.com." 被当成一个不同的地址。中日文没暴露这点，它们用的是「。」
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.\w+/g;
for (const [name, messages] of Object.entries(LOCALES)) {
  for (const kind of LEGAL_KINDS) {
    const text = JSON.stringify(messages.legal[kind]);
    const found = [...new Set(text.match(EMAIL_RE) ?? [])];
    ok(`${name}.${kind} 含联系邮箱`, found.includes(CONTACT_EMAIL), found);
    eq(`${name}.${kind} 没有别的邮箱`, found.filter((e) => e !== CONTACT_EMAIL), []);
  }
}

// ---------- 漏译检测 ----------
//
// 四语的 legal 整块不能有两份完全相同：那意味着某个语言直接复制了另一个语言。
// 中文与日文都含大量汉字，但整块 JSON 完全相等只可能是复制。
const legalBlobs = Object.entries(LOCALES).map(([name, m]) => [name, JSON.stringify(m.legal)]);
for (let i = 0; i < legalBlobs.length; i += 1) {
  for (let j = i + 1; j < legalBlobs.length; j += 1) {
    const [a, blobA] = legalBlobs[i];
    const [b, blobB] = legalBlobs[j];
    ok(`${a}.legal ≠ ${b}.legal`, blobA !== blobB, `${a} 与 ${b} 完全相同`);
  }
}

// 页脚同理。tagline 是各语言都要自己写的一段话
const taglines = Object.entries(LOCALES).map(([name, m]) => [name, m.footer.tagline]);
for (let i = 0; i < taglines.length; i += 1) {
  for (let j = i + 1; j < taglines.length; j += 1) {
    const [a, tA] = taglines[i];
    const [b, tB] = taglines[j];
    ok(`${a} 与 ${b} 的 tagline 不同`, tA !== tB, `${a} 与 ${b} 相同`);
  }
}

// ---------- 页脚必填项 ----------
//
// 页脚是全站唯一的条款入口，这几个 key 空了就等于那三页没人能点到。
const FOOTER_REQUIRED = [
  "tagline",
  "brandCn",
  "product",
  "legal",
  "privacy",
  "terms",
  "cookies",
  "copyright",
  "allRightsReserved",
];
for (const [name, messages] of Object.entries(LOCALES)) {
  for (const key of FOOTER_REQUIRED) {
    ok(
      `${name}.footer.${key} 非空`,
      typeof messages.footer[key] === "string" && messages.footer[key].trim().length > 0,
      messages.footer[key],
    );
  }
  // 品牌中文名四语共用同一个词：它是名字，不该被翻译
  eq(`${name}.footer.brandCn 是「锦鲤笔记」`, messages.footer.brandCn, "锦鲤笔记");
}

console.log(`\ni18n: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
