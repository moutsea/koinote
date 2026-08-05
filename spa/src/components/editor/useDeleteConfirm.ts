import { interpolate, useI18n } from "../../i18n";

/**
 * 删除前的确认对话框。
 *
 * 单独成文件而非放在 DocumentList.tsx 里：同一个模块既导出组件又导出 hook
 * 会让 Vite 的 Fast Refresh 失效，每次改动都触发整页重载。
 */
export function useDeleteConfirm() {
  const { t } = useI18n();
  return (title: string) =>
    window.confirm(interpolate(t.editor.deleteConfirm, { title }));
}
