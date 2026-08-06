import { ChevronDown } from "lucide-react";
import { useI18n } from "../../i18n";
import { groupWechatThemes } from "./wechatThemes";

/**
 * 排版主题选择器。
 *
 * 放在标题行而不是格式工具栏：工具栏那排是行内标记（粗体、斜体、列表），作用于
 * 选区；主题作用于整篇文档，跟分享、导出是一类东西。
 *
 * color-scheme 要跟着应用的深色模式走 —— 下拉列表和控件文字由系统绘制，而这里
 * 的深色是 .dark class 手动切的，跟系统偏好无关；不声明的话「系统亮色 + 应用
 * 深色」会得到深底配深字。
 */
export function ThemePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (themeId: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="relative shrink-0">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={t.editor.wechatThemeLabel}
        aria-label={t.editor.wechatThemeLabel}
        className="h-7 w-[7.5rem] appearance-none rounded-lg bg-transparent pl-2 pr-6 text-xs font-medium text-neutral-500 outline-none transition [color-scheme:light] hover:bg-black/5 focus:bg-black/5 dark:text-neutral-400 dark:[color-scheme:dark] dark:hover:bg-white/10 dark:focus:bg-white/10"
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
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400"
      />
    </div>
  );
}
