import { ChevronDown, Palette } from "lucide-react";
import { useI18n } from "../../i18n";
import { findWechatTheme, groupWechatThemes } from "./wechatThemes";

/**
 * 排版主题选择器。
 *
 * 放在标题行而不是格式工具栏：工具栏那排是行内标记（粗体、斜体、列表），作用于
 * 选区；主题作用于整篇文档，跟分享、导出是一类东西。
 *
 * 为什么是「透明 select 盖在可见层上」而不是直接给 select 上样式：
 * 原生 select 的下拉列表、键盘选择、移动端滚轮选择器都是系统给的，自己实现一遍
 * 不划算；但原生 select 又没法在选中项前面放图标 —— 而这一行里导出、分享都是
 * 「图标 + 文字」，不带图标的话它看起来就是一段灰字，认不出是控件。
 * 于是可见层负责长相（pointer-events-none），select 铺满上层负责交互。
 */
export function ThemePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (themeId: string) => void;
}) {
  const { t } = useI18n();
  // findWechatTheme 对空串会兜回第一套主题，这里要的是「不套主题」的文案
  const label = value ? findWechatTheme(value).name : t.editor.themeNone;

  return (
    <div className="group relative shrink-0">
      {/* 可见层：与导出、分享按钮同一套尺寸与 hover 反馈。
          focus-within 而不是 focus-visible —— 拿到焦点的是上层的 select，
          键盘用户 Tab 过来时要让这一层显形 */}
      <div
        aria-hidden="true"
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-neutral-400 transition group-hover:bg-black/5 group-hover:text-neutral-700 group-focus-within:bg-black/5 group-focus-within:text-neutral-700 dark:group-hover:bg-white/10 dark:group-hover:text-neutral-200 dark:group-focus-within:bg-white/10 dark:group-focus-within:text-neutral-200"
      >
        <Palette className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden max-w-24 truncate sm:inline">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </div>

      {/* 交互层：透明但可点，铺满可见层。原生下拉的定位会锚在它的盒子上 */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={t.editor.wechatThemeLabel}
        aria-label={t.editor.wechatThemeLabel}
        className="absolute inset-0 h-full w-full cursor-pointer rounded-lg opacity-0 [color-scheme:light] dark:[color-scheme:dark]"
      >
        {/* 不套主题：整天盯着强风格的主题写稿不见得舒服，留个退出口 */}
        <option value="">{t.editor.themeNone}</option>
        {groupWechatThemes().map(({ group, themes }) => (
          <optgroup key={group} label={group}>
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
