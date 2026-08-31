// _check_i18n.mjs 的打包入口。
//
// 不直接打 spa/src/i18n/index.tsx：那个文件带 React 和 JSX，为了断言几段文案把
// React 拖进 bundle 没必要。四个语言文件本身只导出纯对象。
export { en } from "../spa/src/i18n/en";
export { zh } from "../spa/src/i18n/zh";
export { fr } from "../spa/src/i18n/fr";
export { ja } from "../spa/src/i18n/ja";
export {
  WECHAT_THEMES,
  WECHAT_THEME_GROUPS,
} from "../spa/src/components/editor/wechatThemes";
