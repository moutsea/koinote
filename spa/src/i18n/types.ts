// 支持的语言。默认 en（面向全球），zh/fr/ja 依次。
export const LOCALES = ["en", "zh", "fr", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  zh: "中文",
  fr: "Français",
  ja: "日本語",
};

// 完整文案结构。每个语言文件都必须实现它，TS 保证不漏 key。
export interface Messages {
  nav: {
    editor: string;
    dashboard: string;
    login: string;
    logout: string;
  };
  home: {
    badge: string;
    title: string;
    subtitle: string;
    ctaStart: string;
    ctaRegister: string;
    features: Array<{ title: string; desc: string }>;
  };
  auth: {
    loginTitle: string;
    loginSubtitle: string;
    registerTitle: string;
    registerSubtitle: string;
    username: string;
    usernamePlaceholder: string;
    email: string;
    emailPlaceholder: string;
    identifier: string;
    identifierPlaceholder: string;
    password: string;
    passwordPlaceholderLogin: string;
    passwordPlaceholderRegister: string;
    confirmPassword: string;
    confirmPasswordPlaceholder: string;
    submitLogin: string;
    submitRegister: string;
    processing: string;
    noAccount: string;
    hasAccount: string;
    toRegister: string;
    toLogin: string;
    passwordMismatch: string;
    requestFailed: string;
    orDivider: string;
    continueWithGoogle: string;
    continueWithGitHub: string;
  };
  dashboard: {
    greeting: string; // 用 {name} 占位
    subtitle: string;
    newDoc: string;
    account: string;
    username: string;
    notSet: string;
    joinedAt: string;
    myDocs: string;
    emptyHint: string; // 含「去编辑器」链接文案前后段
    emptyLinkText: string;
    loading: string;
    loginRequired: string;
    loginRequiredHint: string;
    goLogin: string;
  };
  editor: {
    placeholder: string;
    saving: string;
    saved: string;
    saveFailed: string;
    charCount: string; // 用 {n} 占位
    sample: string;
    untitled: string;
    titlePlaceholder: string;
    loginRequired: string;
    loginRequiredHint: string;
    goLogin: string;
    loading: string;
    notFound: string;
    backToList: string;
    // 侧边栏
    documentsPanel: string;
    outlinePanel: string;
    newDocument: string;
    deleteDocument: string;
    deleteConfirm: string; // 用 {title} 占位
    emptyDocuments: string;
    emptyOutline: string;
    collapsePanel: string;
    expandPanel: string;
    resizeDocuments: string;
    resizeOutline: string;
    uploadFailed: string;
    uploadingImages: string; // 用 {n} 占位
    imageClickToEdit: string;
    imageMarkdownLabel: string;
    imageBroken: string;
    // 分享
    share: string;
    shareTitle: string;
    shareAccessLink: string;
    shareAccessLinkHint: string;
    shareTokenRotated: string;
    shareAccessPassword: string;
    shareAccessPasswordHint: string;
    sharePasswordPlaceholder: string;
    shareEnable: string;
    shareUpdate: string;
    shareRevoke: string;
    shareRevokeConfirm: string;
    shareCopyLink: string;
    shareCopied: string;
    shareCopyFailed: string;
    shareNotShared: string;
    shareActive: string;
    shareClose: string;
    // 分享页（公开视图）
    sharedBy: string; // 用 {name} 占位
    sharedNotFound: string;
    sharedPasswordPrompt: string;
    sharedPasswordSubmit: string;
    sharedOpenApp: string;
    // 导出
    exportLabel: string;
    exportMarkdown: string;
    exportHTML: string;
    exportPDF: string;
    exportDOCX: string;
    exportPDFHint: string;
    exportPrint: string;
    exportPrintHint: string;
    wechatExport: string;
    wechatExportHint: string;
    wechatTitle: string;
    wechatSubtitle: string;
    wechatThemeLabel: string;
    themeNone: string;
    tabsLabel: string;
    closeTab: string;
    wechatCopy: string;
    wechatCopied: string;
    wechatWorking: string;
    wechatCodeNote: string;
    wechatMathConverted: string;
    wechatMathFailed: string;
    exportFailed: string;
    exporting: string;
    importedLocalDraft: string;
    // 工具栏
    toolbar: {
      bold: string;
      italic: string;
      strike: string;
      code: string;
      heading1: string;
      heading2: string;
      heading3: string;
      bulletList: string;
      orderedList: string;
      taskList: string;
      blockquote: string;
      codeBlock: string;
      link: string;
      linkPrompt: string;
      hint: string;
    };
  };
  common: {
    theme: string;
    language: string;
  };
  // 后端错误码 → 文案。key 与 Go 后端返回的 code 对齐。
  errors: Record<string, string>;
}
